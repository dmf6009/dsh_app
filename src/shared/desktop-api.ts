/**
 * Contract between the Electron main process and the renderer, exposed over
 * contextBridge as `window.desktop`.
 */

import type { RuntimeEventFrame, ProtocolViolationInfo } from './protocol/types';
import type { ApprovalRequestPayload, ApprovalOutcome } from './approval-protocol';
import type { ChangesSnapshot, FileDiffResult, RevertFileResult } from './changes';
import type {
  ModelsRefreshResult,
  OperationResult,
  PermissionMode,
  SaveProviderInput,
  SettingsView
} from './settings';
import type { OpenProjectResult, PathCheckResult, RecentProject } from './workspace';
import type {
  PluginsSnapshot,
  PluginMutationResult
} from './plugins';
import type {
  SessionLoadResult,
  SessionMutationResult,
  SessionRecord,
  SessionSummary
} from './session';

export type ConnectionState = 'stopped' | 'starting' | 'ready' | 'crashed';

/** What the last abnormal child exit looked like (§32 crash recovery). */
export interface RuntimeCrashSnapshot {
  exitCode: number | null;
  signal: string | null;
}

export interface RuntimeStatus {
  state: ConnectionState;
  sessionId: string | null;
  activeRunId: string | null;
  /** Human-readable description of the child command being run. */
  commandLine: string;
  /** Present only while state === 'crashed'. */
  crash: RuntimeCrashSnapshot | null;
  /** Last protocol/runtime error line worth showing (already redacted). */
  lastError: string | null;
}

/** Result of a completed approval round (pushed back to the renderer). */
export interface ApprovalResolution {
  approvalId: string;
  outcome: ApprovalOutcome;
  viaModal: boolean;
}

/**
 * Pushed when an approval decision could not be delivered to the runtime
 * (second review fix). The affected request is escalated to a pending
 * prompt — this notice makes the failure itself visible.
 */
export interface ApprovalDeliveryNotice {
  approvalId: string;
  reason: string;
  message: string;
}

/** Result of probing for a DSH installation (§32/§38 startup chain). */
export interface DshDetection {
  found: boolean;
  /** Absolute path of the detected binary when found. */
  path?: string;
  version?: string;
  /** Why detection failed (already localized for direct display). */
  reason?: string;
}

export interface DesktopApi {
  getStatus(): Promise<RuntimeStatus>;
  startRuntime(): Promise<RuntimeStatus>;
  stopRuntime(): Promise<RuntimeStatus>;
  restartRuntime(): Promise<RuntimeStatus>;
  sendMessage(
    message: string,
    model?: { provider: string; model: string }
  ): Promise<{ ok: boolean; error?: string }>;
  cancelRun(): Promise<{ ok: boolean; error?: string }>;
  onEvent(listener: (frame: RuntimeEventFrame) => void): () => void;
  onConnectionState(listener: (state: ConnectionState) => void): () => void;

  /* ---- Approval (DSHA-5 §12/§13) ---- */
  /** Renderer answered the approval modal (close ≙ reject). */
  respondApproval(
    requestId: string,
    reply: { decision: 'allow' | 'reject'; scope: 'once' | 'session' }
  ): Promise<{ ok: boolean; error?: string }>;
  /** Push channel for pending approval prompts. */
  onApprovalRequest(listener: (payload: ApprovalRequestPayload) => void): () => void;
  onApprovalResolved(listener: (resolution: ApprovalResolution) => void): () => void;
  /** Push channel for approval delivery failures (retryable). */
  onApprovalNotice(listener: (notice: ApprovalDeliveryNotice) => void): () => void;

  /* ---- Runtime Logs (§33) ---- */
  /** Tail of the redacted runtime log, optionally filtered by category. */
  getRuntimeLogTail(category?: 'stdout' | 'stderr' | 'event' | 'tool' | 'model'): Promise<string>;
  /** Malformed-frame diagnostics from the ordered bus. */
  onProtocolViolation(listener: (info: ProtocolViolationInfo) => void): () => void;

