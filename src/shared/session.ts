/**
 * Session storage contracts (§15/§16, baseline F10/AC-12) shared between the
 * Electron main process and the renderer.
 *
 * A Session is the persisted unit of one coding conversation. §15 mandates
 * the full field set: User/Agent Messages, Tool Calls, File Changes, Agent
 * State, Model, Token Usage and Creation Time. Everything here is display
 * data only — the protocol layer owns live streaming; this is the durable
 * rest state that survives a full app close/reopen.
 *
 * Local-first (§5.2): records live on disk under the DSH desktop state
 * directory, never sent to any external service. Sessions are scoped to a
 * workspace root so each project keeps its own conversation history.
 */

/** Schema version stamp on every persisted session file (for migrations). */
export const SESSION_SCHEMA_VERSION = 1 as const;

/**
 * The §15 field set as a persisted record. The `items` array is the §9
 * conversation transcript (the same union the chat reducer produces); the
 * top-level scalars carry the per-session metadata §15 names explicitly.
 */
export interface SessionRecord {
  /** Schema version stamp; controls migration on load. */
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  /** Stable id (UUID) — also the runtime `session_id` once a run starts. */
  id: string;
  /** Workspace root absolute path this session belongs to. */
  workspaceRoot: string;
  /** Human title shown in the Sessions list. */
  title: string;
  /** ISO timestamp of session creation (§15 Creation Time). */
  createdAt: string;
  /** ISO timestamp of the last activity in this session. */
  updatedAt: string;
  /** §15 Model: the model selected for this session (cosmetic in MVP). */
  model: string | null;
  /** §15 Agent State: coarse run phase snapshot at last persist. */
  agentState: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_cancel' | 'crashed';
  /** §15 Token Usage: last-reported usage map (best-effort, provider-shaped). */
  tokenUsage: Record<string, number> | null;
  /**
   * §15 transcript: the conversation items (User/Agent Messages, Tool Calls,
   * File Changes, Plan, Summary, Sub-agent, Notice). Stored verbatim so a
   * resumed session renders exactly what was on screen.
   */
  items: SessionItem[];
}

/**
 * One entry of the persisted transcript. A strict subset projection of the
 * renderer ChatItem union — only the fields worth persisting across a
 * restart. Stored without streaming cursors (a closed session is never
 * mid-stream) and without transient derived fields.
 */
export interface SessionItem {
  kind: 'user' | 'assistant' | 'plan' | 'tool' | 'file_read' | 'file_changed' | 'subagent' | 'summary' | 'notice';
  id: string;
  text?: string;
  steps?: string[];
  toolCallId?: string;
  tool?: string;
  command?: string;
  output?: string;
  status?: string;
  level?: string;
  category?: string;
  basis?: string;
  form?: string;
  path?: string;
  change?: string;
  sizeBytes?: number;
  label?: string;
  summary?: string;
  tone?: string;
}

/** Lightweight row for the Sessions sidebar list (no transcript payload). */
export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

/** Result of a create/switch/delete operation against the session store. */
export interface SessionMutationResult {
  ok: boolean;
  /** The session id involved, when ok. */
  id?: string;
  error?: string;
}

/**
 * Result of loading a session record. A missing or corrupt file degrades to a
 * recoverable error instead of crashing the UI (§ test: 损坏文件恢复).
 */
export interface SessionLoadResult {
  ok: boolean;
  record?: SessionRecord;
  error?: string;
  /** True when the file existed but could not be parsed (corrupt). */
  corrupt?: boolean;
}
