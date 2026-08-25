/**
 * Electron main entry (Phase 0).
 *
 * Wires the RuntimeClient (DSH Process Manager + protocol codec) to the
 * renderer over IPC. The child command defaults to the reference stub runtime
 * so the closed loop is verifiable without a real DSH desktop profile;
 * set DSH_RUNTIME_BIN to point at `dsh --profile desktop --stdio` once it
 * exists.
 */

import path from 'node:path';

import { BrowserWindow, app, ipcMain } from 'electron';

import type { ConnectionState, RuntimeStatus } from '../shared/desktop-api';
import type { RuntimeEventFrame } from '../shared/protocol/types';
import { resolveWorkspace } from './workspace-manager';
import { DshProcessManager } from './runtime/dsh-process-manager';
import { RuntimeClient } from './runtime/runtime-client';

const isSmokeMode = process.env.DSH_SMOKE === '1';

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
  return {
    command: process.env.DSH_NODE_BIN || 'node',
    args: [path.join(appRoot, 'scripts', 'stub-runtime.mjs')],
    label: 'stub runtime (Phase 0 default)'
  };
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

async function main(): Promise<void> {
  await app.whenReady();

  // Compiled output lives at dist/main/index.js → repo root is ../../..
  const appRoot = path.resolve(__dirname, '..', '..');
  const { manager, spec } = createManager(appRoot);
  const client = new RuntimeClient(manager);

  let mainWindow: BrowserWindow | null = null;

  const broadcastState = (state: ConnectionState): void => {
    mainWindow?.webContents.send('runtime:connection-state', state);
  };
  client.on('connection-state', broadcastState);
  client.on('event', (frame: RuntimeEventFrame) => {
    mainWindow?.webContents.send('runtime:event', frame);
  });
  client.on('stderr', (text: string) => {
    if (process.env.DSH_DEBUG) process.stderr.write(`[dsh stderr] ${text}`);
  });

  const commandLine = [spec.command, ...spec.args].join(' ');
  const status = (): RuntimeStatus => ({
    state: client.state,
    sessionId: client.state === 'stopped' ? null : client.currentSessionId,
    activeRunId: client.activeRun,
    commandLine: spec.label ? `${commandLine}  (${spec.label})` : commandLine
  });

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
      const workspace = resolveWorkspace(null).root;
      client.run(message, workspace);
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

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'DSH Desktop — Phase 0',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
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
}

void main().catch((err) => {
  console.error('[main] fatal:', err);
  app.exit(1);
});
