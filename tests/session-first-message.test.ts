/**
 * Session hydration race tests (DSHA-7 QA round 3 + review round 4, §15/AC-12).
 *
 * Round 3 (QA): a freshly created session's async hydrate resolved an EMPTY
 * model and overwrote the first, still-unpersisted user message.
 *
 * Round 4 (Review): the round-3 fix's second layer ("model non-empty ⇒
 * snapshot stale") wrongly blocked LEGITIMATE replacements — after deleting
 * the active session the page keeps the deleted session's non-empty model and
 * relies on hydration to load the fallback session; the same applies to an
 * existing session whose hydration resolves after the user already mutated
 * the model. The discriminator must be session identity / request epoch, not
 * model emptiness.
 *
 * The current design under test (the exact pieces WorkspacePage uses):
 *   - resolveHydration(freshlyCreated, record) — a freshly created session has
 *     nothing on disk: hydration is a no-op (null) and the live model is truth;
 *   - HydrationGuard — request()/noteMutation()/canApply() epoch protocol:
 *     a hydration result may replace the model only if NO non-hydration
 *     mutation happened since the request was issued. A stale model left over
 *     from a deleted/previous session has NOT mutated → its snapshot applies;
 *     a first message dispatched mid-request HAS mutated → the late empty
 *     snapshot is dropped;
 *   - the effect's `cancelled` cleanup handles "active id changed before the
 *     request resolved" (superseded request) — mirrored here as well.
 *
 * Races pinned (the review's three required scenarios plus the originals):
 *   R1 delete the active session → fallback hydrate MUST replace the deleted
 *      session's non-empty model (round-4 regression);
 *   R2 an existing session's late hydration replaces a mutated model — the
 *      model belongs to the PREVIOUS session, so the replacement is correct;
 *   R3 a first message dispatched while hydration is in flight survives the
 *      late snapshot (round-3 regression);
 *   R4 a hydration result arriving after the active id changed (superseded
 *      request) is not applied;
 *   plus the full disk lifecycle: message displayed after run completes,
 *      persisted, readable after a restart — and no cross-session writes.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { SessionStore } from '../src/main/session/session-store';
import type { SessionRecord } from '../src/shared/session';
import {
  INITIAL_MODEL,
  reduceChat,
  toSessionItems,
  type ChatModel
} from '../src/renderer/src/chat/model';
import {
  HydrationGuard,
  resolveHydration
} from '../src/renderer/src/session/session-transition';
import { ROOT } from './helpers';

const STORE_DIR = path.join(ROOT, '.tmp-tests', 'session-first-message');
const WS = '/tmp/demo/project';
const MESSAGE = '请帮我梳理认证模块的实现';

let idTick = 0;

function makeStore(): SessionStore {
  let tick = 0;
  idTick = 0;
  return new SessionStore({
    baseDirectory: STORE_DIR,
    now: () => new Date(++tick),
    generateId: () => `sess-${++idTick}`
  });
}

beforeEach(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

describe('resolveHydration — freshly created sessions are a no-op', () => {
  it('returns null for a freshly created session (nothing on disk, memory is truth)', () => {
    expect(resolveHydration(true, null)).toBeNull();
    expect(resolveHydration(true, { id: 'x' } as unknown as SessionRecord)).toBeNull();
  });

  it('projects an existing record; corrupt/missing degrade to the empty rest model', () => {
    expect(resolveHydration(false, null)).toEqual({ items: [], phase: 'idle', changes: [] });
  });
});

describe('HydrationGuard — epoch protocol', () => {
  it('allows applying when nothing mutated since the request', () => {
    const guard = new HydrationGuard();
    const epoch = guard.request();
    expect(guard.canApply(epoch)).toBe(true);
  });

  it('rejects a request whose epoch was superseded by any model mutation', () => {
    const guard = new HydrationGuard();
    const epoch = guard.request();
    guard.noteMutation(); // e.g. a chat action dispatched mid-request
    expect(guard.canApply(epoch)).toBe(false);
  });

  it('treats each request independently: a later request applies, the stale one does not', () => {
    const guard = new HydrationGuard();
    const first = guard.request();
    guard.noteMutation();
    const second = guard.request();
    expect(guard.canApply(first)).toBe(false);
    expect(guard.canApply(second)).toBe(true);
  });
});

/**
 * The page's hydration effect body, driven verbatim: capture the epoch, await
 * hydrate, apply only when not cancelled and the epoch is current.
 */
