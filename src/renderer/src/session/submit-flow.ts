/**
 * First-message submit flow (DSHA-7 QA regression fix, §15/AC-02/AC-12).
 *
 * Pure, testable ordering for the composer's submit when no session exists
 * yet. The QA-caught regression: the renderer can reach the Workspace page
 * (Recent Projects auto-activation / top navigation) while the main process's
 * `workspaces.currentRoot` is still null — a first message then failed
 * session:create with 未打开工作区 and the send was blocked (or, pre-fix,
 * silently degraded into sending without any persisted session).
 *
 * The fixed contract, asserted by tests/submit-flow.test.ts:
 *   1. the workspace is activated in the MAIN process strictly BEFORE
 *      session:create (激活先于 create);
 *   2. on success the message is dispatched to the chat and the run starts
 *      (首条消息上屏并启动 run);
 *   3. on activation or create failure nothing is sent, the user's input is
 *      preserved and an accurate §32 three-part notice is surfaced (不发送且
 *      提示准确);
 *   4. an existing session skips workspace/create entirely;
 *   5. create/switch keep their checkpoint-first + fail-abort semantics
 *      (owned by session-transition.ts, unchanged here).
 */

import { ensureWorkspaceActive, type ActivateOutcome } from './session-transition';
import type { ChatModel } from '../chat/model';

export interface SubmitFlowIo {
  /** Renderer-side workspace root (may be null when no context exists). */
  workspaceRoot(): string | null;
  /** Whether the active session already exists (session id known). */
  hasActiveSession(): boolean;
  /** Activate `path` in the main process (workspace:ensure-active IPC). */
  activateWorkspace(path: string): Promise<ActivateOutcome>;
  /** Create the first session (hook create: checkpoint-first, null = aborted). */
  createSession(title: string): Promise<ChatModel | null>;
  /** Dispatch the message to the chat + start the run; {ok:false} = run failed. */
  sendMessage(text: string): Promise<{ ok: boolean; error?: string }>;
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
 * Run one submit. Returns true iff the message was dispatched (the run may
 * still fail afterwards — that is reported via onSendFailed, preserving the
 * pre-existing behavior where the input is cleared once dispatched).
 */
export async function runSubmit(io: SubmitFlowIo, text: string): Promise<boolean> {
  if (!io.hasActiveSession()) {
    // (1) Workspace context first — activation precedes session:create.
    const activation = await ensureWorkspaceActive(io.workspaceRoot(), io.activateWorkspace);
    if (!activation.ok || !activation.path) {
      io.onBlocked(activation.error ?? '未打开工作区');
      return false;
    }
    io.onWorkspaceActivated(activation.path);
    // (2) Then the first session, so the transcript is persisted from the
    // very first message (§15/AC-12). createSession keeps its own
    // checkpoint-first / fail-abort semantics and surfaces its own errors.
    const created = await io.createSession(text.slice(0, 40));
    if (created === null) {
      return false; // creation aborted; notice already surfaced by the hook
    }
    io.onSessionCreated(created);
  }
  // (3) Message goes out only after the session exists.
  const result = await io.sendMessage(text);
  if (!result.ok) {
    io.onSendFailed(result.error);
    return false;
  }
  return true;
}
