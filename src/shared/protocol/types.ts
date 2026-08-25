/**
 * Runtime Protocol v1 — shared type definitions.
 *
 * One JSON object per line over the DSH child process stdio (JSONL, §20).
 * `v` is always 1 in this phase.
 *
 * Event names cover the full set required by the requirements doc §21;
 * Phase 0 implements only the minimal closed loop:
 *   commands:  run / cancel
 *   events:    message_delta, message_completed, tool_started, tool_output,
 *              tool_completed, done, error, run_cancelled
 * The remaining event types are declared here so later phases can adopt them
 * without breaking the wire format.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Every event name defined by §21 plus the `done` terminal alias of §20. */
export const RUNTIME_EVENT_TYPES = [
  'ready',
  'session_created',

  'run_started',

  'message_delta',
  'message_completed',

  'plan',

  'tool_started',
  'tool_output',
  'tool_completed',

  'file_read',
  'file_changed',

  'approval_required',
  'approval_response',

  'error',

  'run_completed',
  'run_cancelled',

  // §20 example uses `done` as the terminal frame; kept as a documented
  // alias of `run_completed` so either may arrive on the wire.
  'done'
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

/** Events that terminate the currently active run. */
export const TERMINAL_EVENT_TYPES = ['run_completed', 'done', 'run_cancelled'] as const;
export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

export function isTerminalEventType(type: RuntimeEventType): type is TerminalEventType {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(type);
}

/* ------------------------------------------------------------------ */
/* Desktop → DSH command frames                                        */
/* ------------------------------------------------------------------ */

export interface RunCommandFrame {
  v: typeof PROTOCOL_VERSION;
  type: 'run';
  /** Client-generated id used to correlate events with this request. */
  run_id: string;
  session_id: string;
  workspace: string;
  message: string;
}

export interface CancelCommandFrame {
  v: typeof PROTOCOL_VERSION;
  type: 'cancel';
  /** When omitted, cancels whatever run is currently active. */
  run_id?: string;
}

export type CommandFrame = RunCommandFrame | CancelCommandFrame;

export function makeRunCommand(
  input: Pick<RunCommandFrame, 'run_id' | 'session_id' | 'workspace' | 'message'>
): RunCommandFrame {
  return { v: PROTOCOL_VERSION, type: 'run', ...input };
}

export function makeCancelCommand(runId?: string): CancelCommandFrame {
  return run_id_or_default(runId);
}

function run_id_or_default(runId?: string): CancelCommandFrame {
  return runId === undefined
    ? { v: PROTOCOL_VERSION, type: 'cancel' }
    : { v: PROTOCOL_VERSION, type: 'cancel', run_id: runId };
}

/* ------------------------------------------------------------------ */
/* DSH → Desktop event frames                                          */
/* ------------------------------------------------------------------ */

interface EventBase {
  v: typeof PROTOCOL_VERSION;
  type: RuntimeEventType;
  run_id?: string;
  session_id?: string;
}

export interface ReadyEventFrame extends EventBase {
  type: 'ready';
  profile?: string;
  pid?: number;
  dsh_version?: string;
}

export interface SessionCreatedEventFrame extends EventBase {
  type: 'session_created';
  session_id: string;
}

export interface RunStartedEventFrame extends EventBase {
  type: 'run_started';
  run_id: string;
}

export interface MessageDeltaEventFrame extends EventBase {
  type: 'message_delta';
  content: string;
}

export interface MessageCompletedEventFrame extends EventBase {
  type: 'message_completed';
  /** Full text of the completed message when the runtime can provide it. */
  content?: string;
}

export interface PlanEventFrame extends EventBase {
  type: 'plan';
  steps?: string[];
  content?: string;
}

export interface ToolStartedEventFrame extends EventBase {
  type: 'tool_started';
  tool_call_id?: string;
  tool: string;
  input?: unknown;
  /** e.g. shell command line, if the tool is a shell invocation. */
  command?: string;
}

export interface ToolOutputEventFrame extends EventBase {
  type: 'tool_output';
  tool_call_id?: string;
  content: string;
  stream?: 'stdout' | 'stderr' | 'stdio';
}

export interface ToolCompletedEventFrame extends EventBase {
  type: 'tool_completed';
  tool_call_id?: string;
  status?: 'ok' | 'failed' | 'cancelled';
  exit_code?: number;
  duration_ms?: number;
}

export interface FileReadEventFrame extends EventBase {
  type: 'file_read';
  path: string;
  size_bytes?: number;
}

export interface FileChangedEventFrame extends EventBase {
  type: 'file_changed';
  path: string;
  change?: 'added' | 'modified' | 'deleted';
}

export interface ApprovalRequiredEventFrame extends EventBase {
  type: 'approval_required';
  approval_id?: string;
  tool?: string;
  risk_level?: 'L0' | 'L1' | 'L2';
  summary?: string;
  command?: string;
}

export interface ApprovalResponseEventFrame extends EventBase {
  type: 'approval_response';
  approval_id?: string;
  decision?: 'allow' | 'reject';
}

export interface ErrorEventFrame extends EventBase {
  type: 'error';
  code?: string;
  message: string;
  recoverable?: boolean;
}

export interface RunCompletedEventFrame extends EventBase {
  type: 'run_completed';
  summary?: string;
  content?: string;
  usage?: Record<string, unknown>;
}

/** Documented alias of `run_completed` (§20 wire example). */
export interface DoneEventFrame extends Omit<RunCompletedEventFrame, 'type'> {
  type: 'done';
}

export interface RunCancelledEventFrame extends EventBase {
  type: 'run_cancelled';
  reason?: string;
}

export type RuntimeEventFrame =
  | ReadyEventFrame
  | SessionCreatedEventFrame
  | RunStartedEventFrame
  | MessageDeltaEventFrame
  | MessageCompletedEventFrame
  | PlanEventFrame
  | ToolStartedEventFrame
  | ToolOutputEventFrame
  | ToolCompletedEventFrame
  | FileReadEventFrame
  | FileChangedEventFrame
  | ApprovalRequiredEventFrame
  | ApprovalResponseEventFrame
  | ErrorEventFrame
  | RunCompletedEventFrame
  | DoneEventFrame
  | RunCancelledEventFrame;

/* ------------------------------------------------------------------ */
/* Narrowing helpers                                                   */
/* ------------------------------------------------------------------ */

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(RUNTIME_EVENT_TYPES);

/**
 * Structural check for an inbound frame. Deliberately lenient about payload
 * fields (the runtime owns them) and strict about the envelope.
 */
export function isRuntimeEventFrame(value: unknown): value is RuntimeEventFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  if (frame['v'] !== PROTOCOL_VERSION) return false;
  return EVENT_TYPE_SET.has(frame['type'] as string);
}

/** True for any frame shape that at least looks like a protocol frame. */
export function isProtocolEnvelope(value: unknown): value is { v: number; type: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return frame['v'] === PROTOCOL_VERSION && typeof frame['type'] === 'string';
}
