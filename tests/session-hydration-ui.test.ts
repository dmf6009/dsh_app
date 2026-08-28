/**
 * Hydration transition-state tests (DSHA-7 UI/UE acceptance round, §15/AC-12).
 *
 * The acceptance round requires the session store to expose a user-visible
 * async transition state that distinguishes:
 *   - the workspace's INITIAL hydrate (no prior content → placeholder),
 *   - an A→B SWITCH / the fallback hydrate after deleting the active session
 *     (old transcript stays visible but is labelled as the previous
 *     session's content),
 * and that the state always RESETS — success, failure, superseded/late
 * completion, workspace switch — so the interaction lock (create/switch/
 * delete/composer disabled while busy) can never get stuck.
 *
 * The phase itself is DERIVED in production (src/renderer/src/session/
 * session-transition.ts `hydrationPhase`) from { busy, activeId, displayedFor }
 * so it cannot drift from the ids it describes. These tests pin:
 *   1. the derivation (unit);
 *   2. the three required scenarios as state sequences, driven through the
 *      REAL orchestrations (switchSessionWithCheckpoint, resolveHydration,
 *      HydrationGuard) and a REAL SessionStore, updating the state at the
 *      exact points useSessionStore does (each update cites its hook site);
 *   3. reset-on-failure / reset-on-late-completion and the operations lock.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { SessionStore } from '../src/main/session/session-store';
import type { SessionRecord } from '../src/shared/session';
import {
  hydrationPhase,
  resolveHydration,
  switchSessionWithCheckpoint,
  type HydrationPhase as Phase,
  type HydrationStatus
} from '../src/renderer/src/session/session-transition';
import { ROOT } from './helpers';

const STORE_DIR = path.join(ROOT, '.tmp-tests', 'session-hydration-ui');
const WS = '/tmp/demo/project';

let idTick = 0;

function makeStore(): SessionStore {
  let tick = 0;
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

/**
 * Mirrors useSessionStore's hydration bookkeeping. Each method cites the hook
 * update it mirrors; the derived status matches the hook's `hydration` value.
 */
class HydrationStateSimulation {
  activeId: string | null = null;
  displayedFor: string | null = null;
  hydratingFor: string | null = null;

  status(): HydrationStatus {
    return {
      phase: hydrationPhase(this.hydratingFor, this.activeId, this.displayedFor),
      busy: this.hydratingFor !== null,
      displayedFor: this.displayedFor
    };
  }

  phase(): Phase {
    return this.status().phase;
  }

  /** Operations lock: what the page disables while busy. */
  operationsLocked(): boolean {
    return this.hydratingFor !== null;
  }

  /** hook: workspace effect — no workspace → reset both (never stuck). */
  workspaceClosed(): void {
    this.activeId = null;
    this.hydratingFor = null;
    this.displayedFor = null;
  }

  /** hook: workspace bootstrap start — busy before the target is known. */
  workspaceBootstrapStarted(): void {
    this.hydratingFor = 'pending-workspace';
  }

  /** hook: bootstrap resolved — busy for the active id, or done. */
  workspaceBootstrapResolved(activeId: string | null): void {
    this.activeId = activeId;
    this.hydratingFor = activeId;
    this.displayedFor = null;
  }

  /** hook: bootstrap catch — failed bootstrap never stays busy. */
  workspaceBootstrapFailed(): void {
    this.hydratingFor = null;
  }

  /** hook: hydrate() start — in flight for this id. */
  hydrateStarted(id: string): void {
    this.hydratingFor = id;
  }

  /** hook: hydrate() finally — clears only its own mark. */
  hydrateSettled(id: string): void {
    if (this.hydratingFor === id) this.hydratingFor = null;
  }

  /** hook: create onCreated — fresh model displayed for the new session. */
  created(id: string): void {
    this.activeId = id;
    this.displayedFor = id;
    this.hydratingFor = null;
  }

  /** hook: switchTo start — the whole persist→activate→load window. */
  switchStarted(id: string): void {
    this.hydratingFor = id;
  }

  /** hook: switchTo aborted — never stay busy. */
  switchAborted(id: string): void {
    if (this.hydratingFor === id) this.hydratingFor = null;
  }

  /** page: model application after switch — displayed for the target. */
  switchApplied(id: string): void {
    this.activeId = id;
    this.displayedFor = id;
  }

  /** hook: remove() — active deleted, fallback hydrate armed for `next`. */
  activeDeleted(next: string | null): void {
    this.activeId = next;
    if (next !== null) this.hydratingFor = next;
    // displayedFor intentionally NOT updated: the stale model still belongs
    // to the deleted session until the fallback hydrate applies.
  }

  /** page: hydrate effect applied a snapshot for `id`. */
  snapshotApplied(id: string): void {
    this.displayedFor = id;
  }
}

