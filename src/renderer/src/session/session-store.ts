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

import type { SessionRecord, SessionSummary } from '../../../shared/session';
import {
  fromSessionItems,
  toSessionItems,
  type ChatModel,
  type RunPhase
} from '../chat/model';

export interface SessionStoreValue {
  summaries: SessionSummary[];
  activeId: string | null;
  /** Title used to label the loaded session; null before anything loads. */
  activeTitle: string | null;
  /** Whether the active session record exists on disk (vs. never created). */
  loaded: boolean;
  /** Rehydrate the ChatModel from the active persisted session. */
  hydrate: () => Promise<ChatModel | null>;
  /** Persist the current ChatModel + metadata as the active session. */
  persist: (model: ChatModel, meta: SessionPersistMeta) => Promise<void>;
  /** Create a new (empty) session and switch to it; returns the fresh ChatModel. */
  create: (title?: string) => Promise<ChatModel>;
  /** Switch to an existing session; returns its rehydrated ChatModel. */
  switchTo: (id: string, currentModel: ChatModel, meta: SessionPersistMeta) => Promise<ChatModel>;
  /** Delete a session; if it was active, switches to the next one. */
  remove: (id: string) => Promise<void>;
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
  /** Track whether a session was just created (so we skip saving the empty
   * prior one on the first persist cycle). */
  const freshlyCreatedRef = useRef(false);
  const hydratedRef = useRef(false);

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
      return EMPTY_MODEL;
    }
    setActiveTitle(result.record.title);
    return {
      items: fromSessionItems(result.record.items),
      phase: 'idle', // never auto-resume a running task
      changes: result.record.items
        .filter((i) => i.kind === 'file_changed')
        .map((i) => ({ id: i.id, path: i.path ?? '', change: (i.change as 'added' | 'modified' | 'deleted') ?? 'modified' }))
    };
  }, [activeId]);

  const persist = useCallback(async (model: ChatModel, meta: SessionPersistMeta): Promise<void> => {
    if (!activeId || !meta.workspaceRoot) return;
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
    await window.desktop.saveSession({ ...base, ...patch });
    void refreshList();
  }, [activeId, activeTitle, refreshList]);

  const create = useCallback(async (title?: string): Promise<ChatModel> => {
    const { result, record } = await window.desktop.createSession(title);
    if (!result.ok || !record) return EMPTY_MODEL;
    setActiveId(record.id);
    setActiveTitle(record.title);
    setSummaries((prev) => [
      { id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt, active: true },
      ...prev.map((s) => ({ ...s, active: false }))
    ]);
    freshlyCreatedRef.current = true;
    hydratedRef.current = true;
    setLoaded(true);
    return EMPTY_MODEL;
  }, []);

  const switchTo = useCallback(
    async (id: string, currentModel: ChatModel, meta: SessionPersistMeta): Promise<ChatModel> => {
      // Save the outgoing session first so its transcript is not lost.
      if (activeId && activeId !== id) {
        await persist(currentModel, meta);
      }
      const result = await window.desktop.switchSession(id);
      if (!result.ok) return EMPTY_MODEL;
      setActiveId(id);
      setSummaries((prev) => prev.map((s) => ({ ...s, active: s.id === id })));
      freshlyCreatedRef.current = false;
      hydratedRef.current = false;
      const loaded = await window.desktop.loadSession(id);
      if (loaded.ok && loaded.record) {
        setActiveTitle(loaded.record.title);
        return {
          items: fromSessionItems(loaded.record.items),
          phase: 'idle',
          changes: loaded.record.items
            .filter((i) => i.kind === 'file_changed')
            .map((i) => ({ id: i.id, path: i.path ?? '', change: (i.change as 'added' | 'modified' | 'deleted') ?? 'modified' }))
        };
      }
      return EMPTY_MODEL;
    },
    [activeId, persist]
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await window.desktop.deleteSession(id);
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
    },
    [activeId]
  );

  return {
    summaries,
    activeId,
    activeTitle,
    loaded,
    hydrate,
    persist,
    create,
    switchTo,
    remove
  };
}
