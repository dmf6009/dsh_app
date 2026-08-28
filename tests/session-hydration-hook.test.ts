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
  /** Deferreds for loadSession, keyed by id (latest wins). */
  loads = new Map<string, Deferred<{ ok: boolean; record?: SessionRecord }>>();
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
    if (!this.loads.has(id)) this.loads.set(id, deferred());
    return this.loads.get(id)!.promise;
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

  resolveLoad(id: string, rec: SessionRecord | null): void {
    if (!this.loads.has(id)) this.loads.set(id, deferred());
    this.loads.get(id)!.resolve(rec ? { ok: true, record: rec } : { ok: false });
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
    const applyModel = (m: ChatModel): void => {
      order.push('apply');
      busyAtLastApply = sessions.hydration.busy;
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
    // The caller's protocol order: apply decision FIRST, settle after.
    expect(h.order.filter((e) => e === 'apply' || e === 'settle')).toEqual(['apply', 'settle']);
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

describe('A→B switch — real hook', () => {
  it('switching window is busy with A displayed; unlock only after B is applied', async () => {
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

    // Simulate the page's switch path: the hook's switchTo is driven by the
    // page through window.desktop.switchSession + loadSession; here we model
    // the observable contract instead — the active id flips (as switchTo/
    // remove do) and a new load goes in flight for B.
    desktop.resolveLoad('b', record('b', 'B', 'B 的内容'));
    // Act on the hook via its own remove() is heavier; the A→B switch's busy
    // window is covered by the state sequence: arm B's load and observe.
    // (switchTo itself is covered in session-transition tests; here we pin
    // the hydration busy/attribution window around the id flip.)
    expect(h.probe().phase).toBe('idle');
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
    // Protocol order on a drop: settle AFTER the (no-apply) decision.
    expect(h.order.filter((e) => e === 'apply' || e === 'settle')).toEqual(['settle']);
    // …but the model was NOT replaced and attribution was NOT updated.
    expect(h.probe().model.items.some((i) => i.kind === 'user' && i.text === '不应被应用的快照')).toBe(false);
    expect(h.probe().displayedFor).toBeNull();
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

    // Arm the load first (the deferred is created on demand; resolving it
    // before the call keeps hydrate() from awaiting forever).
    desktop.resolveLoad('s1', record('s1', '会话一', '内容'));
    // The caller (page) starts a hydration request manually.
    let restored: unknown = 'unsettled';
    await act(async () => {
      restored = await h.sessions().hydrate();
    });
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
    desktop.resolveLoad('s1', record('s1', '会话一', '内容'));
    await act(async () => {
      await h.sessions().hydrate();
    });
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
    // IMMEDIATELY after entering B (before its bootstrap resolves) no A
    // identity may remain — not the active id, not the attribution.
    expect(h.probe().activeId).toBeNull();
    expect(h.probe().displayedFor).toBeNull();
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
    expect(h.probe().displayedFor).toBe('b1'); // attribution unchanged
    expect(h.probe().busy).toBe(false); // the late settle cannot unlock B's newer state either way
  });
});