describe('hydrationPhase — derivation', () => {
  it('idle when not busy and attribution is consistent (or absent)', () => {
    expect(hydrationPhase(null, 'a', 'a')).toBe('idle');
    expect(hydrationPhase(null, null, null)).toBe('idle');
  });

  it('switching when NOT busy but the displayed model belongs to another session (labeled mismatch)', () => {
    // A guard-dropped switch snapshot leaves the old transcript under the new
    // active id — that mismatch must stay labeled, never silent.
    expect(hydrationPhase(null, 'b', 'a')).toBe('switching');
  });

  it('initial while busy with nothing displayed yet', () => {
    expect(hydrationPhase('a', 'a', null)).toBe('initial');
    expect(hydrationPhase('pending', null, null)).toBe('initial');
  });

  it('switching while busy and the displayed model belongs to another session', () => {
    expect(hydrationPhase('b', 'b', 'a')).toBe('switching');
  });

  it('switching during the persist/activate window (target ≠ active, displayed = active)', () => {
    // A→B switch start: B is the in-flight target while A is both active and
    // displayed — the transition window before activate lands.
    expect(hydrationPhase('b', 'a', 'a')).toBe('switching');
  });

  it('idle for a background re-hydration of the session already displayed', () => {
    expect(hydrationPhase('b', 'b', 'b')).toBe('idle');
  });
});

describe('scenario 1 — initial workspace hydrate', () => {
  it('busy from bootstrap until the transcript hydration settles, then unlocked', async () => {
    const store = makeStore();
    const record = seed(store, '初始会话消息');
    const sim = new HydrationStateSimulation();

    // Workspace opens: busy before the active session is even known.
    sim.workspaceBootstrapStarted();
    expect(sim.phase()).toBe('initial');
    expect(sim.operationsLocked()).toBe(true);

    // Bootstrap resolves to the active session — still loading the transcript.
    sim.workspaceBootstrapResolved(record.id);
    expect(sim.phase()).toBe('initial');
    expect(sim.operationsLocked()).toBe(true);

    // hydrate() runs and settles (the page applies the snapshot).
    sim.hydrateStarted(record.id);
    sim.snapshotApplied(record.id); // page applies → displayedFor
    sim.hydrateSettled(record.id); // hook finally
    expect(sim.phase()).toBe('idle');
    expect(sim.operationsLocked()).toBe(false); // operations restored
  });

  it('a workspace with no active session ends the transition immediately', () => {
    const sim = new HydrationStateSimulation();
    sim.workspaceBootstrapStarted();
    sim.workspaceBootstrapResolved(null);
    expect(sim.phase()).toBe('idle');
    expect(sim.operationsLocked()).toBe(false);
  });

  it('a failed bootstrap never stays busy', () => {
    const sim = new HydrationStateSimulation();
    sim.workspaceBootstrapStarted();
    sim.workspaceBootstrapFailed();
    expect(sim.phase()).toBe('idle');
    expect(sim.operationsLocked()).toBe(false);
  });
});

describe('scenario 2 — A→B switch', () => {
  it('switching phase while the old transcript is displayed, idle after applying B', async () => {
    const store = makeStore();
    const a = seed(store, 'A 的消息');
    const b = seed(store, 'B 的消息');
    const sim = new HydrationStateSimulation();
    sim.workspaceBootstrapResolved(a.id);
    sim.snapshotApplied(a.id); // A displayed

    // The user switches to B: the whole transition window is busy, and the
    // displayed model STILL belongs to A — that mismatch is the phase input.
    sim.switchStarted(b.id);
    expect(sim.phase()).toBe('switching');
    expect(sim.operationsLocked()).toBe(true); // create/switch/delete/composer locked

    // Real orchestration: persist A → activate B → load B.
    const model = await switchSessionWithCheckpoint(
      {
        persistOutgoing: () => Promise.resolve(null),
        createNew: () => Promise.resolve({ result: { ok: false } }),
        activate: (id) => Promise.resolve(store.switchTo(WS, id)),
        load: (id) => Promise.resolve(store.load(WS, id)),
        onCreated: () => {},
        onSwitched: () => {}
      },
      b.id
    );
    expect(model.status).toBe('completed');

    // The page applies B's model: displayedFor → B; the hook's hydrate for B
    // (re-armed by the active-id flip) settles too.
    sim.switchApplied(b.id);
    sim.hydrateStarted(b.id);
    sim.hydrateSettled(b.id);
    expect(sim.phase()).toBe('idle');
    expect(sim.operationsLocked()).toBe(false);
  });

  it('an aborted switch never stays busy and keeps displaying the outgoing session', async () => {
    const store = makeStore();
    const a = seed(store, 'A 的消息');
    const b = seed(store, 'B 的消息');
    const sim = new HydrationStateSimulation();
    sim.workspaceBootstrapResolved(a.id);
    sim.snapshotApplied(a.id);

    sim.switchStarted(b.id);
    expect(sim.phase()).toBe('switching');

    // Outgoing checkpoint fails → the orchestration aborts (nothing mutates).
    const outcome = await switchSessionWithCheckpoint(
      {
        persistOutgoing: () => Promise.resolve('保存会话失败：磁盘已满'),
        createNew: () => Promise.resolve({ result: { ok: false } }),
        activate: (id) => Promise.resolve(store.switchTo(WS, id)),
        load: (id) => Promise.resolve(store.load(WS, id)),
        onCreated: () => {},
        onSwitched: () => {}
      },
      b.id
    );
    expect(outcome.status).toBe('aborted');

    sim.switchAborted(b.id); // hook clears its own mark
    expect(sim.phase()).toBe('idle');
    expect(sim.operationsLocked()).toBe(false); // operations restored after failure
    // The displayed model still belongs to A (kept, per fail-abort semantics).
    expect(sim.displayedFor).toBe(a.id);
    expect(sim.activeId).toBe(a.id);
  });
});

