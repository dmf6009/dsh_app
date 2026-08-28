/**
 * React bindings for persisted Sessions (DSHA-7, §15/§16, F10/AC-12).
 *
 * The hook owns the conversation between the live ChatModel and the durable
 * SessionRecord on disk. It does NOT auto-resume an interrupted task (out of
 * scope per the issue) — a loaded session renders its transcript at rest and
 * lets the user start a new run from there.
 *
 * Persistence triggers (local-first, §5.2):
 *   - on app open: load the list + the last active session for the workspace
 *   - when a run terminates (done/run_completed/run_cancelled/error): save
 *   - on session switch / delete / before page leave: save
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  describeSessionError,
  sessionDeleteFailedCopy,
  sessionOpFailedCopy,
  sessionSaveFailedCopy
} from '../../../shared/error-copy';
import type { SessionRecord, SessionSummary } from '../../../shared/session';
import { toSessionItems, type ChatModel, type RunPhase } from '../chat/model';
import {
  createSessionWithCheckpoint,
  hydrationPhase,
  resolveHydration,
  switchSessionWithCheckpoint,
  type HydrationStatus
} from './session-transition';

export interface SessionStoreValue {
  summaries: SessionSummary[];
  activeId: string | null;
  /** Title used to label the loaded session; null before anything loads. */
  activeTitle: string | null;
  /** Whether the active session record exists on disk (vs. never created). */
  loaded: boolean;
  /**
   * User-visible hydration transition state (UI/UE acceptance round): the
   * phase distinguishes the workspace's INITIAL hydrate, an A→B SWITCH (or
   * the fallback hydrate after deleting the active session) and idle. While
   * busy the page disables create/switch/delete/composer to block duplicate
   * operations; the phase always resets — on success, on failure, when the
   * request is superseded (guard/cleanup) and when the workspace changes.
   */
  hydration: HydrationStatus;
  /**
   * Increments on every workspace change. Watching it tells the page the
   * displayed model belongs to the PREVIOUS workspace and must be cleared
   * (as a non-hydration mutation, so a stale in-flight request cannot
   * re-apply the old transcript).
   */
  workspaceEpoch: number;
  /**
   * Last persistence error surfaced to the user (save/delete failure). Set when
   * the main process returns ok=false; cleared by the next successful op or by
   * dismissError. Pre-framed via the §32 error-copy module (发生了什么 / 为什么 /
   * 建议动作 + 原始信息) so the banner is diagnosable, not a bare fs message.
   */
  lastError: string | null;
  dismissError: () => void;
  /**
   * Surface a pre-framed §32 notice on the session error banner. Used by
   * callers that block an action (e.g. submit with no activatable workspace)
   * and need the same 「发生了什么/为什么/建议动作」 presentation.
   */
  surfaceError: (notice: string) => void;
  /**
   * Record which session the currently DISPLAYED model belongs to — called
   * by the page whenever it applies a model (hydration result, create/switch
   * application). Drives the `switching` phase: while busy with
   * displayedFor ≠ activeId the page labels the old transcript as belonging
   * to the previous session.
   */
  noteDisplayedFor: (id: string | null) => void;
  /**
   * Settle the hydration request issued for `requestId`: the busy transition
   * ends here — AFTER the caller has decided to apply or drop the result.
   * Identity-safe: a late settle cannot unlock a newer transition. A null id
   * is a no-op (no request was issued for it).
   */
  settleHydration: (requestId: string | null) => void;
  /** Rehydrate the ChatModel from the active persisted session. */
  hydrate: () => Promise<ChatModel | null>;
  /** Persist the current ChatModel + metadata as the active session. Returns
   *  an error string on failure instead of silently swallowing it. */
  persist: (model: ChatModel, meta: SessionPersistMeta) => Promise<string | null>;
  /**
   * Create a new (empty) session and switch to it. The outgoing session is
   * checkpointed FIRST; if that checkpoint fails, creation is aborted (the
   * current active id/model stay put) and `null` is returned — a failed save
   * must never discard unsaved conversation state.
   */
  create: (currentModel: ChatModel, meta: SessionPersistMeta, title?: string) => Promise<ChatModel | null>;
  /**
   * Switch to an existing session; returns its rehydrated ChatModel. Same
   * abort semantics as {@link create}: when the outgoing session cannot be
   * checkpointed, the switch is aborted and `null` is returned so the caller
   * keeps the current (unsaved) model on screen.
   */
  switchTo: (id: string, currentModel: ChatModel, meta: SessionPersistMeta) => Promise<ChatModel | null>;
  /** Delete a session; if it was active, switches to the next one. Returns an
   *  error string on failure instead of silently swallowing it. */
  remove: (id: string) => Promise<string | null>;
  /**
   * Synchronous checkpoint for the active session (§15/§34 lifecycle). Used
   * on navigation away from the Workspace page, component unload, and app close
   * (beforeunload/pagehide) so an in-flight conversation is never lost. The
   * caller passes the live model + meta; this builds the full record and calls
   * the main process's sendSync flush channel. Returns the save result.
   */
  flush: (model: ChatModel, meta: SessionPersistMeta) => { ok: boolean; error?: string };
}

