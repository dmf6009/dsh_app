/**
 * Chat conversation model (issue DSHA-5, §9 seven forms + AC-11 stop flow).
 *
 * Pure reducer: every protocol event / UI action maps to a new ChatModel.
 * No React and no DOM here so the full behaviour matrix stays unit-testable
 * (tests/chat-model.test.ts) and reusable by integration tests.
 *
 * Seven rendered forms:
 *   user bubble · assistant text (streaming cursor) · Plan card · Tool Call
 *   card (name/command/status/output/level badge) · embedded Terminal Output
 *   Viewer for shell tools · File Read / File Changed entries · Sub-Agent
 *   placeholder card. Plus summary / error / stop notices.
 *
 * Stop semantics (AC-11 + Phase-0 memo ①): `run_cancelled` marks every still-
 * running tool card 「已取消」 immediately; a late `tool_completed(cancelled)`
 * for an already-marked card is absorbed without duplicating anything.
 */

import type { ApprovalRequestPayload } from '../../../shared/approval-protocol';
import type { ActionCategory } from '../../../shared/approval-protocol';
import type { RuntimeEventFrame } from '../../../shared/protocol/types';
import type { RiskLevel } from '../../../shared/protocol/types';
import { classifyOperation } from '../../../shared/approval-rules';

export type ToolStatus = 'running' | 'ok' | 'failed' | 'cancelled';
export type Tone = 'info' | 'error' | 'stop';

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
}
export interface AssistantItem {
  kind: 'assistant';
  id: string;
  text: string;
  streaming: boolean;
}
export interface PlanItem {
  kind: 'plan';
  id: string;
  steps: string[];
}
export interface ToolCardItem {
  kind: 'tool';
  id: string;
  toolCallId?: string;
  tool: string;
  command?: string;
  output: string;
  status: ToolStatus;
  /** L0/L1/L2 badge derived with the same rules as the approval engine. */
  level: RiskLevel;
  category: ActionCategory;
  basis: string;
  /** Shell tools render as an embedded terminal viewer instead of a card. */
  form: 'card' | 'terminal';
}
export interface FileReadItem {
  kind: 'file_read';
  id: string;
  path: string;
  sizeBytes?: number;
}
export interface FileChangedItem {
  kind: 'file_changed';
  id: string;
  path: string;
  change: ChangeKind;
}
export interface SubagentItem {
  kind: 'subagent';
  id: string;
  toolCallId?: string;
  label: string;
  output: string;
  status: ToolStatus;
  summary?: string;
}
export interface SummaryItem {
  kind: 'summary';
  id: string;
  text: string;
}
export interface NoticeItem {
  kind: 'notice';
  id: string;
  tone: Tone;
  text: string;
}

export type ChatItem =
  | UserItem
  | AssistantItem
  | PlanItem
  | ToolCardItem
  | FileReadItem
  | FileChangedItem
  | SubagentItem
  | SummaryItem
  | NoticeItem;

export type ChangeKind = 'added' | 'modified' | 'deleted';

/** Right-column Changes feed entry (fed by file_changed events). */
export interface ChangesEntry {
  id: string;
  path: string;
  change: ChangeKind;
}

export type RunPhase = 'idle' | 'running' | 'awaiting_approval' | 'awaiting_cancel';

export interface ChatModel {
  items: ChatItem[];
  phase: RunPhase;
  changes: ChangesEntry[];
}

export const INITIAL_MODEL: ChatModel = { items: [], phase: 'idle', changes: [] };

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export type ChatAction =
  | { type: 'send'; text: string }
  | { type: 'event'; frame: RuntimeEventFrame }
  | { type: 'cancel-requested' }
  | { type: 'cancel-failed'; error?: string }
  | { type: 'approval-opened'; payload: ApprovalRequestPayload }
  | { type: 'approval-resolved'; decision: 'allow' | 'reject' };

const SUBAGENT_TOOLS = new Set(['subagent', 'task', 'spawn_agent', 'agent']);

function normalizeChange(value: unknown): ChangeKind {
  return value === 'added' || value === 'deleted' ? value : 'modified';
}

/** Error cards map well-known provider codes to actionable copy (§31). */
export function describeError(message: string, code?: string | number): string {
  const raw = message.trim();
  switch (String(code ?? '')) {
    case '401':
      return `API Key 无效或未配置（401）：${raw}`;
    case '404':
      return `模型或接口不存在（404）：${raw}`;
    case '429':
      return `请求过于频繁，请稍后重试（429）：${raw}`;
    default:
      return code === undefined || code === null || code === '' ? raw : `${raw} [${code}]`;
  }
}

function lastStreamingAssistantIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === 'assistant' && item.streaming) return i;
    if (item.kind === 'user') break; // a newer turn started
  }
  return -1;
}

interface Toolish {
  kind: 'tool' | 'subagent';
  toolCallId?: string;
  status: ToolStatus;
}

function findOpenToolIndex(items: ChatItem[], toolCallId: string | undefined): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]! as ChatItem & Toolish;
    if (item.kind !== 'tool' && item.kind !== 'subagent') continue;
    if (toolCallId === undefined) {
      if (item.status === 'running') return i;
      continue;
    }
    if (item.toolCallId === toolCallId) return i;
  }
  return -1;
}

/**
 * memo ① — on run_cancelled, close every still-running tool/sub-agent card
 * as cancelled. Cards already terminal (e.g. marked by an earlier
 * tool_completed(cancelled)) are left untouched, which is what makes a later
 * duplicate completion a no-op instead of a second visible transition.
 */
function cancelUnfinishedTools(items: ChatItem[]): ChatItem[] {
  return items.map((item) => {
    if ((item.kind === 'tool' || item.kind === 'subagent') && item.status === 'running') {
      return { ...item, status: 'cancelled' as const };
    }
    return item;
  });
}

/**
 * Close the open streaming bubble. With `replace: true` (message_completed)
 * the runtime's final text is authoritative; otherwise (done.summary) the
 * streamed content stays and the summary only fills an empty bubble.
 */
function endStreamingAssistant(
  items: ChatItem[],
  finalText?: string,
  replace = false
): ChatItem[] {
  const idx = lastStreamingAssistantIndex(items);
  if (idx === -1) return items;
  const current = items[idx] as AssistantItem;
  const hasFinal = finalText !== undefined && finalText.trim() !== '';
  const next = [...items];
  next[idx] = {
    ...current,
    text: hasFinal && (replace || current.text === '') ? finalText! : current.text,
    streaming: false
  };
  return next;
}

