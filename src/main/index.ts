/**
 * Electron main entry (Phase 0 runtime loop + P1-A shell/config layer).
 *
 * Wires the RuntimeClient (DSH Process Manager + protocol codec), the
 * Workspace Manager (§30) with its boundary service, and the Settings module
 * to the renderer over IPC. The child command is the desktop profile adapter
 * (scripts/dsh-desktop-profile.mjs) driving the dsh runtime that is installed
 * together with the app (`@deepseek-ai/dsh` npm dependency); DSH_RUNTIME_BIN
 * still overrides it, and the reference stub runtime remains the fallback so
 * the closed loop is verifiable without a real DSH desktop profile.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { BrowserWindow, app, dialog, ipcMain } from 'electron';

import type { ConnectionState, DshDetection, RuntimeStatus } from '../shared/desktop-api';
import type { RuntimeEventFrame } from '../shared/protocol/types';
import type {
  ModelsRefreshResult,
  OperationResult,
  PermissionMode,
  SaveProviderInput
} from '../shared/settings';
import { SettingsStore, redactSecrets } from './settings/settings-store';
import { locateDsh, bundledDshCandidates } from './settings/dsh-locator';
import { refreshModels } from './settings/model-refresh';
import { WorkspaceManager } from './workspace';
import { idForPath } from './workspace/recent-projects';
import type { OpenProjectResult } from '../shared/workspace';
import { DshProcessManager } from './runtime/dsh-process-manager';
import { RuntimeClient } from './runtime/runtime-client';
import { runResponsiveMeasure } from './responsive-measure';
import { RuntimeEventBus } from './runtime/event-bus';
import { RuntimeLogStore } from './runtime/runtime-log';
import { ApprovalService } from './approval/approval-service';
import {
  claimRuntimePidFile,
  defaultTerminate,
  readLinuxCommandLine,
  recoverOrphanRuntime,
  releaseRuntimePidFile
} from './runtime/orphan-recovery';
import type { BusMessage } from './runtime/event-bus';
import type { ApprovalResolution, RuntimeCrashSnapshot } from '../shared/desktop-api';
import type { ApprovalReply } from '../shared/approval-protocol';
import type { ChangesSnapshot } from '../shared/changes';
import type {
  SessionLoadResult,
  SessionMutationResult,
  SessionRecord,
  SessionSummary
} from '../shared/session';
import { isValidSessionId, validateSessionRecord } from '../shared/session';
import { ChangeRecordService } from './changes/change-record-service';
import { buildFileDiff } from './changes/file-diff';
import { SessionStore } from './session/session-store';

const isSmokeMode = process.env.DSH_SMOKE === '1';
/** #5 responsive regression: DSH_RESPONSIVE_MEASURE=1 drives the UI probe. */
const isResponsiveMeasureMode = process.env.DSH_RESPONSIVE_MEASURE === '1';

/** Number of recent stderr bytes kept for the Settings → DSH viewer (§32). */
const STDERR_TAIL_LIMIT = 16 * 1024;

/** Pid file used for orphan cleanup across desktop restarts (P0-7 同口径). */
function runtimePidFile(home: string): string {
  return path.join(home, '.dsh', 'desktop', 'runtime.pid');
}

interface RuntimeCommandSpec {
  command: string;
  args: string[];
  label: string;
}

function splitArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return out;
}

/** Decide which child process stands behind the protocol for this launch. */
function resolveRuntimeCommand(appRoot: string): RuntimeCommandSpec {
  const bin = process.env.DSH_RUNTIME_BIN?.trim();
  if (bin) {
    return {
      command: bin,
      args: splitArgs(process.env.DSH_RUNTIME_ARGS),
      label: 'real dsh runtime'
    };
  }
  // The desktop profile is implemented by the in-repo adapter
  // (scripts/dsh-desktop-profile.mjs): it speaks Runtime Protocol v1 and
  // executes each run through the bundled dsh CLI's headless profile. When
  // the official CLI grows a native desktop profile, point DSH_RUNTIME_BIN
  // at it (e.g. `dsh --profile desktop --stdio`) to bypass the adapter.
  // Smoke / responsive QA flows keep the deterministic stub default.
  if (!isSmokeMode && !isResponsiveMeasureMode) {
    const bundledDsh = bundledDshCandidates(appRoot).find((candidate) => isExecutableFile(candidate));
    if (bundledDsh) {
      return {
        command: process.env.DSH_NODE_BIN || 'node',
        args: [path.join(appRoot, 'scripts', 'dsh-desktop-profile.mjs')],
        label: 'dsh desktop profile (bundled @deepseek-ai/dsh headless)'
      };
    }
  }
  return {
    command: process.env.DSH_NODE_BIN || 'node',
    args: [path.join(appRoot, 'scripts', 'stub-runtime.mjs')],
    label: 'stub runtime (fallback)'
  };
}

function isExecutableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function createManager(appRoot: string): { manager: DshProcessManager; spec: RuntimeCommandSpec } {
  const spec = resolveRuntimeCommand(appRoot);
  const manager = new DshProcessManager({
    command: spec.command,
    args: spec.args,
    cwd: appRoot,
    maxLineBytes: process.env.DSH_MAX_LINE_BYTES ? Number(process.env.DSH_MAX_LINE_BYTES) : undefined
  });
  return { manager, spec };
}

async function runSmoke(client: RuntimeClient): Promise<void> {
  const events: string[] = [];
  const timeout = setTimeout(() => {
    console.error('[smoke] timed out waiting for terminal event');
    console.log(JSON.stringify({ smoke: 'timeout', events }));
    app.exit(1);
  }, 30_000);
  timeout.unref();

  client.on('event', (frame: RuntimeEventFrame) => {
    events.push(frame.type);
    if (
      frame.type === 'done' ||
      frame.type === 'run_completed' ||
      frame.type === 'run_cancelled' ||
      frame.type === 'error'
    ) {
      clearTimeout(timeout);
      console.log(JSON.stringify({ smoke: 'ok', terminal: frame.type, events }, null, 2));
      setTimeout(() => app.exit(0), 100).unref();
    }
  });

  await client.start();
  client.run('Phase 0 smoke test', process.cwd());
}

type SecretSource = () => string[];