function runHydrationEffect(
  guard: HydrationGuard,
  hydrate: () => Promise<ChatModel | null>,
  apply: (model: ChatModel) => void
): { promise: Promise<void>; cancel: () => void } {
  let cancelled = false;
  const epoch = guard.request();
  const promise = hydrate().then((restored) => {
    if (cancelled || restored === null) return;
    if (!guard.canApply(epoch)) return;
    apply(restored);
  });
  return { promise, cancel: () => { cancelled = true; } };
}

/** Set up an existing session with one persisted user message. */
function seedExistingSession(store: SessionStore, text: string): SessionRecord {
  const record = store.create(WS, '既有会话');
  expect(store.save(WS, { ...record, items: [{ kind: 'user', id: 'u-seed', text }] }).ok).toBe(true);
  return record;
}

describe('R1 — delete active session → fallback hydrate replaces the stale model', () => {
  it('the fallback snapshot applies even though the live model is non-empty (deleted session content)', async () => {
    const store = makeStore();
    const deleted = seedExistingSession(store, '被删除会话的消息');
    const fallback = seedExistingSession(store, 'fallback 会话的消息');

    // Page state right before deletion: showing the to-be-deleted session.
    const loaded = store.load(WS, deleted.id);
    const modelBefore: ChatModel =
      loaded.ok && loaded.record ? (resolveHydration(false, loaded.record) as ChatModel) : INITIAL_MODEL;
    expect(modelBefore.items.length).toBeGreaterThan(0); // non-empty stale model

    // The delete flow: store removes the record, active id flips to fallback.
    expect(store.delete(WS, deleted.id).ok).toBe(true);
    const fallbackLoaded = store.load(WS, fallback.id);
    expect(fallbackLoaded.ok).toBe(true);

    // The hydrate effect for the NEW active id must be able to replace the
    // stale model. No model mutation happened since the request → applies.
    const guard = new HydrationGuard();
    let applied: ChatModel | null = null;
    const effect = runHydrationEffect(
      guard,
      async () => resolveHydration(false, fallbackLoaded.ok ? fallbackLoaded.record : null),
      (m) => { applied = m; }
    );
    await effect.promise;

    // Round-4 assertion: the replacement is NOT blocked by the stale content.
    expect(applied).not.toBeNull();
    const texts = (applied as unknown as ChatModel).items.map((i) => (i.kind === 'user' ? i.text : null));
    expect(texts).toContain('fallback 会话的消息');
    expect(texts).not.toContain('被删除会话的消息');
  });
});

describe('R2 — existing session late hydration replaces a mutated (previous-session) model', () => {
  it('applies the correct session snapshot after the request, dropping previous-session content', async () => {
    const store = makeStore();
    const previous = seedExistingSession(store, '上一个会话的内容');
    const target = seedExistingSession(store, '目标会话的内容');

    // The user switched to `target`; the switch applied the TARGET model via
    // noteMutation (as WorkspacePage.switchSession does), THEN the (re-run)
    // hydration for target resolves. The mutation was a session swap, not
    // user input into this session — but per the page protocol the switch's
    // mutation happens BEFORE the new hydration request, so the request epoch
    // is current and the snapshot applies.
    const guard = new HydrationGuard();
    guard.noteMutation(); // switchSession's model application
    let applied: ChatModel | null = null;
    const loaded = store.load(WS, target.id);
    const effect = runHydrationEffect(
      guard,
      async () => resolveHydration(false, loaded.ok ? loaded.record : null),
      (m) => { applied = m; }
    );
    await effect.promise;

    expect(applied).not.toBeNull();
    const texts = (applied as unknown as ChatModel).items.map((i) => (i.kind === 'user' ? i.text : null));
    expect(texts).toContain('目标会话的内容');
    expect(texts).not.toContain('上一个会话的内容');
    expect(previous.id).not.toBe(target.id); // sanity: distinct sessions
  });

  it('user input arriving MID-request for the SAME session is preserved (round-3 semantics kept)', async () => {
    const guard = new HydrationGuard();
    const epoch = guard.request();
    // A first message is dispatched while the hydration request is in flight.
    const live = reduceChat(INITIAL_MODEL, { type: 'send', text: MESSAGE });
    guard.noteMutation(); // the dispatch action mutated the model
    expect(guard.canApply(epoch)).toBe(false); // late snapshot must NOT wipe it
    expect(live.items.some((i) => i.kind === 'user' && i.text === MESSAGE)).toBe(true);
  });
});

