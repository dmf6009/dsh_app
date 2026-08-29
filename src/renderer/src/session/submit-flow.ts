/**
 * First-message submit flow (DSHA-7 QA regression fix, §15/AC-02/AC-12).
 *
 * Pure, testable ordering for the composer's submit. The QA-caught regression:
 * the renderer can reach the Workspace page (Recent Projects auto-activation /
 * top navigation) while the main process's `workspaces.currentRoot` is still
 * null — a first message then failed session:create with 未打开工作区 and the
 * send was blocked (or, pre-fix, silently degraded into sending without any
 * persisted session). The review round after that caught a second bug: the
 * page cleared the composer unconditionally after the flow returned, wiping
 * the very input the blocked path tried to preserve.
 *
 * The contract, asserted by tests/submit-flow.test.ts:
 *   1. the workspace is activated in the MAIN process strictly BEFORE
 *      session:create (激活先于 create);
 *   2. on success the message is dispatched to the chat and the run starts
 *      (首条消息上屏并启动 run);
 *   3. on activation or create failure NOTHING is sent and an accurate §32
 *      three-part notice is surfaced (不发送且提示准确);
 *   4. `clearInput` is invoked by THIS flow, exactly once and only at dispatch
 *      time — blocked paths never clear it, so the composer keeps the user's
 *      message (输入保留). The page must not touch the input around the flow;
 *   5. an existing session skips workspace/create entirely;
 *   6. create/switch keep their checkpoint-first + fail-abort semantics
 *      (owned by session-transition.ts, unchanged here).
 */

import { ensureWorkspaceActive, type ActivateOutcome } from './session-transition';
import type { ChatModel } from '../chat/model';

/**
 * How a submit ended. `dispatched` means the message went on screen and the
 * run was attempted (`delivered=false` when the run failed to start — the
 * pre-existing notice path); `blocked` means nothing was sent and the input
 * must be preserved.
 */
export type SubmitOutcome =
  | { status: 'dispatched'; delivered: boolean }
  | { status: 'blocked' };

export interface SubmitFlowIo {
  /** Renderer-side workspace root (may be null when no context exists). */
  workspaceRoot(): string | null;
  /** Whether the active session already exists (session id known). */
  hasActiveSession(): boolean;
  /** Activate `path` in the main process (workspace:ensure-active IPC). */
  activateWorkspace(path: string): Promise<ActivateOutcome>;
  /** Create the first session (hook create: checkpoint-first, null = aborted). */
  createSession(title: string): Promise<ChatModel | null>;
  /** Dispatch the message to the chat + start the run; {ok:false} = run failed.
   *  `model` (agent-default-model shape) selects the run's model when set. */
  sendMessage(
    text: string,
    model?: { provider: string; model: string }
  ): Promise<{ ok: boolean; error?: string }>;
  /** Current model selection (agent-default-model shape); null = 默认模型. */
  selectedModel?(): { provider: string; model: string } | null;
  /**
   * Clear the composer input. Called by the flow itself, exactly once, only
   * when the message is actually dispatched — NEVER on blocked paths, so the
   * user's text survives a failed activation/create.
   */
  clearInput(): void;
  /** Track the (possibly normalized) activated workspace path in app state. */
  onWorkspaceActivated(path: string): void;
  /** Apply the freshly created session's empty model. */
  onSessionCreated(model: ChatModel): void;
  /** Surface a §32 three-part "blocked" notice; the message is NOT sent. */
  onBlocked(notice: string): void;
  /** Surface a send failure notice (existing behavior: run never started). */
  onSendFailed(error?: string): void;
}

/**
 * Run one submit. `dispatched` outcomes cleared the input at dispatch time
 * (including a failed run start — pre-existing behavior); `blocked` outcomes
 * sent nothing and left the input untouched.
 */
export async function runSubmit(io: SubmitFlowIo, text: string): Promise<SubmitOutcome> {
  if (!io.hasActiveSession()) {
    // (1) Workspace context first — activation precedes session:create.
    const activation = await ensureWorkspaceActive(io.workspaceRoot(), io.activateWorkspace);
    if (!activation.ok || !activation.path) {
      io.onBlocked(activation.error ?? '未打开工作区');
      return { status: 'blocked' };
    }
    io.onWorkspaceActivated(activation.path);
    // (2) Then the first session, so the transcript is persisted from the
    // very first message (§15/AC-12). createSession keeps its own
    // checkpoint-first / fail-abort semantics and surfaces its own errors.
    const created = await io.createSession(text.slice(0, 40));
    if (created === null) {
      return { status: 'blocked' }; // creation aborted; notice already surfaced
    }
    io.onSessionCreated(created);
  }
  // (3) The message goes out only after the session exists — and only now is
  // the input cleared, because only now has the message actually dispatched.
  io.clearInput();
  const result = await io.sendMessage(text, io.selectedModel?.() ?? undefined);
  if (!result.ok) {
    io.onSendFailed(result.error);
    return { status: 'dispatched', delivered: false };
  }
  return { status: 'dispatched', delivered: true };
}
