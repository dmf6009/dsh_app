/**
 * Real-hook hydration lifecycle tests (DSHA-7 UI/UE round, review follow-up).
 *
 * These mount the REAL `useSessionStore` + the REAL page hydration wiring
 * (`useSessionHydration`, extracted 1:1 from WorkspacePage's effect) via
 * react-test-renderer, driving a fully controllable fake `window.desktop`
 * whose promises are deferred by hand. This pins the exact production
 * ordering the review flagged, which the previous hand-written simulation
 * had silently inverted:
 *
 *   settle ownership — busy must NOT end inside hydrate(); it ends in the
 *   caller's `.finally`, AFTER the apply/drop decision (guard/cancelled);
 *
 *   workspace identity isolation — entering a new workspace immediately
 *   resets the old workspace's active id/title/displayedFor/base, including
 *   on the bootstrap FAILURE path (a stale A identity must never survive
 *   into workspace B, where a later flush could carry it under B's root);
 *
 *   superseded loads are dropped inside hydrate() itself (cancelledHydration
 *   ref), independent of the page-side guard.
 *
 * Scenarios (the review's required list): initial hydrate, A→B switch,
 * delete-active → fallback, guard-rejected result, A→B workspace success
 * and A→B workspace failure — each asserting busy/phase, the operations
 * lock, the displayed attribution, and the final identity.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { SessionRecord, SessionSummary } from '../src/shared/session';
import { useSessionStore } from '../src/renderer/src/session/session-store';
import { useSessionHydration } from '../src/renderer/src/session/use-session-hydration';
import { HydrationGuard } from '../src/renderer/src/session/session-transition';
import { INITIAL_MODEL, type ChatModel } from '../src/renderer/src/chat/model';
import type { DesktopApi } from '../src/shared/desktop-api';

/* ---- fake desktop with hand-deferred promises -------------------------- */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function summary(id: string, title: string): SessionSummary {
  return { id, title, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', active: false };
}

function record(id: string, title: string, text: string): SessionRecord {
  return {
    schemaVersion: 1,
    id,
    workspaceRoot: '/ws/a',
    title,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: null,
    agentState: 'idle',
    tokenUsage: null,
    items: [{ kind: 'user', id: `u-${id}`, text }]
  };
}

class FakeDesktop {
  /** Deferreds for the calls the bootstrap makes; created on demand. */
  listDeferred = deferred<SessionSummary[]>();
  activeDeferred = deferred<{ id: string | null }>();
  /** Deferreds for loadSession — a FIFO queue per id, because a switch
   *  issues TWO loads for the target (the orchestration's load + the page
   *  effect's hydrate) that must be resolvable independently. */
  loadQueue = new Map<string, Array<Deferred<{ ok: boolean; record?: SessionRecord }>>>();
  /** Deferred for the next switchSession call. */
  switchDeferred = deferred<{ ok: boolean; id?: string; error?: string }>();
  /** Deferred for the next deleteSession call. */
  deleteDeferred = deferred<{ ok: boolean; id?: string; error?: string }>();
  /** Deferreds for saveSession (the switch checkpoint), FIFO. */
  saves: Array<Deferred<{ ok: boolean; id?: string }>> = [];
  /** Records deleted via deleteSession. */
  deleted: string[] = [];
  /** The summaries the next listSessions returns (mutated by delete). */
  list: SessionSummary[] = [];
  /** The active id getActiveSessionId reports. */
  activeId: string | null = null;
  failList = false;

  api(): DesktopApi {
    return this as unknown as DesktopApi;
  }

  // The subset of DesktopApi the hook touches.
  async listSessions(): Promise<SessionSummary[]> {
    return this.listDeferred.promise;
  }

  async getActiveSessionId(): Promise<{ id: string | null }> {
    return this.activeDeferred.promise;
  }

  async loadSession(id: string): Promise<{ ok: boolean; record?: SessionRecord }> {
    const queue = this.loadQueue.get(id) ?? [];
    const d = deferred<{ ok: boolean; record?: SessionRecord }>();
    queue.push(d);
    this.loadQueue.set(id, queue);
    return d.promise;
  }

  async saveSession(_record: SessionRecord): Promise<{ ok: boolean; id?: string; error?: string }> {
    const d = deferred<{ ok: boolean; id?: string }>();
    this.saves.push(d);
    return d.promise;
  }

  async switchSession(id: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    this.activeId = id;
    return this.switchDeferred.promise;
  }

  async deleteSession(id: string): Promise<{ ok: boolean; id?: string; error?: string }> {
    this.deleted.push(id);
    this.list = this.list.filter((s) => s.id !== id);
    if (this.activeId === id) this.activeId = this.list[0]?.id ?? null;
    return this.deleteDeferred.promise;
  }

  /** Arm the next bootstrap round (new deferreds). */
  armBootstrap(fail = false): void {
    this.failList = fail;
    this.listDeferred = deferred<SessionSummary[]>();
    this.activeDeferred = deferred<{ id: string | null }>();
    if (fail) {
      this.listDeferred.promise.catch(() => undefined);
      this.listDeferred.reject(new Error('ipc unavailable'));
    }
  }

  resolveBootstrap(list: SessionSummary[], activeId: string | null): void {
    this.listDeferred.resolve(list);
    this.activeDeferred.resolve({ id: activeId });
  }

  /** Resolve the OLDEST pending load for `id` (FIFO). */
  resolveNextLoad(id: string, rec: SessionRecord | null): void {
    const queue = this.loadQueue.get(id);
    const d = queue?.shift();
    if (d) d.resolve(rec ? { ok: true, record: rec } : { ok: false });
  }

  /** Resolve ALL pending loads for `id`. */
  resolveLoad(id: string, rec: SessionRecord | null): void {
    const queue = this.loadQueue.get(id) ?? [];
    queue.splice(0).forEach((d) => d.resolve(rec ? { ok: true, record: rec } : { ok: false }));
  }
}

/* ---- harness: real hooks, fake desktop --------------------------------- */

interface Probe {
  // SessionStoreValue snapshot taken on every render.
  activeId: string | null;
  busy: boolean;
  phase: string;
  displayedFor: string | null;
  model: ChatModel;
  /** busy as observed AT THE MOMENT the hydration result was applied — pins
   *  the settle-ownership order (apply decision BEFORE unlock). */
  busyAtLastApply: boolean | null;
}

function mountHarness(
  desktop: FakeDesktop,
  initialWorkspace: string | null,
  onWorkspaceChange: (root: string | null) => void,
  opts: { hookOnly?: boolean } = {}
): {
  renderer: ReactTestRenderer;
  probe: () => Probe;
  rerender: (root: string | null) => void;
  guard: HydrationGuard;
  setModel: (m: ChatModel) => void;
  sessions: () => ReturnType<typeof useSessionStore>;
  order: string[];
} {
  /** Ordered log of the hydration protocol's observable calls. */
  const order: string[] = [];
  let busyAtLastApply: boolean | null = null;
  let probe: Probe = {
    activeId: null,
    busy: false,
    phase: 'idle',
    displayedFor: null,
    model: INITIAL_MODEL,
    busyAtLastApply: null
  };
  const guard = new HydrationGuard();
  let setModelRef: (m: ChatModel) => void = () => undefined;
  let sessionsRef: ReturnType<typeof useSessionStore> | null = null;

  function Harness({ workspaceRoot }: { workspaceRoot: string | null }): JSX.Element | null {
    const sessions = useSessionStore(workspaceRoot);
    const [model, setModel] = React.useState<ChatModel>(INITIAL_MODEL);
    setModelRef = setModel;
    sessionsRef = sessions;
    const guardRef = React.useRef<HydrationGuard>(guard);
    // Wrap setModel to observe the busy state AT the apply decision — the
    // settle-ownership order under test (busy must still be true here).
    // The workspace-reset clear (setModel(INITIAL_MODEL) from the epoch
    // effect) is a model MUTATION, not a hydration apply — excluded from the
    // order/busy probes by identity (INITIAL_MODEL is the shared constant).
    const applyModel = (m: ChatModel): void => {
      if (m !== INITIAL_MODEL) {
        order.push('apply');
        busyAtLastApply = sessions.hydration.busy;
      }
      setModel(m);
    };
    // Stable spy over the hook's settle: records WHEN the caller settles.
    const settleSpy = React.useCallback(
      (id: string | null) => {
        order.push('settle');
        sessions.settleHydration(id);
      },
      // The hook's settleHydration is a stable useCallback; capturing the
      // first render's binding is intentional for the order spy.
      []
    );
    if (!opts.hookOnly) {
      useSessionHydration({ ...sessions, settleHydration: settleSpy }, applyModel, guardRef);
    }
    probe = {
      activeId: sessions.activeId,
      busy: sessions.hydration.busy,
      phase: sessions.hydration.phase,
      displayedFor: sessions.hydration.displayedFor,
      model,
      busyAtLastApply
    };
    return null;
  }

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(Harness, { workspaceRoot: initialWorkspace }));
  });
  return {
    renderer,
    probe: () => probe,
    rerender: (root: string | null) => {
      onWorkspaceChange(root);
      act(() => {
        renderer.update(React.createElement(Harness, { workspaceRoot: root }));
      });
    },
    guard,
    setModel: (m: ChatModel) => {
      act(() => setModelRef(m));
    },
    sessions: () => sessionsRef!,
    order
  };
}