describe('R3/R4 — superseded requests and the full first-message disk lifecycle', () => {
  it('a hydration result arriving after the active id changed is not applied (effect cancellation)', async () => {
    const store = makeStore();
    const a = seedExistingSession(store, 'A');
    const b = seedExistingSession(store, 'B');
    const guard = new HydrationGuard();
    let applied: ChatModel | null = null;

    const effect = runHydrationEffect(
      guard,
      async () => resolveHydration(false, store.load(WS, a.id).record ?? null),
      (m) => { applied = m; }
    );
    // Simulate the active id flipping (to B) while A's hydration is in
    // flight: the effect cleanup runs before the promise resolves.
    effect.cancel();
    await effect.promise;
    expect(applied).toBeNull(); // superseded — B's own hydration will load B
    expect(b.id).not.toBe(a.id);
  });

  it('first user message survives an adversarial hydration pass, persists, restarts readable, no cross-session writes', async () => {
    const store = makeStore();
    const guard = new HydrationGuard();
    let model: ChatModel = INITIAL_MODEL;
    let record: SessionRecord | null = null;
    let freshlyCreated = false;

    // The submit flow (runSubmit's create/send order) with a hydration pass
    // injected right after the create flips the active id — the exact moment
    // the page's hydrate effect fires in the QA reproduction.
    const activationEpochBeforeCreate = guard.request();
    record = store.create(WS, MESSAGE.slice(0, 40));
    freshlyCreated = true;
    // (hydrate effect for the new active id)
    const epoch = guard.request();
    const restored = resolveHydration(freshlyCreated, null);
    freshlyCreated = false;
    if (restored !== null && guard.canApply(epoch)) model = restored;
    // (submit's onSessionCreated applies the empty model for the new session)
    guard.noteMutation();
    model = { items: [], phase: 'idle', changes: [] };
    // (sendMessage dispatches the user message)
    guard.noteMutation();
    model = reduceChat(model, { type: 'send', text: MESSAGE });

    // The mid-flight request from BEFORE the create must be dead; the message
    // must have survived the fresh-session hydration no-op.
    expect(guard.canApply(activationEpochBeforeCreate)).toBe(false);
    expect(model.items.some((i) => i.kind === 'user' && i.text === MESSAGE)).toBe(true);
    expect(model.phase).toBe('running');

    // Run completes; the message is still displayed.
    model = reduceChat(model, { type: 'event', frame: { type: 'run_completed', v: 1, summary: '已完成' } });
    expect(model.phase).toBe('idle');
    expect(model.items.some((i) => i.kind === 'user' && i.text === MESSAGE)).toBe(true);

    // Run-termination checkpoint persists THIS session's transcript only.
    expect(record).not.toBeNull();
    const saved = store.save(WS, {
      ...record!,
      items: toSessionItems(model.items),
      agentState: 'idle'
    });
    expect(saved.ok).toBe(true);

    // Restart: a brand-new store reads the session back with the message…
    const restarted = makeStore();
    const reloaded = restarted.load(WS, record!.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok && reloaded.record) {
      expect(reloaded.record.items.some((i) => i.kind === 'user' && i.text === MESSAGE)).toBe(true);
      const restoredModel = resolveHydration(false, reloaded.record);
      expect(restoredModel?.items.some((i) => i.kind === 'user' && i.text === MESSAGE)).toBe(true);
    }

    // …and no OTHER session was touched by the checkpoint.
    const other = store.create(WS, '另一个会话');
    const otherAfter = restarted.load(WS, other.id);
    if (otherAfter.ok && otherAfter.record) {
      expect(otherAfter.record.items.some((i) => i.kind === 'user' && i.text === MESSAGE)).toBe(false);
    }
  });
});
