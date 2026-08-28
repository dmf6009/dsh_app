/**
 * Session transition orchestration (DSHA-7 review round 2, §15/AC-12).
 *
 * Pure, testable ordering for the two multi-session transitions whose data
 * loss the review flagged:
 *
 *   create : persist outgoing → create new → apply UI state → empty model
 *   switch : persist outgoing → activate target → load target → apply UI state
 *
 * The invariant in both: the OUTGOING session is checkpointed first, and a
 * failed checkpoint ABORTS the transition — no create, no switch, no state
 * mutation. The hook injects the IO (persist/activate/load/create) and the
 * state setters; this module owns only ordering + failure semantics, so the
 * exact sequencing is unit-testable without a DOM.
 */

import type { SessionMutationResult, SessionRecord } from '../../../shared/session';
import { fromSessionItems, type ChatModel } from '../chat/model';

export interface TransitionIo {
  /** Checkpoint the outgoing session. Non-null string = failure. */
  persistOutgoing: () => Promise<string | null>;
  /** Create the new session record (create flow only). */
  createNew: (title?: string) => Promise<{ result: SessionMutationResult; record?: SessionRecord }>;
  /** Mark the target as active in the store/index (switch flow only). */
  activate: (id: string) => Promise<SessionMutationResult>;
  /** Load the target session record (switch flow only). */
  load: (id: string) => Promise<{ ok: boolean; record?: SessionRecord; error?: string }>;
  /** Apply UI state after the record was created (create flow only). */
  onCreated: (record: SessionRecord) => void;
  /** Apply UI state after the target was activated; `record` may be absent
   *  when the target file is corrupt/missing (fresh-model fallback). */
  onSwitched: (id: string, record: SessionRecord | null) => void;
}

export type TransitionOutcome =
  | { status: 'completed'; model: ChatModel }
  | { status: 'aborted'; stage: 'persist' | 'create' | 'activate'; error?: string };

export interface ActivateOutcome {
  ok: boolean;
  /** Canonical activated path (normalized by the main process) on success. */
  path?: string;
  error?: string;
}

/**
 * 工作区上下文一致性（DSHA-7 QA 回归修复）：renderer 已有 workspaceRoot 而主进程
 * currentRoot 尚未同步时，先让主进程激活该 workspace，再允许 session:create 与
 * runtime:send。激活失败则发送中止并返回错误——绝不退回 fallback root 静默发送
 * （那会让会话落到错误的目录，破坏 §15 local-first 持久化）。
 */
export async function ensureWorkspaceActive(
  workspaceRoot: string | null,
  activate: (path: string) => Promise<ActivateOutcome>
): Promise<ActivateOutcome> {
  if (workspaceRoot === null || workspaceRoot.trim() === '') {
    return { ok: false, error: '未打开工作区' };
  }
  return activate(workspaceRoot);
}

const EMPTY_MODEL: ChatModel = { items: [], phase: 'idle', changes: [] };

/** Project a loaded record into the at-rest ChatModel shown after a switch. */
export function modelFromRecord(record: SessionRecord | null | undefined): ChatModel {
  if (!record) return EMPTY_MODEL;
  return {
    items: fromSessionItems(record.items),
    phase: 'idle', // never auto-resume a running task
    changes: record.items
      .filter((i) => i.kind === 'file_changed')
      .map((i) => ({
        id: i.id,
        path: i.path ?? '',
        change: (i.change as 'added' | 'modified' | 'deleted') ?? 'modified'
      }))
  };
}

/**
 * Decide what a hydration pass may apply to the live model (DSHA-7 QA round 3:
 * a freshly created session's async hydrate used to resolve an EMPTY model
 * that overwrote the first, still-unpersisted user message — AC-12 loss).
 *
 * A freshly created session has NOTHING on disk: hydration is a no-op and
 * returns null so the caller keeps the live (possibly mid-dispatch) model.
 * An existing session projects its record as usual; a corrupt/missing record
 * degrades to the empty at-rest model so the panel still works.
 */
export function resolveHydration(
  freshlyCreated: boolean,
  record: SessionRecord | null | undefined
): ChatModel | null {
  if (freshlyCreated) return null;
  return modelFromRecord(record ?? null);
}

/**
 * Session-identity race guard for hydration (DSHA-7 review round 4).
 *
 * The round-3 guard rejected ANY non-empty live model, which wrongly blocked
 * legitimate replacements — e.g. after deleting the active session the page
 * keeps the deleted session's non-empty model and relies on hydration to load
 * the fallback session. The correct discriminator is not "is the model empty"
 * but "did the live model MUTATE since the hydration request was issued":
 *
 *   - request() captures an epoch when a hydration pass starts;
 *   - noteMutation() is called on every NON-hydration model mutation (chat
 *     dispatch, create/switch model application, send-failure notice);
 *   - canApply(epoch) is true only when nothing mutated in between.
 *
 * Consequences: a first message dispatched while a fresh hydration is in
 * flight bumps the epoch → the stale empty snapshot is dropped (the round-3
 * bug), while a stale model left over from a DELETED or PREVIOUS session has
 * NOT mutated → the legitimate fallback/existing snapshot still replaces it
 * (the round-4 requirement). The effect's own cancellation flag remains the
 * first line of defense for "active id changed → request superseded".
 */
export class HydrationGuard {
  private epoch = 0;

  /** Record a non-hydration mutation of the live model. */
  noteMutation(): void {
    this.epoch += 1;
  }

  /** Epoch captured when a hydration request is issued. */
  request(): number {
    return this.epoch;
  }

  /** May a result requested at `epoch` still be applied? */
  canApply(epoch: number): boolean {
    return epoch === this.epoch;
  }
}

/**
 * Create flow. Order: persist outgoing → create → onCreated → empty model.
 * Abort stages: `persist` (outgoing checkpoint failed — nothing was mutated),
 * `create` (the store refused to create; outgoing was saved but no switch).
 */
export async function createSessionWithCheckpoint(
  io: TransitionIo,
  title?: string
): Promise<TransitionOutcome> {
  const persistError = await io.persistOutgoing();
  if (persistError !== null) {
    return { status: 'aborted', stage: 'persist', error: persistError };
  }
  const { result, record } = await io.createNew(title);
  if (!result.ok || !record) {
    return { status: 'aborted', stage: 'create', error: result.error };
  }
  io.onCreated(record);
  return { status: 'completed', model: EMPTY_MODEL };
}

/**
 * Switch flow. Order: persist outgoing → activate → load → onSwitched → model.
 * Abort stages: `persist` (nothing mutated — the user stays on the unsaved
 * session), `activate` (the index switch failed; outgoing was saved but the
 * target was not entered). A corrupt/missing target record is NOT an abort —
 * the switch already succeeded in the index, so the user lands on an empty
 * transcript for that session (original pre-existing fallback behavior).
 */
export async function switchSessionWithCheckpoint(
  io: TransitionIo,
  id: string
): Promise<TransitionOutcome> {
  const persistError = await io.persistOutgoing();
  if (persistError !== null) {
    return { status: 'aborted', stage: 'persist', error: persistError };
  }
  const activated = await io.activate(id);
  if (!activated.ok) {
    return { status: 'aborted', stage: 'activate', error: activated.error };
  }
  const loaded = await io.load(id);
  const record = loaded.ok && loaded.record ? loaded.record : null;
  io.onSwitched(id, record);
  return { status: 'completed', model: modelFromRecord(record) };
}