  /* ---- Changes / Diff (DSHA-6, F3/F7/AC-09/S-5) ---- */
  /** Aggregated change records + read-only git facts for the active root. */
  getChangesSnapshot(): Promise<ChangesSnapshot>;
  /** Original/modified text pair + unified diff for one file (read-only). */
  getFileDiff(path: string): Promise<FileDiffResult>;
  /**
   * DESTRUCTIVE (S-5): restore one file to its pre-change content. The UI
   * must double-confirm first; execution itself stays an L2-gated action.
   */
  revertFile(path: string): Promise<{ result: RevertFileResult; snapshot: ChangesSnapshot }>;
  /** Push channel fired after every reconciliation. */
  onChangesSnapshot(listener: (snapshot: ChangesSnapshot) => void): () => void;

  /* ---- Home / workspace (§7) ---- */
  /** Opens the native directory picker, then activates + records the project. */
  openProject(): Promise<OpenProjectResult>;
  /** Activates a known path directly (Recent Projects 打开). */
  openProjectAt(path: string): Promise<OpenProjectResult>;
  listRecentProjects(): Promise<RecentProject[]>;
  pinRecentProject(id: string, pinned: boolean): Promise<OperationResult>;
  removeRecentProject(id: string): Promise<OperationResult>;
  checkPath(path: string): Promise<PathCheckResult>;
  getCurrentWorkspace(): Promise<{ path: string | null }>;
  /**
   * Make sure the main process has the same workspace active as the renderer
   * (§15 工作区上下文一致性). The renderer's workspaceRoot can come from the
   * Recent Projects head or top navigation while main's currentRoot is still
   * null; callers must ensure activation BEFORE creating sessions/sending.
   * Reuses the same validated activation as openProjectAt.
   */
  ensureWorkspaceActive(path: string): Promise<OpenProjectResult>;

  /* ---- Sessions (§15/§16, F10/AC-12) ---- */
  /** Sidebar summaries for the active workspace (newest-updated first). */
  listSessions(): Promise<SessionSummary[]>;
  /** Persisted active session id for the active workspace (AC-12 restore). */
  getActiveSessionId(): Promise<{ id: string | null }>;
  /** Create a new session and switch to it. Returns the fresh record. */
  createSession(title?: string): Promise<{ result: SessionMutationResult; record?: SessionRecord }>;
  /** Load one session record (corrupt/missing degrade to a soft error). */
  loadSession(id: string): Promise<SessionLoadResult>;
  /** Persist the full transcript + metadata of an existing session. */
  saveSession(record: SessionRecord): Promise<SessionMutationResult>;
  /** Mark a session as active (§15 切换). */
  switchSession(id: string): Promise<SessionMutationResult>;
  /** Delete a session record (§15 删除; idempotent). */
  deleteSession(id: string): Promise<SessionMutationResult>;
  /**
   * Synchronous checkpoint used by the renderer's beforeunload/pagehide and
   * the main process before-quit so an in-flight conversation is never lost on
   * navigation or app close (§34/§15 持久化生命周期). Returns the save result.
   */
  flushBeforeQuit(record: SessionRecord): SessionMutationResult;

  /* ---- Settings (§17/§12/§32) ---- */
  getSettings(): Promise<SettingsView>;
  saveProvider(input: SaveProviderInput): Promise<OperationResult>;
  deleteProvider(name: string): Promise<OperationResult>;
  setPermissionsMode(mode: PermissionMode): Promise<OperationResult>;
  setDshPath(path: string | null): Promise<OperationResult>;
  /** Writes the dsh-native `agent-default-model` section. */
  setDefaultModel(provider: string, model: string): Promise<OperationResult>;
  refreshModels(input: {
    providerName?: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<ModelsRefreshResult>;

  /* ---- DSH detection / runtime diagnostics (§32/§38) ---- */
  detectDsh(): Promise<DshDetection>;
  chooseDshPath(): Promise<{ ok: boolean; path?: string; error?: 'cancelled' | string }>;
  getStderrTail(): Promise<string>;

  /* ---- Plugins (dsh「万物皆可插」— run profile 的插件管理) ---- */
  listPlugins(): Promise<PluginsSnapshot>;
  addPlugin(spec: string): Promise<PluginMutationResult>;
  removePlugin(name: string): Promise<PluginMutationResult>;
}

export const DESKTOP_API_KEY = 'desktop';
