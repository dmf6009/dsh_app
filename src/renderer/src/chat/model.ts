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
import type { SessionItem } from '../../../shared/session';
import { modelApiErrorCopy } from '../../../shared/error-copy';
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

/**
 * Error cards map well-known provider codes to actionable copy (§32 三段式:
 * 发生了什么 / 为什么 / 建议动作), preserving the raw diagnostic message so
 * support can diagnose. The §32 model-API scenario (401/404/429) lands here as
 * an inline notice card inside the message stream.
 */
export function describeError(message: string, code?: string | number): string {
  const copy = modelApiErrorCopy(message, code);
  // Single-string projection for the persisted notice card; the raw diagnostic
  // is kept on its own line so it survives a copy/paste into a bug report.
  return [copy.what, `原因：${copy.why}`, `建议：${copy.action}`, copy.detail ? `原始信息：${copy.detail}` : null]
    .filter((line): line is string => line !== null && line !== '')
    .join('\n');
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

/* ------------------------------------------------------------------ */
/* Session persistence projection (§15, F10/AC-12)                     */
/* ------------------------------------------------------------------ */

/**
 * Project the live ChatModel transcript into the persisted SessionItem form.
 * Streaming cursors and transient derived fields are dropped: a saved session
 * is a rest state, never mid-stream. Each kind contributes only the fields
 * worth回看 across a restart.
 */
export function toSessionItems(items: ChatItem[]): SessionItem[] {
  return items
    // Drop empty streaming-placeholder assistant bubbles: they carry no
    // content worth persisting across a restart and only clutter the record.
    .filter((item) => !(item.kind === 'assistant' && item.text.trim() === ''))
    .map((item): SessionItem => {
    const base: SessionItem = { kind: item.kind, id: item.id };
    switch (item.kind) {
      case 'user':
        return { ...base, text: item.text };
      case 'assistant':
        return { ...base, text: item.text, status: item.streaming ? 'running' : 'ok' };
      case 'plan':
        return { ...base, steps: item.steps };
      case 'tool':
        return {
          ...base,
          toolCallId: item.toolCallId,
          tool: item.tool,
          command: item.command,
          output: item.output,
          status: item.status,
          level: item.level,
          category: item.category,
          basis: item.basis,
          form: item.form
        };
      case 'file_read':
        return { ...base, path: item.path, sizeBytes: item.sizeBytes };
      case 'file_changed':
        return { ...base, path: item.path, change: item.change };
      case 'subagent':
        return {
          ...base,
          toolCallId: item.toolCallId,
          label: item.label,
          output: item.output,
          status: item.status,
          summary: item.summary
        };
      case 'summary':
        return { ...base, text: item.text };
      case 'notice':
        return { ...base, text: item.text, tone: item.tone };
    }
  });
}

/**
 * Inverse projection: rebuild a ChatModel from persisted SessionItems so a
 * resumed session renders exactly what was on screen. Streaming flags are
 * cleared — a loaded session is always at rest (no interrupted-task resume).
 */
export function fromSessionItems(items: SessionItem[]): ChatItem[] {
  return items.map((item): ChatItem => {
    const id = item.id || `restored-${Math.random().toString(36).slice(2, 8)}`;
    switch (item.kind) {
      case 'user':
        return { kind: 'user', id, text: item.text ?? '' };
      case 'assistant':
        return { kind: 'assistant', id, text: item.text ?? '', streaming: false };
      case 'plan':
        return { kind: 'plan', id, steps: Array.isArray(item.steps) ? item.steps : [] };
      case 'tool':
        return {
          kind: 'tool',
          id,
          toolCallId: item.toolCallId,
          tool: item.tool ?? 'tool',
          command: item.command,
          output: item.output ?? '',
          status: (item.status as ToolStatus) ?? 'ok',
          level: (item.level as RiskLevel) ?? 'L1',
          category: (item.category as ActionCategory) ?? 'shell',
          basis: item.basis ?? '',
          form: item.form === 'terminal' ? 'terminal' : 'card'
        };
      case 'file_read':
        return { kind: 'file_read', id, path: item.path ?? '', sizeBytes: item.sizeBytes };
      case 'file_changed':
        return {
          kind: 'file_changed',
          id,
          path: item.path ?? '',
          change: (item.change as ChangeKind) ?? 'modified'
        };
      case 'subagent':
        return {
          kind: 'subagent',
          id,
          toolCallId: item.toolCallId,
          label: item.label ?? '子任务',
          output: item.output ?? '',
          status: (item.status as ToolStatus) ?? 'ok',
          summary: item.summary
        };
      case 'summary':
        return { kind: 'summary', id, text: item.text ?? '' };
      case 'notice':
        return {
          kind: 'notice',
          id,
          tone: (item.tone as Tone) ?? 'info',
          text: item.text ?? ''
        };
    }
  });
}