/** Apply one protocol event to the model. */
export function reduceEvent(model: ChatModel, frame: RuntimeEventFrame): ChatModel {
  const items = model.items;
  switch (frame.type) {
    case 'run_started':
      return {
        ...model,
        items: [...items, { kind: 'assistant', id: nextId('asst'), text: '', streaming: true }],
        phase: 'running'
      };

    case 'message_delta': {
      const part = typeof frame.content === 'string' ? frame.content : '';
      const next = [...items];
      const idx = lastStreamingAssistantIndex(next);
      if (idx === -1) {
        next.push({ kind: 'assistant', id: nextId('asst'), text: part, streaming: true });
      } else {
        const current = next[idx] as AssistantItem;
        next[idx] = { ...current, text: current.text + part };
      }
      return { ...model, items: next };
    }

    case 'message_completed':
      return {
        ...model,
        items: endStreamingAssistant(
          [...items],
          typeof frame.content === 'string' ? frame.content : undefined,
          true
        )
      };

    case 'plan': {
      const steps = Array.isArray(frame.steps)
        ? frame.steps.map((s: unknown) => String(s))
        : typeof frame.content === 'string' && frame.content.trim() !== ''
          ? [frame.content]
          : [];
      return { ...model, items: [...items, { kind: 'plan', id: nextId('plan'), steps }] };
    }

    case 'tool_started': {
      const classification = classifyOperation({
        tool: frame.tool,
        command: typeof frame.command === 'string' ? frame.command : undefined,
        claimedLevel:
          'risk_level' in frame && typeof frame.risk_level === 'string'
            ? frame.risk_level
            : undefined
      });
      const base = {
        id: nextId('tool'),
        toolCallId: frame.tool_call_id,
        status: 'running' as const
      };
      if (SUBAGENT_TOOLS.has(frame.tool)) {
        // §9 sub-agent placeholder card (full surface arrives with P1-D).
        return {
          ...model,
          items: [
            ...items,
            {
              ...base,
              kind: 'subagent',
              label:
                typeof frame.command === 'string' && frame.command.trim() !== ''
                  ? frame.command
                  : '子任务',
              output: ''
            }
          ]
        };
      }
      return {
        ...model,
        items: [
          ...items,
          {
            ...base,
            kind: 'tool',
            tool: frame.tool,
            command: typeof frame.command === 'string' ? frame.command : undefined,
            output: '',
            level: classification.level,
            category: classification.category,
            basis: classification.basis,
            form: frame.tool === 'shell' ? 'terminal' : 'card'
          }
        ]
      };
    }

    case 'tool_output': {
      const next = [...items];
      const idx = findOpenToolIndex(next, frame.tool_call_id);
      if (idx === -1) return model;
      const item = next[idx]!;
      if (item.kind === 'tool') {
        next[idx] = { ...item, output: item.output + (frame.content ?? '') + '\n' };
      } else if (item.kind === 'subagent') {
        next[idx] = { ...item, output: item.output + (frame.content ?? '') + '\n' };
      }
      return { ...model, items: next };
    }

    case 'tool_completed': {
      const next = [...items];
      const idx = findOpenToolIndex(next, frame.tool_call_id);
      if (idx === -1) return model;
      const item = next[idx]!;
      const status: ToolStatus =
        frame.status === 'failed'
          ? 'failed'
          : frame.status === 'cancelled'
            ? 'cancelled'
            : 'ok';
      if (item.kind === 'tool') {
        // Absorb a redundant cancelled completion for an already-cancelled
        // card (memo ① dedupe): the status stays, nothing else changes.
        if (item.status === 'cancelled' && status === 'cancelled') return model;
        next[idx] = { ...item, status };
      } else if (item.kind === 'subagent') {
        if (item.status === 'cancelled' && status === 'cancelled') return model;
        next[idx] = {
          ...item,
          status,
          summary:
            typeof (frame as { summary?: unknown }).summary === 'string'
              ? ((frame as unknown as { summary: string }).summary as string)
              : item.summary
        };
      }
      return { ...model, items: next };
    }

    case 'file_read':
      return {
        ...model,
        items: [
          ...items,
          {
            kind: 'file_read',
            id: nextId('fread'),
            path: frame.path,
            sizeBytes: typeof frame.size_bytes === 'number' ? frame.size_bytes : undefined
          }
        ]
      };

    case 'file_changed': {
      const change = normalizeChange(frame.change);
      const entry: ChangesEntry = { id: nextId('chg'), path: frame.path, change };
      return {
        ...model,
        items: [
          ...items,
          { kind: 'file_changed', id: nextId('fchg'), path: frame.path, change }
        ],
        changes: [...model.changes, entry]
      };
    }

    case 'error': {
      const mapped = describeError(frame.message, frame.code);
      return {
        ...model,
        items: [...items, { kind: 'notice', id: nextId('notice'), tone: 'error', text: mapped }],
        phase: frame.recoverable === true ? model.phase : 'idle'
      };
    }

    case 'done':
    case 'run_completed': {
      const summary =
        typeof frame.summary === 'string' && frame.summary.trim() !== ''
          ? frame.summary
          : undefined;
      let next = endStreamingAssistant([...items], summary);
      if (summary !== undefined) {
        next = [...next, { kind: 'summary', id: nextId('sum'), text: summary }];
      }
      return { ...model, items: next, phase: 'idle' };
    }

    case 'run_cancelled':
      return {
        ...model,
        items: [
          ...cancelUnfinishedTools(items),
          { kind: 'notice', id: nextId('notice'), tone: 'stop', text: '已被手动停止' }
        ],
        phase: 'idle'
      };

    default:
      // ready / session_created / approval_required / approval_response …
      // are handled outside the transcript (connection pill / modal).
      return model;
  }
}

/** Full reducer including UI-driven actions around the event stream. */
export function reduceChat(model: ChatModel, action: ChatAction): ChatModel {
  switch (action.type) {
    case 'send': {
      const entry: UserItem = { kind: 'user', id: nextId('user'), text: action.text };
      return { ...model, items: [...model.items, entry], phase: 'running' };
    }
    case 'cancel-requested':
      return model.phase === 'running' ? { ...model, phase: 'awaiting_cancel' } : model;
    case 'cancel-failed':
      return {
        ...model,
        phase: 'running',
        items: [
          ...model.items,
          {
            kind: 'notice',
            id: nextId('notice'),
            tone: 'error',
            text: `停止失败：${action.error ?? 'no active run'}`
          }
        ]
      };
    case 'approval-opened':
      return { ...model, phase: 'awaiting_approval' };
    case 'approval-resolved':
      // Either answer returns the pump to running; the runtime reports the
      // consequence itself (continue or error + run_cancelled).
      return { ...model, phase: 'running' };
    default:
      return 'frame' in action ? reduceEvent(model, action.frame) : model;
  }
}
