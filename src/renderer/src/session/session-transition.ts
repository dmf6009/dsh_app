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