/** Flush microtasks (the deferred chains settle across several ticks). */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let originalDesktop: unknown;

beforeEach(() => {
  originalDesktop = (globalThis as { window?: { desktop?: unknown } }).window?.desktop;
  (globalThis as { window: unknown }).window = { desktop: undefined };
});

afterEach(() => {
  if (originalDesktop === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window: { desktop?: unknown } }).window = { desktop: originalDesktop };
  }
});

describe('initial workspace hydrate — real hook', () => {
  it('busy from bootstrap through the apply decision, then unlocked with the snapshot applied', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined);

    // Bootstrap in flight: busy, initial, locked.
    expect(h.probe().busy).toBe(true);
    expect(h.probe().phase).toBe('initial');

    desktop.resolveBootstrap([summary('s1', '会话一')], 's1');
    await flush();
    // Active id known, transcript load still in flight: busy, initial.
    expect(h.probe().activeId).toBe('s1');
    expect(h.probe().busy).toBe(true);
    expect(h.probe().phase).toBe('initial');

    // Resolve the load — the decision (apply + attribution) and the settle
    // both happen before the probe can observe an unlocked state with the
    // model NOT yet applied (settle ownership: apply first, then unlock).
    desktop.resolveLoad('s1', record('s1', '会话一', '第一条消息'));
    await flush();
    // Settle ownership: the apply decision ran while STILL busy — the unlock
    // (settle) happens only after it.
    expect(h.probe().busyAtLastApply).toBe(true);
    expect(h.probe().busy).toBe(false); // unlocked only after the decision
    // The caller's protocol order: apply decision FIRST, settle after (a
    // re-render may idempotently re-apply the same snapshot; the ORDER is
    // the property under test, not the count).
    const protocol = h.order.filter((e) => e === 'apply' || e === 'settle');
    expect(protocol[0]).toBe('apply');
    expect(protocol[protocol.length - 1]).toBe('settle');
    expect(h.probe().phase).toBe('idle');
    expect(h.probe().displayedFor).toBe('s1');
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === '第一条消息')).toBe(true);
  });

  it('a workspace with no active session ends the transition without a load', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined);
    desktop.resolveBootstrap([], null);
    await flush();
    expect(h.probe().busy).toBe(false);
    expect(h.probe().phase).toBe('idle');
  });

  it('a failed bootstrap leaves NO stale identity and never stays busy', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap(true);
    const h = mountHarness(desktop, '/ws/a', () => undefined);
    await flush();
    expect(h.probe().busy).toBe(false);
    expect(h.probe().activeId).toBeNull(); // no stale id survives a failure
    expect(h.probe().displayedFor).toBeNull();
    expect(h.probe().phase).toBe('idle');
  });
});

