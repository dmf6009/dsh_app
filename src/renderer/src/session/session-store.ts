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
  modelFromRecord,
  switchSessionWithCheckpoint
} from './session-transition';

export interface SessionStoreValue {
  summaries: SessionSummary[];
  activeId: string | null;
  /** Title used to label the loaded session; null before anything loads. */
  activeTitle: string | null;
  /** Whether the active session record exists on disk (vs. never created). */
  loaded: boolean;
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

const EMPTY_MODEL: ChatModel = { items: [], phase: 'idle', changes: [] };

export function useSessionStore(workspaceRoot: string | null): SessionStoreValue {
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
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

  // Reload the list whenever the workspace changes.
  useEffect(() => {
    if (!workspaceRoot) {
      setSummaries([]);
      setActiveId(null);
      setActiveTitle(null);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    void Promise.all([
      window.desktop.listSessions(),
      window.desktop.getActiveSessionId()
    ]).then(([list, active]) => {
      if (cancelled) return;
      setSummaries(list);
      const id = active.id;
      setActiveId(id);
      const activeSummary = list.find((s) => s.id === id);
      setActiveTitle(activeSummary?.title ?? null);
      setLoaded(Boolean(id));
      hydratedRef.current = false;
      freshlyCreatedRef.current = false;
    }).catch(() => {
      if (cancelled) return;
      setSummaries([]);
      setLoaded(false);
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
    if (freshlyCreatedRef.current) {
      // A brand-new session: nothing on disk to load, start empty.
      freshlyCreatedRef.current = false;
      hydratedRef.current = true;
      return EMPTY_MODEL;
    }
    const result = await window.desktop.loadSession(activeId);
    hydratedRef.current = true;
    if (!result.ok || !result.record) {
      // Corrupt or missing — start fresh so the panel still works.
      lastBaseRef.current = null;
      return EMPTY_MODEL;
    }
    // Cache the loaded record so a synchronous flush() can build a complete
    // SessionRecord without an async round-trip.
    lastBaseRef.current = result.record;
    setActiveTitle(result.record.title);
    return modelFromRecord(result.record);
  }, [activeId]);

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
            setActiveTitle(record.title);
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
      // If the deleted one was active, fall back to the next.
      if (id === activeId) {
        const next = list[0] ?? null;
        setActiveId(next?.id ?? null);
        setActiveTitle(next?.title ?? null);
        setLoaded(Boolean(next));
        freshlyCreatedRef.current = false;
        hydratedRef.current = false;
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

  return {
    summaries,
    activeId,
    activeTitle,
    loaded,
    lastError,
    dismissError,
    surfaceError,
    hydrate,
    persist,
    create,
    switchTo,
    remove,
    flush
  };
}
