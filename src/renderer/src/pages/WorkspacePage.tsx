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
import type {
  ApprovalRequestPayload,
} from '../../../shared/approval-protocol';
import type { RuntimeEventFrame } from '../../../shared/protocol/types';
import { ApprovalModal } from '../components/ApprovalModal';
import { Button, Spinner } from '../components/ui';
import {
  INITIAL_MODEL,
  reduceChat,
  type AssistantItem,
  type ChatItem,
  type ChatModel,
  type FileChangedItem,
  type FileReadItem,
  type PlanItem,
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

interface SessionEntry {
  id: string;
  title: string;
  active: boolean;
}

export default function WorkspacePage(): JSX.Element {
  const [model, setModel] = useState<ChatModel>(INITIAL_MODEL);
  const [input, setInput] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('stopped');
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [approval, setApproval] = useState<ApprovalRequestPayload | null>(null);
  /** Review fix 3: retryable send-failure banner while the modal stays open. */
  const [approvalSendError, setApprovalSendError] = useState<string | null>(null);
  const [modelChoice, setModelChoice] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([
    { id: 'local', title: '本地会话', active: true }
  ]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<ChatModel>(INITIAL_MODEL);
  modelRef.current = model;

  const dispatch = useCallback((action: Parameters<typeof reduceChat>[1]): void => {
    setModel((prev) => reduceChat(prev, action));
  }, []);

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
    });

    void window.desktop.getStatus().then((initial) => {
      setStatus(initial);
      setConnection(initial.state);
      if (initial.sessionId !== null && initial.sessionId !== '') {
        setSessions((prev) =>
          prev.some((s) => s.id === initial.sessionId)
            ? prev.map((s) => ({ ...s, active: s.id === initial.sessionId }))
            : [...prev.map((s) => ({ ...s, active: false })), {
                id: initial.sessionId!,
                title: `会话 ${initial.sessionId!.slice(0, 8)}`,
                active: true
              }]
        );
      }
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
    };
  }, [dispatch]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [model.items]);

  /* ---- actions ------------------------------------------------------ */

  const running = model.phase !== 'idle';
  const canSend = connection === 'ready' && !running && input.trim() !== '';

  const submit = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (!canSend) return;
    setInput('');
    dispatch({ type: 'send', text });
    const result = await window.desktop.sendMessage(text);
    if (!result.ok) {
      // No run actually started — release the lock and surface the error.
      setModel((prev) => ({
        ...prev,
        phase: 'idle',
        items: [
          ...prev.items,
          {
            kind: 'notice',
            id: `senderr-${Date.now()}`,
            tone: 'error' as const,
            text: `发送失败：${result.error ?? 'unknown error'}`
          }
        ]
      }));
    }
  }, [input, canSend, dispatch]);

  const stop = useCallback(async (): Promise<void> => {
    if (modelRef.current.phase === 'idle') return;
    dispatch({ type: 'cancel-requested' });
    const result = await window.desktop.cancelRun();
    if (!result.ok) {
      dispatch({ type: 'cancel-failed', error: result.error ?? 'no active run' });
    }
    // Unlock happens only when run_cancelled arrives (AC-11).
  }, [dispatch]);

  const respondApproval = useCallback(
    async (requestId: string, decision: 'allow' | 'reject', scope: 'once' | 'session'): Promise<void> => {
      setApprovalSendError(null);
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
      <aside className="col col-sessions" aria-label="Sessions">
        <h2 className="panel-title">Sessions</h2>
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className={s.active ? 'session active' : 'session'}>
              <span className="session-dot" aria-hidden="true" />
              <span className="session-title">{s.title}</span>
              {s.active && <span className="session-badge">当前</span>}
            </li>
          ))}
        </ul>
        <p className="empty-hint">会话持久化将在后续阶段提供（当前为内存列表）。</p>
      </aside>

      {/* ---------------- Middle: conversation ---------------- */}
      <section className="col col-chat" aria-label="Conversation">
        <header className="chat-header">
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

        {connection === 'crashed' && (
          <div className="recovery-banner recovery-crash" role="alert">
            <div>
              <strong>Runtime 已崩溃</strong>
              {status?.crash != null && (
                <code className="crash-detail">
                  exit={String(status.crash.exitCode ?? '—')} signal={status.crash.signal ?? '—'}
                </code>
              )}
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
        )}
        {connection === 'stopped' && status?.lastError != null && status.lastError !== '' && (
          <div className="recovery-banner recovery-startup" role="alert">
            <div>
              <strong>Runtime 启动失败</strong>
              <pre className="startup-stderr">{status.lastError}</pre>
            </div>
            <Button size="sm" variant="primary" onClick={recoverResume}>
              重试启动
            </Button>
          </div>
        )}

        <ChatList items={model.items} scrollRef={scrollRef} />

        <footer className="composer">
          <textarea
            className="composer-input"
            value={input}
            placeholder={
              connection === 'ready'
                ? running
                  ? '任务运行中，请等待完成或点击停止…'
                  : '描述你要完成的任务…'
                : '先在首页启动 Runtime…'
            }
            disabled={connection !== 'ready' || running}
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

      {/* ---------------- Right: changes ---------------- */}
      <aside className="col col-changes" aria-label="Changes">
        <h2 className="panel-title">Changes</h2>
        {model.changes.length === 0 ? (
          <p className="empty-hint">本次会话还没有文件变更。变更由 file_changed 事件驱动，真实 Diff 视图见后续阶段。</p>
        ) : (
          <ul className="changes-list">
            {model.changes.map((c) => (
              <li key={c.id} className={`change change-${c.change}`}>
                <span className={`change-kind kind-${c.change}`}>{CHANGE_LABEL[c.change]}</span>
                <code className="change-path">{c.path}</code>
              </li>
            ))}
          </ul>
        )}
        <p className="changes-note">变更列表按事件顺序排列；点击条目查看 Diff 的能力由 P1-C 提供。</p>
      </aside>

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