describe('A→B switch — driven through the REAL sessions.switchTo()', () => {
  it('busy from switch start through B\'s apply; A stays attributed until the decision', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined);
    desktop.resolveBootstrap([summary('a', 'A'), summary('b', 'B')], 'a');
    await flush();
    desktop.resolveLoad('a', record('a', 'A', 'A 的内容'));
    await flush();
    expect(h.probe().displayedFor).toBe('a');
    expect(h.probe().busy).toBe(false);

    // The page calls switchTo(b) — the REAL store API. Nothing resolves yet,
    // so every window below is observed at a deterministic point.
    let switchDone = false;
    const switched = act(async () => {
      await h.sessions().switchTo('b', h.probe().model, {
        model: null,
        phase: 'idle',
        tokenUsage: null,
        workspaceRoot: '/ws/a'
      });
      switchDone = true;
    });
    await flush(1);
    // Window 1 — outgoing checkpoint (persist → loadSession(a) → saveSession):
    // busy for B while A is still both active and displayed.
    expect(switchDone).toBe(false);
    expect(h.probe().busy).toBe(true);
    expect(h.probe().phase).toBe('switching');
    expect(h.probe().activeId).toBe('a');
    expect(h.probe().displayedFor).toBe('a');

    // Checkpoint succeeds (persist's base load + save + activate)…
    desktop.resolveNextLoad('a', record('a', 'A', 'A 的内容'));
    await flush(1);
    desktop.saves.forEach((d) => d.resolve({ ok: true }));
    desktop.switchDeferred.resolve({ ok: true, id: 'b' });
    await flush(2);
    // …switchTo now awaits the orchestration's load of B (still pending).
    expect(switchDone).toBe(false);

    // Resolve it: onSwitched flips the active id to B and switchTo returns.
    // The page effect's hydrate for B is now in flight (its OWN load call),
    // while the displayed transcript is STILL A's — attributed to A (labelled
    // "切换前会话", not mistaken for the new selection).
    desktop.resolveNextLoad('b', record('b', 'B', 'B 的内容'));
    await switched;
    await flush(1);
    expect(h.probe().busy).toBe(true);
    expect(h.probe().phase).toBe('switching');
    expect(h.probe().activeId).toBe('b');
    expect(h.probe().displayedFor).toBe('a');

    // Resolve the page hydrate's load of B: apply, then settle.
    desktop.resolveNextLoad('b', record('b', 'B', 'B 的内容'));
    await flush();
    expect(h.probe().busy).toBe(false);
    expect(h.probe().phase).toBe('idle');
    expect(h.probe().activeId).toBe('b');
    expect(h.probe().displayedFor).toBe('b');
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'B 的内容')).toBe(true);
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'A 的内容')).toBe(false);
  });

  it('a failed outgoing checkpoint aborts the switch: no id flip, no unlock window, A intact', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined);
    desktop.resolveBootstrap([summary('a', 'A'), summary('b', 'B')], 'a');
    await flush();
    desktop.resolveLoad('a', record('a', 'A', 'A 的内容'));
    await flush();

    // The page calls switchTo(b); the outgoing checkpoint FAILS.
    let switchResult: ChatModel | null | undefined;
    const switched = act(async () => {
      switchResult = await h.sessions().switchTo('b', h.probe().model, {
        model: null,
        phase: 'idle',
        tokenUsage: null,
        workspaceRoot: '/ws/a'
      });
    });
    await flush(1);
    expect(h.probe().busy).toBe(true); // locked during the checkpoint attempt
    desktop.resolveNextLoad('a', record('a', 'A', 'A 的内容')); // persist's base load
    await flush(1);
    desktop.saves.forEach((d) => d.resolve({ ok: false })); // checkpoint fails
    await switched;
    await flush();

    expect(switchResult).toBeNull(); // aborted — the caller keeps the current model
    expect(h.probe().activeId).toBe('a'); // never flipped
    expect(h.probe().displayedFor).toBe('a');
    expect(h.probe().busy).toBe(false); // never stuck
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'A 的内容')).toBe(true);
  });
});

