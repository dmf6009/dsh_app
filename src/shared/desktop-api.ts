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
  sendMessage(message: string): Promise<{ ok: boolean; error?: string }>;
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

  /* ---- Settings (§17/§12/§32) ---- */
  getSettings(): Promise<SettingsView>;
  saveProvider(input: SaveProviderInput): Promise<OperationResult>;
  deleteProvider(name: string): Promise<OperationResult>;
  setPermissionsMode(mode: PermissionMode): Promise<OperationResult>;
  setDshPath(path: string | null): Promise<OperationResult>;
  refreshModels(input: {
    providerName?: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<ModelsRefreshResult>;

  /* ---- DSH detection / runtime diagnostics (§32/§38) ---- */
  detectDsh(): Promise<DshDetection>;
  chooseDshPath(): Promise<{ ok: boolean; path?: string; error?: 'cancelled' | string }>;
  getStderrTail(): Promise<string>;
}

export const DESKTOP_API_KEY = 'desktop';
