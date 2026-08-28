/**
 * Workspace page (issue DSHA-5): production three-column layout.
 *
 *   Left   — Sessions list (in-memory this stage; persistence lands later)
 *   Middle — Conversation rendering the §9 seven forms + composer with the
 *            running lock and an always-reachable Stop (AC-11)
 *   Right  — Changes container fed by file_changed events (real diff view is
 *            P1-C scope)
 *
 * Also hosts the app-level Approval modal (§12/§13) and the §32 crash /
 * startup-failure recovery banners (Restart Runtime / Resume Session).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConnectionState, RuntimeStatus } from '../../../shared/desktop-api';
import {
  agentCrashCopy,
  describeSessionError,
  runtimeStartupFailedCopy,
  workspaceActivationFailedCopy,
  workspaceNotOpenCopy
} from '../../../shared/error-copy';
import type {
  ApprovalRequestPayload,
} from '../../../shared/approval-protocol';
import type { RuntimeEventFrame } from '../../../shared/protocol/types';
import { ApprovalModal } from '../components/ApprovalModal';
import { useMediaQuery } from '../hooks/use-media-query';
import { Button, Spinner } from '../components/ui';
import { useApp } from '../store/app-store';
import { useChanges } from '../changes/changes-store';
import { badgeTitle, changedFiles, showRunSummary, summaryLabel } from '../changes/model';
import { useSessionStore } from '../session/session-store';
import { runSubmit } from '../session/submit-flow';
import {
  INITIAL_MODEL,
  reduceChat,
  type AssistantItem,
  type ChatItem,
  type ChatModel,
  type FileChangedItem,
  type FileReadItem,
  type PlanItem,
  type RunPhase,
  type SubagentItem,
  type SummaryItem,
  type ToolCardItem,
  type UserItem
} from '../chat/model';

const LEVEL_CLASS: Record<string, string> = { L0: 'lvl-l0', L1: 'lvl-l1', L2: 'lvl-l2' };

const CHANGE_LABEL: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D'
};

const STATE_LABEL: Record<ConnectionState, string> = {
  stopped: '未连接',
  starting: '启动中…',
  ready: '已就绪',
  crashed: '已崩溃'
};

export default function WorkspacePage(): JSX.Element {
  const { state: appState, dispatch: appDispatch } = useApp();
  const sessions = useSessionStore(appState.workspaceRoot);
  const [model, setModel] = useState<ChatModel>(INITIAL_MODEL);
  const [input, setInput] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('stopped');
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [approval, setApproval] = useState<ApprovalRequestPayload | null>(null);
  /** Review fix 3: retryable send-failure banner while the modal stays open. */
  const [approvalSendError, setApprovalSendError] = useState<string | null>(null);
  /**
   * Second-review fix: push notice for auto-decision delivery failures.
   * Dismissible; also cleared by the next approval event or user action.
   */
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const [modelChoice, setModelChoice] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<ChatModel>(INITIAL_MODEL);
  modelRef.current = model;

  /* ---- aggregated Changes (DSHA-6) ------------------------------------ */

  const changes = useChanges();
  const runActive = model.phase !== 'idle';
  const changedFileList = changedFiles(changes.snapshot);
  const branchLabel = changes.snapshot?.gitAvailable
    ? `⎇ ${changes.snapshot.branch ?? '未知分支'}${changes.snapshot.detached ? ' (detached)' : ''}`
    : null;

  const dispatch = useCallback((action: Parameters<typeof reduceChat>[1]): void => {
    setModel((prev) => reduceChat(prev, action));
  }, []);

  /* ---- Session persistence (DSHA-7 §15/§16, F10/AC-12) ---------------- */

  // Persist meta assembled from the live model + selection.
  const persistMeta = useCallback(() => ({
    model: modelChoice || null,
    phase: modelRef.current.phase,
    tokenUsage: null,
    workspaceRoot: appState.workspaceRoot
  }), [modelChoice, appState.workspaceRoot]);

  // The active session id + flush fn come from the session hook (declared
  // here, before openDiff, so the navigation checkpoint can reference them).
  const { loaded: sessionLoaded, activeId: sessionActiveId, hydrate: sessionHydrate, persist: sessionPersist, flush: sessionFlush } = sessions;

  // Synchronous checkpoint of the active session (navigation / unload / quit).
  // Uses the main-process sendSync flush channel so the save completes before
  // the renderer is torn down. No-op when there is no active session/workspace.
  const flushNow = useCallback((): { ok: boolean; error?: string } => {
    if (!sessionActiveId || !appState.workspaceRoot) return { ok: false };
    return sessionFlush(modelRef.current, persistMeta());
  }, [sessionActiveId, appState.workspaceRoot, sessionFlush, persistMeta]);

  // Hydrate the active session once it's loaded (and when the active id
  // changes due to a switch). Never auto-resume a running task.
  useEffect(() => {
    if (!sessionLoaded) return;
    let cancelled = false;
    void sessionHydrate().then((restored) => {
      if (cancelled || restored === null) return;
      setModel(restored);
    });
    return () => { cancelled = true; };
  }, [sessionLoaded, sessionActiveId, sessionHydrate]);

  // Persist on run termination (done / run_completed / run_cancelled / error).
  const lastPhaseRef = useRef<RunPhase>('idle');
  useEffect(() => {
    const prev = lastPhaseRef.current;
    const next = model.phase;
    lastPhaseRef.current = next;
    // Just went idle from a non-idle state → the run ended, checkpoint.
    if (prev !== 'idle' && next === 'idle' && sessionActiveId) {
      void sessionPersist(modelRef.current, persistMeta());
    }
  }, [model.phase, sessionActiveId, sessionPersist, persistMeta]);

  // §15 持久化生命周期：组件卸载与 app 关闭前的同步 checkpoint。beforeunload
  // 覆盖窗口关闭/刷新；pagehide 作为兜底。两者都通过 flushNow 走 sendSync，
  // 保证在进程退出前完成落盘。
  useEffect(() => {
    const flushBeforeExit = (): void => {
      flushNow();
    };
    window.addEventListener('beforeunload', flushBeforeExit);
    window.addEventListener('pagehide', flushBeforeExit);
    return () => {
      // Unmount flush — e.g. when the page-host swaps Workspace out.
      flushNow();
      window.removeEventListener('beforeunload', flushBeforeExit);
      window.removeEventListener('pagehide', flushBeforeExit);
    };
    // flushNow is stable across the workspace/session identity it depends on;
    // re-subscribe when those change so the listener always captures the right id.
  }, [flushNow]);

  const openDiff = useCallback(
    (path: string) => {
      // §15/§34 持久化生命周期：离开 Workspace 进入 Diff 前，同步落盘当前会话，
      // 避免尚未发生终止事件的消息/工具调用在导航时丢失。
      flushNow();
      changes.select(path);
      appDispatch({ type: 'navigate', route: 'diff' });
    },
    [changes, appDispatch, flushNow]
  );

  /* ---- subscriptions ------------------------------------------------ */

  useEffect(() => {
    const offEvent = window.desktop.onEvent((frame: RuntimeEventFrame) => {
      dispatch({ type: 'event', frame });
    });
    const offState = window.desktop.onConnectionState((next) => {
      setConnection(next);
      void window.desktop.getStatus().then(setStatus).catch(() => undefined);
    });
    const offApproval = window.desktop.onApprovalRequest((payload) => {
      setApprovalSendError(null);
      setApproval(payload);
      dispatch({ type: 'approval-opened', payload });
    });
    const offResolved = window.desktop.onApprovalResolved(() => {
      setApprovalSendError(null);
      setApproval(null);
      setApprovalNotice(null);
    });
    const offApprovalNotice = window.desktop.onApprovalNotice((notice) => {
      setApprovalNotice(notice.message);
    });

    void window.desktop.getStatus().then((initial) => {
      setStatus(initial);
      setConnection(initial.state);
    });
    // Model choices come from configured providers; selection is cosmetic
    // until P1-C wires it into run requests.
    void window.desktop.getSettings().then((view) => {
      const names = Array.from(
        new Set(view.providers.flatMap((p) => p.models ?? []))
      );
      setAvailableModels(names);
      setModelChoice((current) => current || names[0] || '');
    }).catch(() => undefined);

    return () => {
      offEvent();
      offState();
      offApproval();
      offResolved();
      offApprovalNotice();
    };
  }, [dispatch]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [model.items]);

  /* ---- actions ------------------------------------------------------ */

  const running = model.phase !== 'idle';
  // 没有工作区上下文时 composer 禁用（§3.3/§7.1）——消息必须落在已打开的
  // workspace 里，不再退回 fallback root 静默发送。
  const canSend = connection === 'ready' && !running && input.trim() !== '' && appState.workspaceRoot !== null;

  const submit = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (!canSend) return;
    // 工作区上下文一致性 + 首条消息会话建立（§15/AC-02/AC-12）：先让主进程激活
    // workspace，再创建 Session，最后发送。激活/创建失败则不发送并给出准确三段式
    // 提示；绝不退回「无会话静默发送」的旧降级。时序编排见 session/submit-flow.ts。
    await runSubmit(
      {
        workspaceRoot: () => appState.workspaceRoot,
        hasActiveSession: () => sessions.activeId !== null,
        activateWorkspace: (path) => window.desktop.ensureWorkspaceActive(path),
        createSession: (title) => sessions.create(modelRef.current, persistMeta(), title),
        sendMessage: (message) => {
          // The user message goes on screen optimistically, then the run starts.
          dispatch({ type: 'send', text: message });
          return window.desktop.sendMessage(message);
        },
        onWorkspaceActivated: (path) => appDispatch({ type: 'workspace', path }),
        onSessionCreated: (model) => {
          setModel(model);
          lastPhaseRef.current = 'idle';
        },
        onBlocked: (notice) => {
          // No workspace context (or activation failed) — accurate §32 copy,
          // never a bare store error string.
          sessions.surfaceError(
            notice === '未打开工作区'
              ? describeSessionError(workspaceNotOpenCopy())
              : describeSessionError(workspaceActivationFailedCopy(notice))
          );
          setInput(text); // keep the user's message so it is not lost
        },        onSendFailed: (error) => {
          // No run actually started — release the lock and surface the error
          // (pre-existing behavior, unchanged).
          setModel((prev) => ({
            ...prev,
            phase: 'idle',
            items: [
              ...prev.items,
              {
                kind: 'notice',
                id: `senderr-${Date.now()}`,
                tone: 'error' as const,
                text: `发送失败：${error ?? 'unknown error'}`
              }
            ]
          }));
        }
      },
      text
    );
    setInput('');
  }, [input, canSend, dispatch, sessions, persistMeta, appState.workspaceRoot, appDispatch]);

  const stop = useCallback(async (): Promise<void> => {
    if (modelRef.current.phase === 'idle') return;
    dispatch({ type: 'cancel-requested' });
    const result = await window.desktop.cancelRun();
    if (!result.ok) {
      dispatch({ type: 'cancel-failed', error: result.error ?? 'no active run' });
    }
    // Unlock happens only when run_cancelled arrives (AC-11).
  }, [dispatch]);

  /* ---- Session actions (DSHA-7 §15 多会话) --------------------------- */

  const newSession = useCallback(async (): Promise<void> => {
    if (running) return; // lock during a run
    // The outgoing session is checkpointed inside create(); on failure the
    // transition aborts (null) and the current model/active id stay on screen
    // so unsaved conversation state is never discarded (§15/AC-12).
    const restored = await sessions.create(modelRef.current, persistMeta());
    if (restored === null) return;
    setModel(restored);
    lastPhaseRef.current = 'idle';
  }, [running, sessions, persistMeta]);

  const switchSession = useCallback(async (id: string): Promise<void> => {
    if (running) return;
    // Same abort semantics: a failed outgoing checkpoint keeps the user on the
    // current (unsaved) session instead of silently replacing the model.
    const restored = await sessions.switchTo(id, modelRef.current, persistMeta());
    if (restored === null) return;
    setModel(restored);
    lastPhaseRef.current = 'idle';
  }, [running, sessions, persistMeta]);

  const deleteSession = useCallback(async (id: string): Promise<void> => {
    if (running) return;
    // The active session is saved by the user before this; deleting the
    // active one lets the hydrate effect load the fallback when activeId flips.
    await sessions.remove(id);
  }, [running, sessions]);

  /* ---- responsive drawers (#5) ---------------------------------------
   * Below 960px the side columns become off-canvas drawers: the middle
   * column and the composer always own the viewport so Stop / 停止中 stay
   * fully visible, focusable and clickable at every window size. Toggles
   * expose an accessible name and expanded state; Esc / backdrop closes and
   * focus returns to the opening toggle. The Approval modal keeps its own
   * focus trap and Esc=Reject — the drawer Esc handler stands down while it
   * is open.
   */
  const narrow = useMediaQuery('(max-width: 960px)');
  const [drawer, setDrawer] = useState<'sessions' | 'changes' | null>(null);
  const sessionsPanelRef = useRef<HTMLElement>(null);
  const changesPanelRef = useRef<HTMLElement>(null);
  const sessionsToggleRef = useRef<HTMLButtonElement>(null);
  const changesToggleRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<'sessions' | 'changes' | null>(null);
  drawerRef.current = drawer;

  useEffect(() => {
    if (!narrow) setDrawer(null);
  }, [narrow]);

  const openDrawer = useCallback((side: 'sessions' | 'changes'): void => {
    setDrawer(side);
  }, []);

  // Move focus into the freshly opened drawer after React commits the
  // off-canvas -> visible class swap (a rAF can fire before that commit,
  // and focus() silently no-ops on a visibility:hidden element).
  useEffect(() => {
    if (drawer === null) return;
    (drawer === 'sessions' ? sessionsPanelRef : changesPanelRef).current?.focus();
  }, [drawer]);

  const closeDrawer = useCallback((restoreFocus: boolean): void => {
    const current = drawerRef.current;
    if (current === null) return;
    setDrawer(null);
    if (restoreFocus) {
      (current === 'sessions' ? sessionsToggleRef : changesToggleRef).current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!narrow || drawer === null || approval !== null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeDrawer(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [narrow, drawer, approval, closeDrawer]);

  const respondApproval = useCallback(
    async (requestId: string, decision: 'allow' | 'reject', scope: 'once' | 'session'): Promise<void> => {
      setApprovalSendError(null);
      setApprovalNotice(null);
      const result = await window.desktop.respondApproval(requestId, { decision, scope });
      if (result.ok || result.error === 'no_pending_request') {
        // Delivered (or already settled elsewhere — safe default stands).
        setApproval(null);
        return;
      }
      // Review fix 3: runtime unreachable — keep the modal open and surface
      // the retryable error instead of pretending the answer was delivered.
      setApprovalSendError(
        result.error === 'runtime_unreachable'
          ? '发送到运行时失败，请重试'
          : (result.error ?? '发送失败，请重试')
      );
    },
    []
  );

  const recoverRestart = useCallback((): void => {
    void window.desktop.restartRuntime().then(setStatus).catch(() => undefined);
  }, []);

  const recoverResume = useCallback((): void => {
    void window.desktop.startRuntime().then(setStatus).catch(() => undefined);
  }, []);

  const statePillClass =
    connection === 'ready'
      ? 'pill pill-ok'
      : connection === 'crashed'
        ? 'pill pill-error'
        : connection === 'starting'
          ? 'pill pill-warn'
          : 'pill pill-idle';

  return (
    <div className="page page-workspace">
      {/* ---------------- Left: sessions ---------------- */}
      <aside
        ref={sessionsPanelRef}
        id="sessions-panel"
        tabIndex={drawer === 'sessions' ? -1 : undefined}
        className={`col col-sessions${drawer === 'sessions' ? ' drawer-open' : ''}`}
        aria-label="Sessions"
      >
        <div className="sessions-head">
          <h2 className="panel-title">Sessions</h2>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void newSession()}
            disabled={running || !appState.workspaceRoot}
            aria-label="新建会话"
            title="新建会话"
          >
            + 新建
          </Button>
        </div>
        <ul className="session-list" aria-label="会话列表">
          {sessions.summaries.length === 0 && (
            <li className="session session-empty">
              <span className="session-title">暂无会话——点击「+ 新建」开始一段对话（本地持久化）。</span>
            </li>
          )}
          {sessions.summaries.map((s) => (
            <li
              key={s.id}
              className={s.active ? 'session active' : 'session'}
            >
              <button
                type="button"
                className="session-switch"
                onClick={() => void switchSession(s.id)}
                disabled={running || s.active}
                aria-current={s.active ? 'true' : undefined}
                title={`${s.title}（点击切换）`}
              >
                <span className="session-dot" aria-hidden="true" />
                <span className="session-title">{s.title}</span>
                {s.active && <span className="session-badge">当前</span>}
              </button>
              <button
                type="button"
                className="btn btn-ghost session-delete"
                onClick={() => void deleteSession(s.id)}
                disabled={running}
                aria-label={`删除会话 ${s.title}`}
                title="删除会话"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <p className="empty-hint">会话按工作区持久化在 ~/.dsh/desktop/sessions；完全关闭重开后可继续回看。</p>
      </aside>

      {/* ---------------- Middle: conversation ---------------- */}
      <section className="col col-chat" aria-label="Conversation">
        <header className="chat-header">
          {narrow && (
            <div className="drawer-toggles">
              <button
                ref={sessionsToggleRef}
                type="button"
                data-side="sessions"
                className={`btn btn-secondary sidebar-toggle${
                  drawer === 'sessions' ? ' sidebar-toggle-active' : ''
                }`}
                aria-expanded={drawer === 'sessions'}
                aria-controls="sessions-panel"
                aria-label="会话列表"
                title="会话列表"
                onClick={() =>
                  drawer === 'sessions' ? closeDrawer(true) : openDrawer('sessions')
                }
              >
                ☰ 会话
              </button>
              <button
                ref={changesToggleRef}
                type="button"
                data-side="changes"
                className={`btn btn-secondary sidebar-toggle${
                  drawer === 'changes' ? ' sidebar-toggle-active' : ''
                }`}
                aria-expanded={drawer === 'changes'}
                aria-controls="changes-panel"
                aria-label="变更列表"
                title="变更列表"
                onClick={() =>
                  drawer === 'changes' ? closeDrawer(true) : openDrawer('changes')
                }
              >
                ▤ 变更
              </button>
            </div>
          )}
          <span className={statePillClass}>
            <span className="pill-dot" aria-hidden="true" />
            {STATE_LABEL[connection]}
          </span>
          <label className="model-select-label">
            模型
            <select
              className="model-select"
              value={modelChoice}
              disabled={running}
              onChange={(e) => setModelChoice(e.target.value)}
              aria-label="模型选择器（运行中锁定）"
            >
              {availableModels.length === 0 && <option value="">默认模型</option>}
              {availableModels.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {running && (
            <span className="run-lock-hint">
              <Spinner label="运行中" /> 运行中 · 选择器与发送已锁定
            </span>
          )}
        </header>

        {connection === 'crashed' && (() => {
          const crash = status?.crash;
          const copy = agentCrashCopy(crash?.exitCode ?? null, crash?.signal ?? null);
          return (
            <div className="recovery-banner recovery-crash" role="alert">
              <div className="recovery-copy">
                <strong>{copy.what}</strong>
                <p className="recovery-why">{copy.why}</p>
                <p className="recovery-action">{copy.action}</p>
                {copy.detail && <code className="crash-detail">{copy.detail}</code>}
              </div>
              <div className="recovery-actions">
                <Button size="sm" variant="primary" onClick={recoverRestart}>
                  重启 Runtime
                </Button>
                <Button size="sm" variant="secondary" onClick={recoverResume}>
                  恢复会话
                </Button>
              </div>
            </div>
          );
        })()}
        {connection === 'stopped' && status?.lastError != null && status.lastError !== '' && (() => {
          const copy = runtimeStartupFailedCopy(status.lastError);
          return (
            <div className="recovery-banner recovery-startup" role="alert">
              <div className="recovery-copy">
                <strong>{copy.what}</strong>
                <p className="recovery-why">{copy.why}</p>
                <p className="recovery-action">{copy.action}</p>
                {copy.detail && copy.detail.trim() !== '' && (
                  <pre className="startup-stderr">{copy.detail}</pre>
                )}
              </div>
              <Button size="sm" variant="primary" onClick={recoverResume}>
                重试启动
              </Button>
            </div>
          );
        })()}

        <ChatList items={model.items} scrollRef={scrollRef} />

        <footer className="composer">
          <textarea
            className="composer-input"
            value={input}
            placeholder={
              appState.workspaceRoot === null
                ? '未打开工作区——请回首页打开项目后再发送…'
                : connection === 'ready'
                  ? running
                    ? '任务运行中，请等待完成或点击停止…'
                    : '描述你要完成的任务…'
                  : '先在首页启动 Runtime…'
            }
            disabled={appState.workspaceRoot === null || connection !== 'ready' || running}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            aria-label="消息输入框"
          />
          {running ? (
            <Button
              variant="danger"
              onClick={() => void stop()}
              disabled={false /* Stop must stay reachable while waiting for run_cancelled */}
              loading={model.phase === 'awaiting_cancel'}
              aria-label="停止当前任务"
            >
              {model.phase === 'awaiting_cancel' ? '停止中…' : '停止'}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void submit()} disabled={!canSend}>
              发送
            </Button>
          )}
        </footer>
      </section>

      {/* ---------------- Right: changes (DSHA-6) ---------------- */}
      <aside
        ref={changesPanelRef}
        id="changes-panel"
        tabIndex={drawer === 'changes' ? -1 : undefined}
        className={`col col-changes${drawer === 'changes' ? ' drawer-open' : ''}`}
        aria-label="Changes"
      >
        <div className="changes-head">
          <h2 className="panel-title">Changes</h2>
          {/* Read-only current branch display (F7) */}
          {branchLabel !== null && (
            <span
              className={`branch-pill${changes.snapshot?.detached ? ' branch-detached' : ''}`}
              title={changes.snapshot?.detached ? 'HEAD 已分离（只读显示）' : '当前分支（只读显示）'}
            >
              {branchLabel}
            </span>
          )}
        </div>
        {changedFileList.length === 0 ? (
          <p className="empty-hint">
            本次会话还没有文件变更。变更由 file_changed 事件与 Git 状态对账生成，点击条目即可查看 Unified Diff。
          </p>
        ) : (
          <ul className="changes-list" aria-label="变更文件列表">
            {changedFileList.map((c) => {
              const selected = c.path === changes.selectedPath;
              return (
                <li key={`${c.source}:${c.path}`} className="change-row">
                  <button
                    type="button"
                    className={`change change-btn change-${c.kind}${selected ? ' change-selected' : ''}`}
                    onClick={() => openDiff(c.path)}
                    title={`${badgeTitle(c.kind)} · ${c.path}（点击查看 Diff）`}
                    aria-current={selected ? 'true' : undefined}
                  >
                    <span
                      className={`change-kind kind-${c.kind}`}
                      aria-label={badgeTitle(c.kind)}
                      role="img"
                    >
                      {CHANGE_LABEL[c.kind] ?? 'M'}
                    </span>
                    <code className="change-path">{c.path}</code>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {showRunSummary(runActive, changes.snapshot) && (
          <div className="changes-summary-bar" role="status">
            <span className="changes-summary-text">{summaryLabel(changedFileList.length)}</span>
            <Button variant="secondary" onClick={() => { flushNow(); appDispatch({ type: 'navigate', route: 'diff' }); }}>
              View Diff
            </Button>
          </div>
        )}
        {changes.revertError !== null && (
          <p className="changes-error" role="alert">
            恢复失败：{changes.revertError}
          </p>
        )}
      </aside>

      {narrow && drawer !== null && (
        <div
          className="workspace-drawer-backdrop"
          onClick={() => closeDrawer(false)}
          aria-hidden="true"
        />
      )}
      {approvalNotice !== null && (
        <div className="oob-banner approval-notice-banner" role="alert">
          <span>✕ {approvalNotice}</span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setApprovalNotice(null)}
          >
            知道了
          </button>
        </div>
      )}
      {appState.workspaceRoot === null && (
        // 工作区上下文不存在：composer 禁用 + 三段式指引（§3.3/§7.1）。
        <div className="oob-banner session-error-banner" role="alert">
          <span>✕ {describeSessionError(workspaceNotOpenCopy())}</span>
        </div>
      )}
      {sessions.lastError !== null && (
        <div className="oob-banner session-error-banner" role="alert">
          <span>✕ {sessions.lastError}</span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => sessions.dismissError()}
          >
            知道了
          </button>
        </div>
      )}
      <ApprovalModal
        payload={approval}
        sendError={approvalSendError}
        onRespond={(id, decision, scope) => void respondApproval(id, decision, scope)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chat rendering                                                      */
/* ------------------------------------------------------------------ */

function ChatList({
  items,
  scrollRef
}: {
  items: ChatItem[];
  scrollRef: React.RefObject<HTMLDivElement>;
}): JSX.Element {
  return (
    <div className="chat" ref={scrollRef}>
      {items.length === 0 && (
        <div className="empty">
          <p>开始一段对话。Runtime 会以流式返回结果，工具调用、计划、文件读写和子任务都会在这里展示。</p>
        </div>
      )}
      {items.map((item) => (
        <ChatRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function ChatRow({ item }: { item: ChatItem }): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />;
    case 'assistant':
      return <AssistantBubble item={item} />;
    case 'plan':
      return <PlanCard item={item} />;
    case 'tool':
      return item.form === 'terminal' ? <TerminalViewer item={item} /> : <ToolCard item={item} />;
    case 'file_read':
      return <FileReadRow item={item} />;
    case 'file_changed':
      return <FileChangedRow item={item} />;
    case 'subagent':
      return <SubagentCard item={item} />;
    case 'summary':
      return <SummaryCard item={item} />;
    case 'notice':
      return (
        <div className={`notice notice-${item.tone}`} role={item.tone === 'error' ? 'alert' : undefined}>
          <span>{item.text}</span>
        </div>
      );
  }
}

function UserBubble({ item }: { item: UserItem }): JSX.Element {
  return (
    <div className="msg msg-user">
      <p>{item.text}</p>
    </div>
  );
}

function AssistantBubble({ item }: { item: AssistantItem }): JSX.Element {
  return (
    <div className="msg msg-assistant">
      <p>
        {item.text}
        {item.streaming && (
          <span className="stream-cursor" aria-hidden="true">
            ▌
          </span>
        )}
      </p>
    </div>
  );
}

function PlanCard({ item }: { item: PlanItem }): JSX.Element {
  return (
    <details className="plan-card" open>
      <summary>📋 执行计划（{item.steps.length} 步）</summary>
      <ol className="plan-steps">
        {item.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </details>
  );
}

function RiskBadge({ level }: { level: string }): JSX.Element {
  return (
    <span className={`risk-badge ${LEVEL_CLASS[level] ?? 'lvl-l1'}`}>
      {level === 'L0' ? 'L0 只读' : level === 'L1' ? 'L1 常规' : level === 'L2' ? 'L2 危险' : level}
    </span>
  );
}

/** Five elements: tool name · command · L badge · status · output. */
function ToolCard({ item }: { item: ToolCardItem }): JSX.Element {
  const statusLabel =
    item.status === 'running'
      ? '运行中…'
      : item.status === 'ok'
        ? '✓ 完成'
        : item.status === 'failed'
          ? '✗ 失败'
          : '已取消';
  return (
    <details className="tool-card" open={item.status === 'running'}>
      <summary>
        <span className="tool-name">🛠 {item.tool}</span>
        <RiskBadge level={item.level} />
        <span className={`tool-status tool-status-${item.status}`}>{statusLabel}</span>
      </summary>
      {item.command !== undefined && item.command.trim() !== '' && (
        <pre className="tool-command">{item.command}</pre>
      )}
      <div className="tool-basis">{item.basis}</div>
      {item.output.trim() !== '' && <pre className="tool-output">{item.output}</pre>}
    </details>
  );
}

/** Embedded Terminal Output Viewer for shell tool calls. */
function TerminalViewer({ item }: { item: ToolCardItem }): JSX.Element {
  return (
    <div className={`terminal-viewer terminal-${item.status}`} data-testid="terminal-viewer">
      <div className="terminal-head">
        <span className="terminal-title">$ shell</span>
        <RiskBadge level={item.level} />
        <span className={`tool-status tool-status-${item.status}`}>
          {item.status === 'running' ? '运行中…' : item.status === 'ok' ? '✓ 完成' : item.status === 'failed' ? '✗ 失败' : '已取消'}
        </span>
      </div>
      <pre className="terminal-body">
        {item.command !== undefined && `${item.command}\n`}
        {item.output}
        {item.status === 'running' && <span className="stream-cursor">▌</span>}
      </pre>
    </div>
  );
}

function FileReadRow({ item }: { item: FileReadItem }): JSX.Element {
  return (
    <div className="file-row file-read">
      <span aria-hidden="true">📖</span>
      <span className="file-verb">读取</span>
      <code className="file-path">{item.path}</code>
      {item.sizeBytes !== undefined && (
        <span className="file-size">{(item.sizeBytes / 1024).toFixed(1)} KB</span>
      )}
    </div>
  );
}

function FileChangedRow({ item }: { item: FileChangedItem }): JSX.Element {
  return (
    <div className="file-row file-change">
      <span className={`change-kind kind-${item.change}`}>{CHANGE_LABEL[item.change]}</span>
      <span className="file-verb">
        {item.change === 'added' ? '新增' : item.change === 'deleted' ? '删除' : '修改'}
      </span>
      <code className="file-path">{item.path}</code>
    </div>
  );
}

function SubagentCard({ item }: { item: SubagentItem }): JSX.Element {
  const statusLabel =
    item.status === 'running'
      ? '运行中…'
      : item.status === 'ok'
        ? '✓ 完成'
        : item.status === 'failed'
          ? '✗ 失败'
          : '已取消';
  return (
    <details className="subagent-card" open={item.status === 'running'} data-testid="subagent-card">
      <summary>
        <span className="subagent-name">🤖 子任务 · {item.label}</span>
        <span className={`tool-status tool-status-${item.status}`}>{statusLabel}</span>
      </summary>
      {item.output.trim() !== '' && <pre className="subagent-output">{item.output}</pre>}
      {item.summary !== undefined && <p className="subagent-summary">{item.summary}</p>}
      <p className="subagent-placeholder">子任务完整视图将在 P1-D 接入。</p>
    </details>
  );
}

function SummaryCard({ item }: { item: SummaryItem }): JSX.Element {
  return (
    <div className="summary-card" data-testid="summary-card">
      <span className="summary-title">任务摘要</span>
      <p>{item.text}</p>
    </div>
  );
}