describe('delete active session → fallback hydrate — driven through the REAL sessions.remove()', () => {
  it('fallback A replaces the deleted B: switching window attributed to B, then A applies and unlocks', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined);
    desktop.resolveBootstrap([summary('a', 'A'), summary('b', 'B')], 'b');
    await flush();
    desktop.resolveLoad('b', record('b', 'B', 'B 的内容'));
    await flush();
    expect(h.probe().displayedFor).toBe('b');

    // The page calls remove(b) — the REAL store API. Arm a fresh list for
    // remove()'s post-delete re-list (the bootstrap's deferred is spent).
    // The fallback load of A stays PENDING so the window is observable.
    desktop.listDeferred = deferred<SessionSummary[]>();
    const removing = act(async () => {
      const err = await h.sessions().remove('b');
      expect(err).toBeNull(); // delete succeeded
    });
    await flush(1);
    desktop.deleteDeferred.resolve({ ok: true, id: 'b' });
    desktop.listDeferred.resolve([summary('a', 'A')]);
    await removing;
    await flush(1);

    // After the delete: the active id is the fallback A, the fallback
    // hydration is armed, and the displayed content still belongs to the
    // DELETED session B — labelled "切换前会话" until A applies.
    expect(desktop.deleted).toEqual(['b']);
    expect(h.probe().activeId).toBe('a');
    expect(h.probe().busy).toBe(true);
    expect(h.probe().phase).toBe('switching');
    expect(h.probe().displayedFor).toBe('b');

    // Resolve the fallback hydrate's load of A: apply, then settle.
    desktop.resolveNextLoad('a', record('a', 'A', 'A 的内容'));
    await flush();
    expect(h.probe().busy).toBe(false);
    expect(h.probe().phase).toBe('idle');
    expect(h.probe().displayedFor).toBe('a');
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'A 的内容')).toBe(true);
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'B 的内容')).toBe(false);
  });
});