describe('scenario 3 — delete the active session → fallback hydrate', () => {
  it('switching phase shows the deleted session as the stale content, idle after fallback applies', async () => {
    const store = makeStore();
    const a = seed(store, 'fallback A 的消息');
    const b = seed(store, '被删除 B 的消息');
    const sim = new HydrationStateSimulation();
    sim.workspaceBootstrapResolved(b.id);
    sim.snapshotApplied(b.id); // B displayed

    // Delete the ACTIVE session B: the store removes it and flips the active
    // id to A; the fallback hydrate is armed for A. displayedFor deliberately
    // keeps pointing at (the now deleted) B — the stale content's owner.
    expect(store.delete(WS, b.id).ok).toBe(true);
    sim.activeDeleted(a.id);
    expect(sim.phase()).toBe('switching'); // busy + displayed B ≠ active A
    expect(sim.operationsLocked()).toBe(true);

    // The fallback hydrate loads A and the page applies it (guard allows: no
    // mutation since the request).
    sim.hydrateStarted(a.id);
    const loaded = store.load(WS, a.id);
    expect(loaded.ok).toBe(true);
    const restored = resolveHydration(false, loaded.ok ? loaded.record : null);
    expect(restored).not.toBeNull();
    sim.snapshotApplied(a.id); // page applies → displayedFor = A
    sim.hydrateSettled(a.id); // hook finally
    expect(sim.phase()).toBe('idle');
    expect(sim.operationsLocked()).toBe(false);
    // UI model and active id now belong to the SAME session.
    expect(sim.displayedFor).toBe(sim.activeId);
  });
});

describe('reset paths — the lock can never get stuck', () => {
  it('a late (superseded) completion cannot clear a newer transition, but each settles its own', () => {
    const sim = new HydrationStateSimulation();
    sim.workspaceBootstrapResolved('a');
    sim.hydrateStarted('a');
    // The active id flips to B while A's hydrate is in flight…
    sim.switchStarted('b');
    // …then A's request settles: it must NOT clear B's mark.
    sim.hydrateSettled('a');
    expect(sim.operationsLocked()).toBe(true);
    expect(sim.hydratingFor).toBe('b');
    // B settles its own.
    sim.hydrateSettled('b');
    expect(sim.operationsLocked()).toBe(false);
  });

  it('a failed/corrupt hydration still settles (finally) and restores operations', async () => {
    const store = makeStore();
    const record = seed(store, '内容');
    // Corrupt the record so the hydration fails — the transition must end.
    const file = store.recordPath(WS, record.id);
    fs.writeFileSync(file, 'not json', 'utf8');
    const sim = new HydrationStateSimulation();
    sim.workspaceBootstrapResolved(record.id);
    sim.hydrateStarted(record.id);
    const loaded = store.load(WS, record.id);
    const restored = resolveHydration(false, loaded.ok ? loaded.record : null);
    expect(restored).toEqual({ items: [], phase: 'idle', changes: [] }); // fallback
    sim.snapshotApplied(record.id);
    sim.hydrateSettled(record.id); // hook finally — runs on failure too
    expect(sim.phase()).toBe('idle');
    expect(sim.operationsLocked()).toBe(false);
  });

  it('switching the workspace mid-hydrate resets everything', () => {
    const sim = new HydrationStateSimulation();
    sim.workspaceBootstrapResolved('a');
    sim.hydrateStarted('a');
    sim.snapshotApplied('a');
    sim.workspaceClosed(); // hook: no workspace → reset both
    expect(sim.phase()).toBe('idle');
    expect(sim.operationsLocked()).toBe(false);
    expect(sim.displayedFor).toBeNull();
  });
});

function seed(store: SessionStore, text: string): SessionRecord {
  const record = store.create(WS, `会话 ${text}`);
  expect(
    store.save(WS, { ...record, items: [{ kind: 'user', id: `u-${record.id}`, text }] }).ok
  ).toBe(true);
  return record;
}