export interface SessionPersistMeta {
  model: string | null;
  phase: RunPhase;
  tokenUsage: Record<string, number> | null;
  /** Workspace root the sessions are scoped to. */
  workspaceRoot: string | null;
}

/** Map a live ChatModel + meta into a persisted SessionRecord patch. */
function toRecordPatch(model: ChatModel, meta: SessionPersistMeta): Pick<SessionRecord, 'items' | 'model' | 'agentState' | 'tokenUsage'> {
  return {
    items: toSessionItems(model.items),
    model: meta.model,
    agentState: meta.phase === 'running' ? 'running' : meta.phase === 'awaiting_approval' ? 'awaiting_approval' : meta.phase === 'awaiting_cancel' ? 'awaiting_cancel' : 'idle',
    tokenUsage: meta.tokenUsage
  };
}

export function useSessionStore(workspaceRoot: string | null): SessionStoreValue {
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  /**
   * Hydration transition tracking (UI/UE round): `hydratingFor` is the id a
   * request is in flight FOR (null = none), `displayedFor` the id the rendered
   * model belongs to. The user-visible phase is derived from the pair so it
   * can never drift from the ids it describes.
   */
  const [hydratingFor, setHydratingFor] = useState<string | null>(null);
  const [displayedFor, setDisplayedFor] = useState<string | null>(null);
  /**
   * Bumped on every workspaceRoot change. The page watches it to clear the
   * displayed ChatModel (which belongs to the OLD workspace) at the same
   * moment the store voids the session identity — a transcript from workspace
   * A must never stay on screen (interactive, idle) inside workspace B.
   */
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  /**
   * The session id whose load request is still CURRENT. When `activeId` moves
   * on (switch/delete/new create) while a load is in flight, this ref keeps
   * the old id so the late result is recognized as superseded and dropped
   * inside hydrate() itself — independent of the page-side guard.
   */
  const cancelledHydrationRef = useRef<string | null>(null);
  /** Last workspaceRoot seen by the bootstrap effect (change detection). */
  const workspaceRootRef = useRef<string | null>(null);
  /** Live mirror of activeId for the bootstrap's identity reset. */
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  /** Track whether a session was just created (so we skip saving the empty
   * prior one on the first persist cycle). */
  const freshlyCreatedRef = useRef(false);
  const hydratedRef = useRef(false);
  /** Last-known full record for the active session (createdAt/updatedAt/title
   *  carried over from load/create/persist) so the synchronous flush() can
   *  build a complete SessionRecord without an async round-trip. */
  const lastBaseRef = useRef<SessionRecord | null>(null);

  const dismissError = useCallback((): void => {
    setLastError(null);
  }, []);

  const surfaceError = useCallback((notice: string): void => {
    setLastError(notice);
  }, []);

  const noteDisplayedFor = useCallback((id: string | null): void => {
    setDisplayedFor(id);
  }, []);

  // Reload the list whenever the workspace changes.
  useEffect(() => {
    // Entering (or leaving) a workspace IMMEDIATELY voids the previous
    // workspace's session identity: a late load from the old workspace must
    // be recognized as superseded, and the stale active id/title/displayed
    // model must never survive into the new workspace's state (a later flush
    // with the new root would otherwise carry the old session's identity).
    // Runs ONLY on a workspaceRoot change (tracked via ref, not effect deps —
    // activeId flips on every switch/delete/create and must NOT re-bootstrap).
    const previousRoot = workspaceRootRef.current;
    workspaceRootRef.current = workspaceRoot;
    if (previousRoot !== workspaceRoot) {
      cancelledHydrationRef.current = activeIdRef.current;
      setSummaries([]);
      setActiveId(null);
      setActiveTitle(null);
      setDisplayedFor(null);
      setLoaded(false); // no active session until this workspace's bootstrap lands
      lastBaseRef.current = null;
      setWorkspaceEpoch((epoch) => epoch + 1); // the page clears its model on this
    }
    if (!workspaceRoot) {
      setLoaded(false);
      setHydratingFor(null);
      return;
    }
    let cancelled = false;
    // The workspace's first hydrate: busy until the active session's
    // transcript hydration completes (or there is no active session).
    setHydratingFor('pending-workspace');
    void Promise.all([
      window.desktop.listSessions(),
      window.desktop.getActiveSessionId()
    ]).then(([list, active]) => {
      if (cancelled) return;
      setSummaries(list);
      const id = active.id;
      setActiveId(id);
      cancelledHydrationRef.current = id; // this id's loads are now current
      const activeSummary = list.find((s) => s.id === id);
      setActiveTitle(activeSummary?.title ?? null);
      setLoaded(Boolean(id));
      hydratedRef.current = false;
      freshlyCreatedRef.current = false;
      // With an active session the transcript hydration is still in flight;
      // without one the initial hydrate is already done.
      setHydratingFor(id);
      setDisplayedFor(null);
    }).catch(() => {
      if (cancelled) return;
      setSummaries([]);
      setLoaded(false);
      setHydratingFor(null); // failed bootstrap never stays busy
      // The old workspace's identity was already reset above; a failed
      // bootstrap leaves NO active session rather than a stale one.
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  const refreshList = useCallback(async (): Promise<void> => {
    const list = await window.desktop.listSessions();
    setSummaries(list);
  }, []);

  const hydrate = useCallback(async (): Promise<ChatModel | null> => {
    if (!activeId) return null;
    // Mark the hydration in flight for THIS id (supersedes any earlier mark,
    // including the workspace bootstrap's 'pending-workspace').
    setHydratingFor(activeId);
    if (freshlyCreatedRef.current) {
      // A brand-new session: nothing exists on disk, and the LIVE model is the
      // truth — possibly holding the first dispatched message that has not
      // been checkpointed yet. resolveHydration returns null so the caller
      // keeps it (the old EMPTY_MODEL return silently wiped that message).
      freshlyCreatedRef.current = false;
      hydratedRef.current = true;
      // NOTE: the busy mark is NOT cleared here — the caller owns the settle
      // (see `settleHydration`): the transition ends only after the page has
      // decided to apply or drop the result, never before.
      return resolveHydration(true, null);
    }
    try {
      const result = await window.desktop.loadSession(activeId);
      if (cancelledHydrationRef.current !== activeId) return null; // superseded
      hydratedRef.current = true;
      if (!result.ok || !result.record) {
        // Corrupt or missing — start fresh so the panel still works.
        lastBaseRef.current = null;
        return resolveHydration(false, null);
      }
      // Cache the loaded record so a synchronous flush() can build a complete
      // SessionRecord without an async round-trip.
      lastBaseRef.current = result.record;
      setActiveTitle(result.record.title);
      return resolveHydration(false, result.record);
    } catch {
      // A failed load is a corrupt-equivalent fallback: settle with the empty
      // rest model (still owned by the caller's settle decision below).
      return resolveHydration(false, null);
    }
  }, [activeId]);

  /**
   * Settle a hydration request (review round: settle ownership). The busy
   * transition ends HERE — when the page has finished deciding whether to
   * apply or drop the result — not inside hydrate()'s finally, which runs
   * before the caller's guard check and would unlock (and drop the
   * attribution banner) while the old transcript is still on screen.
   *
   * `requestId` is the id the hydration was issued for; a settle only clears
   * its own mark, so a late completion cannot unlock a newer transition.
   */
  const settleHydration = useCallback((requestId: string | null): void => {
    if (requestId === null) return;
    setHydratingFor((current) => (current === requestId ? null : current));
  }, []);

  const persist = useCallback(async (model: ChatModel, meta: SessionPersistMeta): Promise<string | null> => {
    if (!activeId || !meta.workspaceRoot) return null;
    const patch = toRecordPatch(model, meta);
    const existing = await window.desktop.loadSession(activeId);
    const base: SessionRecord =
      existing.ok && existing.record
        ? existing.record
        : {
            schemaVersion: 1,
            id: activeId,
            workspaceRoot: meta.workspaceRoot,
            title: activeTitle ?? `会话 ${activeId.slice(0, 8)}`,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            model: null,
            agentState: 'idle',
            tokenUsage: null,
            items: []
          };
    const result = await window.desktop.saveSession({ ...base, ...patch });
    if (!result.ok) {
      // Surface the failure (§32 三段式) — never silently pretend the save
      // landed, then refresh anyway so the list reflects the real on-disk state.
      const msg = describeSessionError(sessionSaveFailedCopy(result.error));
      setLastError(msg);
      void refreshList();
      return msg;
    }
    // Cache the saved record so a synchronous flush() can build a complete
    // SessionRecord without an async round-trip.
    lastBaseRef.current = { ...base, ...patch };
    setLastError(null);
    void refreshList();
    return null;
  }, [activeId, activeTitle, refreshList]);

  // §15/AC-12 (review round 2): creating or switching sessions checkpoints the
  // OUTGOING session first; a failed checkpoint aborts the whole transition —
  // no new session is created, no switch happens, and the current model stays
  // on screen. The orchestration lives in session-transition.ts so the exact
  // ordering (persist → create/activate → load → apply) is unit-testable.
  const create = useCallback(
    async (currentModel: ChatModel, meta: SessionPersistMeta, title?: string): Promise<ChatModel | null> => {
      const outcome = await createSessionWithCheckpoint(
        {
          persistOutgoing: () => (activeId ? persist(currentModel, meta) : Promise.resolve(null)),
          createNew: (t?: string) => window.desktop.createSession(t),
          activate: () => Promise.resolve({ ok: true }),
          load: () => Promise.resolve({ ok: false }),
          onCreated: (record) => {
            setActiveId(record.id);
            cancelledHydrationRef.current = record.id; // supersedes any old load
            setActiveTitle(record.title);
            // The fresh session's model is applied by the page right after
            // create returns; nothing needs hydrating (freshly-created no-op).
            setDisplayedFor(record.id);
            setHydratingFor(null);
            setSummaries((prev) => [
              { id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, active: true },
              ...prev.map((s) => ({ ...s, active: false }))
            ]);
            freshlyCreatedRef.current = true;
            hydratedRef.current = true;
            lastBaseRef.current = record;
            setLoaded(true);
            setLastError(null);
          },
          onSwitched: () => {}
        },
        title
      );
      if (outcome.status === 'aborted' && outcome.stage === 'create') {
        // persist-stage failures already surfaced their own §32 banner inside
        // persist(); only a failed create itself needs framing here. When
        // there was no outgoing session (first-ever create) the copy must not
        // claim the current session was saved.
        setLastError(describeSessionError(sessionOpFailedCopy('新建', outcome.error, activeId !== null)));
      }
      return outcome.status === 'completed' ? outcome.model : null;
    },
    [activeId, persist]
  );

  const switchTo = useCallback(
    async (id: string, currentModel: ChatModel, meta: SessionPersistMeta): Promise<ChatModel | null> => {
      // The whole persist → activate → load window is a user-visible
      // transition; cleared when the switch settles either way.
      setHydratingFor(id);
      const outcome = await switchSessionWithCheckpoint(
        {
          persistOutgoing: () =>
            activeId && activeId !== id ? persist(currentModel, meta) : Promise.resolve(null),
          createNew: () => Promise.resolve({ result: { ok: false } }),
          activate: (target: string) => window.desktop.switchSession(target),
          load: (target: string) => window.desktop.loadSession(target),
          onCreated: () => {},
          onSwitched: (target: string, record) => {
            setActiveId(target);
            cancelledHydrationRef.current = target; // supersedes any old load
            setSummaries((prev) => prev.map((s) => ({ ...s, active: s.id === target })));
            freshlyCreatedRef.current = false;
            hydratedRef.current = false;
            if (record) {
              lastBaseRef.current = record;
              setActiveTitle(record.title);
            }
          }
        },
        id
      );
      if (outcome.status === 'aborted' && outcome.stage === 'activate') {
        setLastError(describeSessionError(sessionOpFailedCopy('切换', outcome.error)));
      }
      if (outcome.status !== 'completed') {
        // Aborted: no switch happened — the active id (and the displayed
        // model) still belong to the outgoing session. Never stay busy.
        setHydratingFor((current) => (current === id ? null : current));
      }
      return outcome.status === 'completed' ? outcome.model : null;
    },
    [activeId, persist]
  );

  const remove = useCallback(
    async (id: string): Promise<string | null> => {
      const result = await window.desktop.deleteSession(id);
      if (!result.ok) {
        // Delete failed on disk — do NOT switch away from the active session
        // (the store did not mutate its index); surface the §32 三段式 failure.
        const msg = describeSessionError(sessionDeleteFailedCopy(result.error));
        setLastError(msg);
        void refreshList();
        return msg;
      }
      setLastError(null);
      const list = await window.desktop.listSessions();
      setSummaries(list);
      // If the deleted one was active, fall back to the next: the fallback
      // hydrate goes through the normal hydrate path (the page's effect fires
      // on the active-id flip). The displayed model still belongs to the
      // DELETED session until that hydrate lands — that difference is what
      // the page labels as "切换前会话内容".
      if (id === activeId) {
        const next = list[0] ?? null;
        setActiveId(next?.id ?? null);
        cancelledHydrationRef.current = next?.id ?? null; // supersedes the deleted id's load
        setActiveTitle(next?.title ?? null);
        setLoaded(Boolean(next));
        freshlyCreatedRef.current = false;
        hydratedRef.current = false;
        if (next !== null) setHydratingFor(next.id);
      }
      return null;
    },
    [activeId, refreshList]
  );

  // Synchronous checkpoint: build the full record from the cached base + the
  // live model/meta and send it to the main process over sendSync so the save
  // completes before navigation/unload/quit discards the renderer. Falls back
  // to a minimal record when no base is cached yet (first-ever save).
  const flush = useCallback(
    (model: ChatModel, meta: SessionPersistMeta): { ok: boolean; error?: string } => {
      if (!activeId || !meta.workspaceRoot) return { ok: false, error: 'no active session' };
      const patch = toRecordPatch(model, meta);
      const base: SessionRecord = lastBaseRef.current ?? {
        schemaVersion: 1,
        id: activeId,
        workspaceRoot: meta.workspaceRoot,
        title: activeTitle ?? `会话 ${activeId.slice(0, 8)}`,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        model: null,
        agentState: 'idle',
        tokenUsage: null,
        items: []
      };
      const record: SessionRecord = { ...base, ...patch };
      const result = window.desktop.flushBeforeQuit(record);
      if (result.ok) {
        lastBaseRef.current = record;
        setLastError(null);
      } else {
        setLastError(describeSessionError(sessionSaveFailedCopy(result.error)));
      }
      return result;
    },
    [activeId, activeTitle]
  );

  const hydration: HydrationStatus = {
    phase: hydrationPhase(hydratingFor, activeId, displayedFor),
    busy: hydratingFor !== null,
    displayedFor
  };

  return {
    summaries,
    activeId,
    activeTitle,
    loaded,
    hydration,
    workspaceEpoch,
    lastError,
    dismissError,
    surfaceError,
    noteDisplayedFor,
    settleHydration,
    hydrate,
    persist,
    create,
    switchTo,
    remove,
    flush
  };
}