describe('guard-rejected result — settle AFTER the drop decision', () => {
  it('a result rejected by the guard still settles (unlock) but does not touch attribution or model', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined);
    desktop.resolveBootstrap([summary('s1', '会话一')], 's1');
    await flush();
    expect(h.probe().busy).toBe(true);

    // A non-hydration mutation lands while the load is in flight — the guard
    // will reject the snapshot. In the page this is a dispatched message.
    h.guard.noteMutation();
    desktop.resolveLoad('s1', record('s1', '会话一', '不应被应用的快照'));
    await flush();

    // The drop decision was made; the transition settled (unlocked)…
    expect(h.probe().busy).toBe(false);
    expect(h.probe().phase).toBe('idle');
    // Protocol order on a drop: NO apply ever, settle after the decision.
    const protocol = h.order.filter((e) => e === 'apply' || e === 'settle');
    expect(protocol).not.toContain('apply');
    expect(protocol).toContain('settle');
    // …but the model was NOT replaced and attribution was NOT updated.
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === '不应被应用的快照')).toBe(false);
    expect(h.probe().displayedFor).toBeNull();
    // With no attribution recorded there is no active-id/foreign-transcript
    // pair to mismatch — the labeled-mismatch invariant holds vacuously here.
    expect(h.probe().phase).toBe('idle');
  });

  it('a guard-dropped SWITCH snapshot leaves the old transcript ATTRIBUTED (labeled, never silent)', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined);
    desktop.resolveBootstrap([summary('a', 'A'), summary('b', 'B')], 'a');
    await flush();
    desktop.resolveNextLoad('a', record('a', 'A', 'A 的内容'));
    await flush();
    expect(h.probe().displayedFor).toBe('a');

    // Drive a REAL switch to B whose final load is guard-rejected: the
    // orchestration's load resolves (switch completes, id flips to B), but a
    // mutation between the page effect's request and its own load rejects
    // the apply — the transcript stays A's, still attributed to A.
    const switched = act(async () => {
      await h.sessions().switchTo('b', h.probe().model, {
        model: null,
        phase: 'idle',
        tokenUsage: null,
        workspaceRoot: '/ws/a'
      });
    });
    await flush(1);
    desktop.resolveNextLoad('a', record('a', 'A', 'A 的内容')); // persist base
    await flush(1);
    desktop.saves.forEach((d) => d.resolve({ ok: true }));
    desktop.switchDeferred.resolve({ ok: true, id: 'b' });
    await flush(3); // switchTo parks awaiting the orchestration's load of B

    // Resolve the orchestration's load: the switch completes (id flips to B)
    // and the page effect issues ITS OWN hydration request for B.
    desktop.resolveNextLoad('b', record('b', 'B', 'B 的内容'));
    await switched;
    await flush(3); // the effect's request is now in flight (its load pending)

    // A mutation lands between the effect's request and its result —
    // the guard will REJECT the apply.
    h.guard.noteMutation();
    desktop.resolveNextLoad('b', record('b', 'B', 'B 的内容'));
    await flush();

    expect(h.probe().activeId).toBe('b'); // the switch itself completed
    expect(h.probe().busy).toBe(false); // the transition settled
    // The displayed transcript is still A's — and the phase LABELS that
    // mismatch instead of silently presenting A's content under B's id.
    expect(h.probe().displayedFor).toBe('a');
    expect(h.probe().phase).toBe('switching');
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'A 的内容')).toBe(true);
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'B 的内容')).toBe(false);
  });
});

