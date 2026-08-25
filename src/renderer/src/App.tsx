import { useCallback, useEffect, useRef, useState } from 'react';

import type { ConnectionState } from '../../shared/desktop-api';
import type { RuntimeEventFrame } from '../../shared/protocol/types';

/* ------------------------------------------------------------------ */
/* Chat model                                                          */
/* ------------------------------------------------------------------ */

type ToolStatus = 'running' | 'ok' | 'failed' | 'cancelled';
type Tone = 'info' | 'error' | 'stop';

interface UserItem {
  kind: 'user';
  id: string;
  text: string;
}
interface AssistantItem {
  kind: 'assistant';
  id: string;
  text: string;
  streaming: boolean;
}
interface ToolItem {
  kind: 'tool';
  id: string;
  toolCallId?: string;
  tool: string;
  command?: string;
  output: string;
  status: ToolStatus;
}
interface NoticeItem {
  kind: 'notice';
  id: string;
  tone: Tone;
  text: string;
}
type ChatItem = UserItem | AssistantItem | ToolItem | NoticeItem;

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  stopped: '未启动',
  starting: '启动中…',
  ready: '已就绪',
  crashed: '已崩溃'
};

/** Apply one protocol event to the chat transcript. */
function reduce(items: ChatItem[], frame: RuntimeEventFrame): { items: ChatItem[]; endedRun: boolean } {
  switch (frame.type) {
    case 'ready':
      return { items: [...items, notice('info', 'Runtime 已就绪')], endedRun: false };

    case 'run_started': {
      // Start a fresh assistant bubble for this run.
      return {
        items: [...items, { kind: 'assistant', id: nextId('asst'), text: '', streaming: true }],
        endedRun: false
      };
    }

    case 'message_delta': {
      const next = [...items];
      const idx = lastStreamingAssistantIndex(next);
      const part = frame.content ?? '';
      if (idx === -1) {
        next.push({ kind: 'assistant', id: nextId('asst'), text: part, streaming: true });
      } else {
        const current = next[idx] as AssistantItem;
        next[idx] = { ...current, text: current.text + part };
      }
      return { items: next, endedRun: false };
    }

    case 'message_completed': {
      const next = [...items];
      const idx = lastStreamingAssistantIndex(next);
      if (idx !== -1) {
        const current = next[idx] as AssistantItem;
        next[idx] = {
          ...current,
          text: typeof frame.content === 'string' ? frame.content : current.text,
          streaming: false
        };
      }
      return { items: next, endedRun: false };
    }

    case 'plan': {
      const body = Array.isArray(frame.steps)
        ? frame.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : (frame.content ?? '');
      return { items: [...items, notice('info', `Plan\n${body}`)], endedRun: false };
    }

    case 'tool_started':
      return {
        items: [
          ...items,
          {
            kind: 'tool',
            id: nextId('tool'),
            toolCallId: frame.tool_call_id,
            tool: frame.tool,
            command: typeof frame.command === 'string' ? frame.command : undefined,
            output: '',
            status: 'running'
          }
        ],
        endedRun: false
      };

    case 'tool_output': {
      const next = [...items];
      const idx = findToolIndex(next, frame.tool_call_id);
      if (idx !== -1) {
        const tool = next[idx] as ToolItem;
        next[idx] = { ...tool, output: tool.output + (frame.content ?? '') + '\n' };
      }
      return { items: next, endedRun: false };
    }

    case 'tool_completed': {
      const next = [...items];
      const idx = findToolIndex(next, frame.tool_call_id);
      if (idx !== -1) {
        const tool = next[idx] as ToolItem;
        const status: ToolStatus =
          frame.status === 'failed'
            ? 'failed'
            : frame.status === 'cancelled'
              ? 'cancelled'
              : 'ok';
        next[idx] = { ...tool, status };
      }
      return { items: next, endedRun: false };
    }

    case 'file_read':
    case 'file_changed': {
      const verb = frame.type === 'file_read' ? '读取' : '变更';
      const change = 'change' in frame && typeof frame.change === 'string' ? ` (${frame.change})` : '';
      return {
        items: [...items, notice('info', `${verb}文件 ${frame.path}${change}`)],
        endedRun: false
      };
    }

    case 'error': {
      const recoverable = frame.recoverable === true;
      const code = frame.code ? ` [${frame.code}]` : '';
      return {
        items: [...items, notice('error', `${frame.message}${code}`)],
        endedRun: !recoverable
      };
    }

    case 'done':
    case 'run_completed': {
      const summary =
        typeof frame.summary === 'string'
          ? frame.summary
          : typeof frame.content === 'string'
            ? frame.content
            : undefined;
      const next = [...items];
      const idx = lastStreamingAssistantIndex(next);
      if (idx !== -1 && summary && summary.length > 0) {
        // The final summary supersedes streamed deltas once complete.
        const current = next[idx] as AssistantItem;
        next[idx] = { ...current, text: current.text || summary, streaming: false };
      } else if (idx !== -1) {
        const current = next[idx] as AssistantItem;
        next[idx] = { ...current, streaming: false };
      }
      return { items: next, endedRun: true };
    }

    case 'run_cancelled':
      return {
        items: [...items, notice('stop', '已停止当前任务')],
        endedRun: true
      };

    default:
      // approval_required / approval_response etc. are out of Phase 0 scope.
      return { items, endedRun: false };
  }
}