function registerIpcHandlers(context: {
  client: RuntimeClient;
  status: () => RuntimeStatus;
  appRoot: string;
  workspaces: WorkspaceManager;
  settings: SettingsStore;
  approvals: ApprovalService;
  getLogTail: (category?: 'stdout' | 'stderr' | 'event' | 'tool' | 'model') => string;
  getWindow: () => BrowserWindow | null;
  changeRecords: ChangeRecordService;
  broadcastChanges: (snapshot: ChangesSnapshot) => void;
  sessions: SessionStore;
}): void {
  const {
    client,
    status,
    appRoot,
    workspaces,
    settings,
    approvals,
    getLogTail,
    getWindow,
    changeRecords,
    broadcastChanges,
    sessions
  } = context;

  ipcMain.handle('runtime:get-status', () => status());
  ipcMain.handle('runtime:start', async () => {
    await client.start();
    return status();
  });
  ipcMain.handle('runtime:stop', async () => {
    await client.stop();
    return status();
  });
  ipcMain.handle('runtime:restart', async () => {
    await client.restart();
    return status();
  });
  ipcMain.handle('runtime:send', (_event, message: unknown) => {
    try {
      if (typeof message !== 'string' || message.trim() === '') {
        return { ok: false, error: 'empty message' };
      }
      client.run(message, workspaces.fallbackRoot());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('runtime:cancel', () => {
    try {
      return { ok: client.cancel() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /* ---- Changes / Diff (DSHA-6) — strictly read-only git access ---- */

  ipcMain.handle('changes:get-snapshot', async (): Promise<ChangesSnapshot> =>
    changeRecords.reconcile(workspaces.currentRoot)
  );
  ipcMain.handle('changes:get-file-diff', (_event, relPath: unknown) =>
    buildFileDiff(workspaces.currentRoot, typeof relPath === 'string' ? relPath : '')
  );
  // S-5: destructive per-file revert. The renderer double-confirms before
  // calling; the service restores worktree content WITHOUT any git write.
  ipcMain.handle('changes:revert-file', async (_event, relPath: unknown) => {
    const target = typeof relPath === 'string' ? relPath : '';
    const result = await changeRecords.revertFile(workspaces.currentRoot, target);
    const snapshot = await changeRecords.reconcile(workspaces.currentRoot).catch(() =>
      changeRecords.peekSnapshot(workspaces.currentRoot)
    );
    broadcastChanges(snapshot);
    return { result, snapshot };
  });

  /* ---- Approval (DSHA-5 §12/§13) ---- */

  ipcMain.handle('approval:respond', (_event, requestId: unknown, reply: unknown) => {
    if (typeof requestId !== 'string' || typeof reply !== 'object' || reply === null) {
      return { ok: false, error: '参数无效' };
    }
    const candidate = reply as Partial<ApprovalReply>;
    const decision =
      candidate.decision === 'allow' ? 'allow' : candidate.decision === 'reject' ? 'reject' : null;
    const scope = candidate.scope === 'session' ? 'session' : 'once';
    if (decision === null) {
      return { ok: false, error: '参数无效' };
    }
    const resolved = approvals.resolveRequest(requestId, { decision, scope });
    if (resolved) return { ok: true };
    // Review fix 3: distinguish "runtime could not receive the answer"
    // (retryable — keep the modal open) from an already-settled request
    // (closing the modal late is a harmless no-op; safe default stands).
    return approvals.hasPending(requestId)
      ? { ok: false, error: 'runtime_unreachable' }
      : { ok: false, error: 'no_pending_request' };
  });

  /* ---- Runtime Logs (§33) ---- */

  ipcMain.handle('runtime:get-log-tail', (_event, category: unknown): string =>
    getLogTail(
      category === 'stdout' || category === 'stderr' || category === 'event'
        || category === 'tool' || category === 'model'
        ? category
        : undefined
    )
  );

  /* ---- Home / workspace ---- */

  ipcMain.handle('workspace:open-project', async () => workspaces.openViaDialog());
  ipcMain.handle(
    'workspace:open-project-at',
    (_event, target: unknown): OpenProjectResult | Promise<OpenProjectResult> => {
      if (typeof target !== 'string' || target.trim() === '') {
        return { ok: false, error: '路径无效' };
      }
      return workspaces.openAt(target);
    }
  );
  ipcMain.handle('workspace:list-recent', () => workspaces.listRecent());
  ipcMain.handle(
    'workspace:pin-recent',
    (_event, id: unknown, pinned: unknown): OperationResult => {
      if (typeof id !== 'string' || typeof pinned !== 'boolean') {
        return { ok: false, error: '参数无效' };
      }
      return { ok: workspaces.pinRecent(id, pinned) };
    }
  );
  ipcMain.handle('workspace:remove-recent', (_event, id: unknown): OperationResult => {
    if (typeof id !== 'string') return { ok: false, error: '参数无效' };
    return { ok: workspaces.removeRecent(id) };
  });
  ipcMain.handle('workspace:check-path', (_event, target: unknown) => {
    if (typeof target !== 'string') {
      return { exists: false, isDirectory: false, accessible: false };
    }
    return workspaces.checkPath(target);
  });
  ipcMain.handle('workspace:get-current', () => ({ path: workspaces.currentRoot }));
  // 工作区上下文一致性（DSHA-7 QA 回归修复）：renderer 端 workspaceRoot 可由
  // Recent Projects 头部自动激活/顶部导航带入，而主进程 currentRoot 可能尚未
  // 同步。发送前 renderer 通过此通道让主进程激活同一 workspace；激活成功才
  // 允许 session:create 与 runtime:send（§15 local-first：会话必须落在真正的
  // workspace 目录下，不得退回 fallback root 静默发送）。
  ipcMain.handle('workspace:ensure-active', (_event, target: unknown): OpenProjectResult => {
    if (typeof target !== 'string' || target.trim() === '') {
      return { ok: false, error: '路径无效' };
    }
    // Reuse the same validated activation path as openAt (existence/type/
    // accessibility checks + recent touch) so main and renderer agree on ONE
    // canonical workspace activation entry point.
    return workspaces.openAt(target);
  });

  /* ---- Sessions (§15/§16, F10/AC-12) — local-first persistence ---- */

  ipcMain.handle('session:list', (): Promise<SessionSummary[]> => {
    const root = workspaces.currentRoot;
    if (!root) return Promise.resolve([]);
    return Promise.resolve(sessions.listSummaries(root));
  });
  ipcMain.handle('session:get-active-id', (): Promise<{ id: string | null }> => {
    const root = workspaces.currentRoot;
    if (!root) return Promise.resolve({ id: null });
    return Promise.resolve({ id: sessions.getActiveId(root) });
  });
  ipcMain.handle(
    'session:create',
    (_event, title: unknown): Promise<{ result: SessionMutationResult; record?: SessionRecord }> => {
      const root = workspaces.currentRoot;
      if (!root) {
        return Promise.resolve({ result: { ok: false, error: '未打开工作区' } });
      }
      const record = sessions.create(root, typeof title === 'string' ? title : undefined);
      return Promise.resolve({ result: { ok: true, id: record.id }, record });
    }
  );
  ipcMain.handle('session:load', (_event, id: unknown): Promise<SessionLoadResult> => {
    const root = workspaces.currentRoot;
    if (!root || !isValidSessionId(id)) {
      return Promise.resolve({ ok: false, error: '未打开工作区或会话 id 非法' });
    }
    return Promise.resolve(sessions.load(root, id));
  });
  ipcMain.handle('session:save', (_event, record: unknown): Promise<SessionMutationResult> => {
    const root = workspaces.currentRoot;
    if (!root || typeof record !== 'object' || record === null) {
      return Promise.resolve({ ok: false, error: '未打开工作区或会话记录无效' });
    }
    // Validate the untrusted renderer payload centrally before handing it to
    // the store; the store re-validates on the disk side too (defence in depth).
    const validated = validateSessionRecord(record, {
      expectedWorkspaceRoot: workspaces.currentRoot ?? undefined
    });
    if (!validated.ok) {
      return Promise.resolve({ ok: false, error: validated.error });
    }
    return Promise.resolve(sessions.save(root, validated.record));
  });
  ipcMain.handle('session:switch', (_event, id: unknown): Promise<SessionMutationResult> => {
    const root = workspaces.currentRoot;
    if (!root || !isValidSessionId(id)) {
      return Promise.resolve({ ok: false, error: '未打开工作区或会话 id 非法' });
    }
    return Promise.resolve(sessions.switchTo(root, id));
  });
  ipcMain.handle('session:delete', (_event, id: unknown): Promise<SessionMutationResult> => {
    const root = workspaces.currentRoot;
    if (!root || !isValidSessionId(id)) {
      return Promise.resolve({ ok: false, error: '未打开工作区或会话 id 非法' });
    }
    return Promise.resolve(sessions.delete(root, id));
  });
  // §34/§15 持久化生命周期：app 关闭/导航前的同步 checkpoint。Renderer
  // 用 sendSync 发送当前 SessionRecord，主进程同步落盘后返回结果——
  // 这样 beforeunload/pagehide 与 before-quit 都能在进程退出前完成保存。
  // 输入按 save() 口径做不可信校验（id 格式、schema、跨工作区一致性）。
  ipcMain.on('session:flush-before-quit', (event, record: unknown): void => {
    const root = workspaces.currentRoot;
    if (!root || typeof record !== 'object' || record === null) {
      event.returnValue = { ok: false, error: '未打开工作区或会话记录无效' };
      return;
    }
    const validated = validateSessionRecord(record, {
      expectedWorkspaceRoot: workspaces.currentRoot ?? undefined
    });
    if (!validated.ok) {
      event.returnValue = { ok: false, error: validated.error };
      return;
    }
    event.returnValue = sessions.save(root, validated.record);
  });

  /* ---- Settings ---- */

  ipcMain.handle('settings:get', () => settings.view());
  ipcMain.handle(
    'settings:save-provider',
    (_event, input: unknown): Promise<OperationResult> | OperationResult => {
      if (typeof input !== 'object' || input === null) {
        return { ok: false, error: '参数无效' };
      }
      const candidate = input as Partial<SaveProviderInput>;
      if (
        typeof candidate.name !== 'string' ||
        typeof candidate.baseUrl !== 'string' ||
        !Array.isArray(candidate.models)
      ) {
        return { ok: false, error: '表单字段缺失' };
      }
      return settings.saveProvider({
        name: candidate.name,
        apiType: candidate.apiType ?? 'openai_compatible',
        baseUrl: candidate.baseUrl,
        models: candidate.models.filter((m): m is string => typeof m === 'string'),
        apiKey: typeof candidate.apiKey === 'string' ? candidate.apiKey : undefined
      });
    }
  );
  ipcMain.handle('settings:delete-provider', (_event, name: unknown): OperationResult => {
    if (typeof name !== 'string') return { ok: false, error: '参数无效' };
    return settings.deleteProvider(name);
  });
  ipcMain.handle(
    'settings:set-permissions-mode',
    (_event, mode: unknown): Promise<OperationResult> | OperationResult => {
      if (typeof mode !== 'string') return { ok: false, error: '参数无效' };
      return settings.setPermissionsMode(mode as PermissionMode);
    }
  );
  ipcMain.handle(
    'settings:set-dsh-path',
    (_event, value: unknown): Promise<OperationResult> | OperationResult =>
      settings.setDshPath(typeof value === 'string' ? value : null)
  );
  ipcMain.handle(
    'settings:refresh-models',
    async (_event, input: unknown): Promise<ModelsRefreshResult> => {
      if (
        typeof input !== 'object' ||
        input === null ||
        typeof (input as Record<string, unknown>)['baseUrl'] !== 'string'
      ) {
        return { ok: false, error: 'Base URL 缺失' };
      }
      const req = input as { providerName?: string; baseUrl: string; apiKey?: string };
      // Prefer a freshly typed key; fall back to the stored one. Either way it
      // only travels into the Authorization header, never into logs.
      const apiKey =
        typeof req.apiKey === 'string' && req.apiKey.trim() !== ''
          ? req.apiKey.trim()
          : req.providerName
            ? settings.peekApiKey(req.providerName)
            : undefined;
      return refreshModels({ baseUrl: req.baseUrl, apiKey });
    }
  );

  /* ---- DSH detection / diagnostics ---- */

  ipcMain.handle('dsh:detect', (): Promise<DshDetection> =>
    locateDsh({ pathOverride: settings.getDshPath(), appRoot })
  );
  ipcMain.handle(
    'dsh:choose-path',
    async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
      // §32 「Choose DSH Path」：用户手动指定 dsh 可执行文件。
      const win = getWindow();
      const result = await (win
        ? dialog.showOpenDialog(win, {
            properties: ['openFile'],
            title: '选择 dsh 可执行文件'
          })
        : dialog.showOpenDialog({ properties: ['openFile'], title: '选择 dsh 可执行文件' }));
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, error: 'cancelled' };
      }
      const chosen = result.filePaths[0]!;
      const saved = settings.setDshPath(chosen);
      return saved.ok ? { ok: true, path: chosen } : saved;
    }
  );
  ipcMain.handle('dsh:get-stderr-tail', (): string =>
    // §33: stderr shown in UI must not leak credentials either.
    redactSecrets(stderrTail, settings.allSecrets())
  );
}

let stderrTail = '';

async function main(): Promise<void> {
  await app.whenReady();

  // Compiled output lives at dist/main/index.js → repo root is ../../..
  const appRoot = path.resolve(__dirname, '..', '..');

  // Desktop-owned stores live under ~/.dsh so all product state is together.
  const home = app.getPath('home');
  const pidFile = runtimePidFile(home);

  // P0-7 同口径：clean up a runtime orphaned by an earlier hard crash before
  // spawning anything new. Foreign processes are never touched.
  try {
    const recovery = await recoverOrphanRuntime({
      pidFile,
      isAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      readCommandLine: readLinuxCommandLine,
      terminate: defaultTerminate()
    });
    if (recovery.action !== 'none') {
      console.log(`[runtime] orphan recovery: ${JSON.stringify(recovery)}`);
    }
  } catch (err) {
    console.error('[runtime] orphan recovery failed:', err instanceof Error ? err.message : err);
  }

  const { manager, spec } = createManager(appRoot);
  const client = new RuntimeClient(manager);

  const secretSource: { current: SecretSource } = { current: () => [] };
  const settings = new SettingsStore({
    home,
    log: (line) => console.log(`[settings] ${redactSecrets(line, secretSource.current())}`)
  });
  secretSource.current = () => settings.allSecrets();

  // §33 Runtime Logs — the single redaction choke point for everything the
  // desktop records about the runtime conversation.
  const logStore = new RuntimeLogStore(() => settings.allSecrets(), { home });

  // AC-08 ordered bus between the client and every consumer (renderer,
  // approval service, logs).
  const bus = new RuntimeEventBus(client);

  const workspaces = new WorkspaceManager({
    home,
    selectDirectory: async () => {
      const win = mainWindow;
      const options = { properties: ['openDirectory'] as Array<'openDirectory'>, title: '选择项目目录' };
      const result = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0]!;
    }
  });

  let mainWindow: BrowserWindow | null = null;

  const broadcastState = (state: ConnectionState): void => {
    mainWindow?.webContents.send('runtime:connection-state', state);
    // §32 crash recovery: record the pid claim lifecycle alongside state.
    if (state === 'ready') {
      // §34 performance probe: the runtime-ready timestamp signal.
      console.log('[runtime] ready');
      const pid = manager.pid;
      if (pid !== undefined) {
        void claimRuntimePidFile(pidFile, {
          pid,
          command: [spec.command, ...spec.args].join(' ')
        }).catch(() => undefined);
      }
    }
    if (state === 'stopped') {
      void releaseRuntimePidFile(pidFile).catch(() => undefined);
    }
  };
  client.on('connection-state', broadcastState);

  // Ordered, de-duplicated fan-out (AC-08): the renderer and the log store
  // only ever see bus messages, never raw client events.
  let lastRuntimeError: string | null = null;

  /* ---- Change Record service (DSHA-6) ---- */
  const changeRecords = new ChangeRecordService();
  const broadcastChanges = (snapshot: ChangesSnapshot): void => {
    mainWindow?.webContents.send('changes:snapshot', snapshot);
  };

  /* ---- Session store (DSHA-7 §15/§16, F10/AC-12) ---- */
  // Desktop-owned conversation state lives under ~/.dsh/desktop so all product
  // state stays together; scoped per workspace root.
  const sessions = new SessionStore();

  bus.subscribe((message: BusMessage) => {
    if (message.kind === 'violation') {
      mainWindow?.webContents.send('runtime:protocol-violation', message.info);
      return;
    }
    const frame = message.frame;
    logStore.appendEvent(frame);
    if (frame.type === 'error' && typeof (frame as { message?: unknown }).message === 'string') {
      // Error text is redacted before it is ever stored or displayed.
      lastRuntimeError = String((frame as { message?: string }).message);
    }
    const terminalRunFrame = changeRecords.onRuntimeEvent(frame, workspaces.currentRoot);
    // Terminal run frames trigger git reconciliation (F3 对账兜底): merge
    // runtime-reported changes with the read-only status/diff sources and
    // push the merged snapshot to the Changes panel.
    if (terminalRunFrame) {
      void changeRecords
        .reconcile(workspaces.currentRoot)
        .then(broadcastChanges)
        .catch(() => undefined);
    }
    mainWindow?.webContents.send('runtime:event', frame);
  });

  client.on('stderr', (text: string) => {
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
    // Raw stderr also lands in the runtime log — append() applies redaction.
    logStore.append('stderr', text);
    if (process.env.DSH_DEBUG) {
      process.stderr.write(`[dsh stderr] ${redactSecrets(text, settings.allSecrets())}`);
    }
  });

  /* ---- Approval service wiring (§12/§13) ---- */

  const approvals = new ApprovalService({
    respond: (input) => client.respondApproval(input),
    getMode: () => settings.view().permissionsMode,
    checkPaths: async (paths) => {
      const checks = await Promise.all(
        paths.map(async (p) => {
          try {
            return await workspaces.boundary().check(p);
          } catch {
            return { allowed: false, needsAuthorization: false, resolvedPath: p } as const;
          }
        })
      );
      return {
        needsAuthorization: checks.some((c) => c.needsAuthorization === true),
        unverifiable: checks.some((c) => c.allowed === false && c.needsAuthorization !== true)
      };
    },
    notifyRenderer: (payload) => mainWindow?.webContents.send('runtime:approval-request', payload)
  });
  approvals.attach(bus);
  approvals.on(
    'resolved',
    (result: { approvalId: string; outcome: ApprovalResolution['outcome']; viaModal: boolean }) => {
      mainWindow?.webContents.send('runtime:approval-resolved', result);
    }
  );
  // Second-review fix: delivery failures must reach the UI. Auto decisions
  // that could not be sent escalate to a pending prompt inside the service;
  // this push keeps the renderer informed about the failure itself.
  approvals.on(
    'notice',
    (notice: { kind: string; approvalId?: string; reason?: string }) => {
      if (notice.kind !== 'respond_failed' || typeof notice.approvalId !== 'string') return;
      mainWindow?.webContents.send('runtime:approval-notice', {
        approvalId: notice.approvalId,
        reason: notice.reason ?? 'runtime_unreachable',
        message:
          notice.reason === 'runtime_unreachable'
            ? '审批结果未能送达运行时，请重试或在弹窗中手动处理。'
            : '审批处理出现问题，请重试。'
      });
    }
  );

  const commandLine = [spec.command, ...spec.args].join(' ');
  const crashSnapshot = (): RuntimeCrashSnapshot | null => {
    const info = client.lastCrash;
    if (!info && client.state !== 'crashed') return null;
    const exit = manager.exitInfo;
    return {
      exitCode: info?.code ?? exit?.code ?? null,
      signal: info?.signal ?? exit?.signal ?? null
    };
  };
  const status = (): RuntimeStatus => ({
    state: client.state,
    sessionId: client.state === 'stopped' ? null : client.currentSessionId,
    activeRunId: client.activeRun,
    commandLine: spec.label ? `${commandLine}  (${spec.label})` : commandLine,
    crash: crashSnapshot(),
    lastError: client.state === 'crashed'
      ? redactSecrets(manager.recentStderr.split('\n').filter(Boolean).at(-1) ?? '', settings.allSecrets()) || null
      : client.lastStartupError !== null && lastRuntimeError === null
        ? redactSecrets(client.lastStartupError, settings.allSecrets())
        : lastRuntimeError
  });

  registerIpcHandlers({
    client,
    status,
    appRoot,
    workspaces,
    settings,
    approvals,
    getLogTail: (category) =>
      logStore.tail({ category, maxChars: 32 * 1024 }),
    getWindow: () => mainWindow,
    changeRecords,
    broadcastChanges,
    sessions
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'DSH Desktop',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // The responsive probes drive the real Workspace page. Since the DSHA-7
  // workspace-consistency fix the composer requires an ACTIVE workspace (no
  // more silent fallback-root sends), so open a throwaway probe workspace
  // BEFORE the renderer loads — its Recent-Projects bootstrap then sees a
  // valid head and the full user flow (activate → session:create → send) is
  // exercised. Dropped again after the probes (record + directory).
  const responsiveProbeWorkspace = isResponsiveMeasureMode
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-responsive-probe-'))
    : null;
  if (responsiveProbeWorkspace !== null) {
    workspaces.openAt(responsiveProbeWorkspace);
  }

  // §34 cold-start probe: first-paint timestamp = the first navigation the
  // renderer finished loading (did-finish-load). Attached BEFORE loadFile so
  // the initial load's event is captured; one-shot, logged to stdout so the
  // startup measurement can time the首屏.
  mainWindow.webContents.once('did-finish-load', () => {
    console.log('[first-paint]');
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(path.join(appRoot, 'dist', 'renderer', 'index.html'));
  }

  if (isSmokeMode) {
    try {
      await runSmoke(client);
    } catch (err) {
      console.error('[smoke] failed:', err instanceof Error ? err.message : err);
      app.exit(1);
    }
  }

  if (isResponsiveMeasureMode && mainWindow !== null) {
    const win = mainWindow;
    let failed = false;
    try {
      await runResponsiveMeasure(win, client, appRoot, {
        approvalFlow: process.env.STUB_APPROVAL_FLOW === '1'
      });
    } catch (err) {
      failed = true;
      console.error(
        '[responsive] failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
    // Deterministic teardown: stop the resident stub so no child survives,
    // drop the probe workspace (recent record + directory), then exit with
    // the probe verdict.
    await client.stop().catch(() => undefined);
    if (responsiveProbeWorkspace !== null) {
      try {
        workspaces.removeRecent(idForPath(responsiveProbeWorkspace));
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(responsiveProbeWorkspace, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    console.log(JSON.stringify({ responsive: failed ? 'fail' : 'ok' }));
    setTimeout(() => app.exit(failed ? 1 : 0), 100).unref();
    return;
  }

  /* ---- Graceful shutdown (P0-7 同口径 / §32) ---- */

  app.on('window-all-closed', () => {
    app.quit();
  });

  let shuttingDown = false;
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    // Stop the runtime first so the child sees a graceful exit and the pid
    // claim is released; then flush the runtime log and leave.
    void client
      .stop()
      .catch(() => undefined)
      .then(() => releaseRuntimePidFile(pidFile).catch(() => undefined))
      .then(() => logStore.close())
      .catch(() => undefined)
      .finally(() => app.exit(0));
  });
}

void main().catch((err) => {
  console.error('[main] fatal:', err);
  app.exit(1);
});