describe('settle ownership — hydrate() itself never unlocks (real hook, no page wiring)', () => {
  it('a bare hydrate() call leaves busy set; only the caller settle unlocks', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    // Mount WITHOUT useSessionHydration: the hook's contract is under test in
    // isolation — the busy mark must survive hydrate() resolving, because the
    // settle decision belongs to the caller.
    const h = mountHarness(desktop, '/ws/a', () => undefined, { hookOnly: true });
    desktop.resolveBootstrap([summary('s1', '会话一')], 's1');
    await flush();

    // The caller (page) starts a hydration request manually; its load is
    // pending until we resolve it (the FIFO queue arms per call).
    let restored: unknown = 'unsettled';
    const hydrating = act(async () => {
      restored = await h.sessions().hydrate();
    });
    await flush(1);
    desktop.resolveNextLoad('s1', record('s1', '会话一', '内容'));
    await hydrating;
    // hydrate() resolved with the snapshot… but busy is STILL SET — the caller
    // has not yet made its apply/drop decision, so the transition must not end.
    expect(restored).not.toBeNull();
    expect(h.sessions().hydration.busy).toBe(true);

    // The caller applies the result and then settles by request identity.
    h.sessions().settleHydration('s1');
    await flush();
    expect(h.sessions().hydration.busy).toBe(false);
  });

  it('a settle with a foreign request id cannot unlock the current transition', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined, { hookOnly: true });
    desktop.resolveBootstrap([summary('s1', '会话一')], 's1');
    await flush();
    const hydrating = act(async () => {
      await h.sessions().hydrate();
    });
    await flush(1);
    desktop.resolveNextLoad('s1', record('s1', '会话一', '内容'));
    await hydrating;
    expect(h.sessions().hydration.busy).toBe(true);
    // A late settle for some OTHER id must not clear s1's transition.
    h.sessions().settleHydration('some-other-id');
    await flush();
    expect(h.sessions().hydration.busy).toBe(true);
    h.sessions().settleHydration('s1');
    await flush();
    expect(h.sessions().hydration.busy).toBe(false);
  });
});