function notice(tone: Tone, text: string): NoticeItem {
  return { kind: 'notice', id: nextId('notice'), tone, text };
}

function lastStreamingAssistantIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === 'assistant' && item.streaming) return i;
    if (item.kind === 'user') break; // a newer turn started
  }
  return -1;
}

function findToolIndex(items: ChatItem[], toolCallId: string | undefined): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind !== 'tool') continue;
    if (toolCallId === undefined) return i;
    if (item.toolCallId === toolCallId) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function App(): JSX.Element {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>('stopped');
  const [commandLine, setCommandLine] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const offEvent = window.desktop.onEvent((frame) => {
      setItems((prev) => {
        const { items: next, endedRun } = reduce(prev, frame);
        if (endedRun) setRunning(false);
        return next;
      });
    });
    const offState = window.desktop.onConnectionState((state) => {
      setConnection(state);
      if (state === 'crashed') setRunning(false);
    });

    void window.desktop
      .getStatus()
      .then((status) => {
        setConnection(status.state);
        setCommandLine(status.commandLine);
      })
      .then(() => window.desktop.startRuntime())
      .then((status) => {
        setConnection(status.state);
        setCommandLine(status.commandLine);
      })
      .catch((err: unknown) => {
        setConnection('crashed');
        setItems((prev) => [
          ...prev,
          notice(
            'error',
            `Runtime 启动失败：${err instanceof Error ? err.message : String(err)}`
          )
        ]);
      });

    return () => {
      offEvent();
      offState();
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || running || connection !== 'ready') return;
    setInput('');
    setItems((prev) => [...prev, { kind: 'user', id: nextId('user'), text }]);
    setRunning(true);
    const result = await window.desktop.sendMessage(text);
    if (!result.ok) {
      setRunning(false);
      setItems((prev) => [
        ...prev,
        notice('error', `发送失败：${result.error ?? 'unknown error'}`)
      ]);
    }
  }, [input, running, connection]);

  const stop = useCallback(async () => {
    const result = await window.desktop.cancelRun();
    if (!result.ok) {
      setRunning(false);
      setItems((prev) => [
        ...prev,
        notice('error', `停止失败：${result.error ?? 'no active run'}`)
      ]);
    }
  }, []);

  const restart = useCallback(async () => {
    try {
      const status = await window.desktop.restartRuntime();
      setConnection(status.state);
    } catch (err) {
      setItems((prev) => [
        ...prev,
        notice('error', `重启失败：${err instanceof Error ? err.message : String(err)}`)
      ]);
    }
  }, []);

  const canSend = connection === 'ready' && !running;

  return (
    <div className="app">
      <header className="topbar">
        <span className="title">DSH Desktop · Phase 0</span>
        <span className={`conn-pill conn-${connection}`}>
          Runtime: {CONNECTION_LABELS[connection]}
        </span>
        {connection === 'crashed' && (
          <button type="button" className="btn" onClick={() => void restart()}>
            重启 Runtime
          </button>
        )}
        <span className="cmdline" title={commandLine}>
          {commandLine}
        </span>
      </header>

      <main className="chat" ref={scrollRef}>
        {items.length === 0 && (
          <div className="empty">
            <p>输入任务并发送，验证 Electron ↔ JSONL ↔ DSH 最小闭环。</p>
            <p className="hint">流式回复、Tool 输出与 Stop 取消均通过 Runtime Protocol v1 驱动。</p>
          </div>
        )}
        {items.map((item) => (
          <ChatRow key={item.id} item={item} />
        ))}
      </main>

      <footer className="composer">
        {!canSend && (
          <div className="composer-hint">
            {running
              ? '任务运行中——可点击 Stop 真正取消。'
              : connection === 'ready'
                ? ''
                : 'Runtime 未就绪，暂不能发送任务。'}
          </div>
        )}
        <textarea
          className="composer-input"
          value={input}
          placeholder="描述一个任务，例如：修复登录接口偶发 500 的问题"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          disabled={running || connection !== 'ready'}
        />
        {running ? (
          <button type="button" className="btn btn-stop" onClick={() => void stop()}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-send"
            onClick={() => void submit()}
            disabled={!canSend || input.trim() === ''}
          >
            发送
          </button>
        )}
      </footer>
    </div>
  );
}

function ChatRow({ item }: { item: ChatItem }): JSX.Element {
  if (item.kind === 'user') {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">{item.text}</div>
      </div>
    );
  }
  if (item.kind === 'assistant') {
    return (
      <div className="row row-assistant">
        <div className={`bubble bubble-assistant${item.streaming ? ' streaming' : ''}`}>
          {item.text}
          {item.streaming && <span className="cursor">▍</span>}
        </div>
      </div>
    );
  }
  if (item.kind === 'tool') {
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
          <span className="tool-name">Tool · {item.tool}</span>
          {item.command && <code className="tool-command">{item.command}</code>}
          <span className={`tool-status tool-status-${item.status}`}>{statusLabel}</span>
        </summary>
        {item.output && <pre className="tool-output">{item.output}</pre>}
      </details>
    );
  }
  return (
    <div className={`notice notice-${item.tone}`}>
      <span>{item.text}</span>
    </div>
  );
}