describe('A workspace → B workspace — identity isolation (real hook)', () => {
  it('success: B boots with no trace of A, and A resolves its own load only for A', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    let currentRoot: string | null = '/ws/a';
    const h = mountHarness(desktop, currentRoot, (root) => {
      currentRoot = root;
    });
    desktop.resolveBootstrap([summary('a1', 'A 的会话')], 'a1');
    await flush();
    desktop.resolveLoad('a1', record('a1', 'A 的会话', 'A 的内容'));
    await flush();
    expect(h.probe().displayedFor).toBe('a1');
    expect(h.probe().busy).toBe(false);

    // Switch the workspace to B: the harness re-renders with the new root.
    desktop.armBootstrap();
    h.rerender('/ws/b');
    // IMMEDIATELY after entering B (before its bootstrap resolves): no A
    // identity may remain — not the active id, not the attribution, and NOT
    // A's TRANSCRIPT either (the page clears the displayed model on the
    // workspace epoch bump, so B never shows A's content).
    expect(h.probe().activeId).toBeNull();
    expect(h.probe().displayedFor).toBeNull();
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'A 的内容')).toBe(false);
    expect(h.probe().busy).toBe(true); // B's own bootstrap in flight
    expect(h.probe().phase).toBe('initial');

    desktop.resolveBootstrap([summary('b1', 'B 的会话')], 'b1');
    await flush();
    desktop.resolveLoad('b1', { ...record('b1', 'B 的会话', 'B 的内容'), workspaceRoot: '/ws/b' });
    await flush();
    expect(h.probe().busyAtLastApply).toBe(true); // decision precedes unlock
    expect(h.probe().activeId).toBe('b1');
    expect(h.probe().displayedFor).toBe('b1');
    expect(h.probe().busy).toBe(false);
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'B 的内容')).toBe(true);
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'A 的内容')).toBe(false);
  });

  it('failure: B\'s failed bootstrap leaves NO A identity behind (no cross-workspace flush risk)', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined);
    desktop.resolveBootstrap([summary('a1', 'A 的会话')], 'a1');
    await flush();
    desktop.resolveLoad('a1', record('a1', 'A 的会话', 'A 的内容'));
    await flush();
    expect(h.probe().displayedFor).toBe('a1');

    // Enter B, whose bootstrap FAILS. A's identity must be gone and the
    // transition must end unlocked with NO active session.
    desktop.armBootstrap(true);
    h.rerender('/ws/b');
    await flush();
    expect(h.probe().busy).toBe(false);
    expect(h.probe().activeId).toBeNull(); // NOT a1 — no stale identity
    expect(h.probe().displayedFor).toBeNull();
    expect(h.probe().phase).toBe('idle');
    // The failure path is the one the review singled out: the page must NOT
    // keep A's transcript on screen in an idle, interactive state.
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'A 的内容')).toBe(false);
  });

  it('a late load from the OLD workspace is superseded and never applied', async () => {
    const desktop = new FakeDesktop();
    (globalThis as { window: { desktop: unknown } }).window = { desktop: desktop.api() };
    desktop.armBootstrap();
    const h = mountHarness(desktop, '/ws/a', () => undefined);
    desktop.resolveBootstrap([summary('a1', 'A 的会话')], 'a1');
    await flush();
    // A's load is in flight (not yet resolved)…

    // …the user switches to B.
    desktop.armBootstrap();
    h.rerender('/ws/b');
    desktop.resolveBootstrap([summary('b1', 'B 的会话')], 'b1');
    await flush();
    desktop.resolveLoad('b1', { ...record('b1', 'B 的会话', 'B 的内容'), workspaceRoot: '/ws/b' });
    await flush();
    expect(h.probe().displayedFor).toBe('b1');

    // NOW A's load resolves late: it must be dropped (superseded inside
    // hydrate via the identity ref, and/or cancelled via the effect cleanup).
    desktop.resolveLoad('a1', record('a1', 'A 的会话', '迟到的 A 快照'));
    await flush();
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === '迟到的 A 快照')).toBe(false);
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === 'A 的内容')).toBe(false); // the earlier A transcript is gone too
    expect(h.probe().displayedFor).toBe('b1'); // attribution unchanged
    expect(h.probe().busy).toBe(false); // the late settle cannot unlock B's newer state either way
  });
});
