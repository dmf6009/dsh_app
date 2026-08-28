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

/* ------------------------------------------------------------------ */
/* Trusted-input validation (S-4 hardening)                            */
/*                                                                    */
/* Renderer / disk-persisted content is NOT trusted. These pure guards   */
/* enforce a fixed session-id shape, a closed `kind` set, per-field    */
/* type checks and record/context consistency so a malformed payload    */
/* can never traverse the filesystem or be force-cast into a live       */
/* SessionRecord. Used by the main-process SessionStore AND the IPC     */
/* boundary so both layers apply identical rules.                      */
/* ------------------------------------------------------------------ */

/**
 * Acceptable session id shape. Allows the runtime-generated UUID form and the
 * `sess-<digits>` test form, but rejects anything that could traverse
 * directories (`/`, `\\`, `..`, NUL, control chars) or name the index file.
 * Length-bounded to keep the on-disk filename sane.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** True iff `id` is a safe, path-traversal-free session id. */
export function isValidSessionId(id: unknown): id is string {
  if (typeof id !== 'string' || id === '' || id === 'index') return false;
  if (id.includes('.') && id !== '') {
    // Reject ids that look like filenames (an id with an extension could
    // collide with or shadow a record file by name).
    if (id.includes('.json')) return false;
  }
  return SESSION_ID_PATTERN.test(id);
}

/** Every `kind` value a persisted transcript item may legitimately take. */
export const SESSION_ITEM_KINDS: ReadonlySet<string> = new Set([
  'user', 'assistant', 'plan', 'tool', 'file_read', 'file_changed',
  'subagent', 'summary', 'notice'
]);

/** Per-field type guards for the optional SessionItem fields. */
const ITEM_FIELD_TYPES: Record<string, (v: unknown) => boolean> = {
  text: (v) => typeof v === 'string',
  steps: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  toolCallId: (v) => typeof v === 'string',
  tool: (v) => typeof v === 'string',
  command: (v) => typeof v === 'string',
  output: (v) => typeof v === 'string',
  status: (v) => typeof v === 'string',
  level: (v) => typeof v === 'string',
  category: (v) => typeof v === 'string',
  basis: (v) => typeof v === 'string',
  form: (v) => typeof v === 'string',
  path: (v) => typeof v === 'string',
  change: (v) => typeof v === 'string',
  sizeBytes: (v) => typeof v === 'number' && Number.isFinite(v),
  label: (v) => typeof v === 'string',
  summary: (v) => typeof v === 'string',
  tone: (v) => typeof v === 'string'
};

/**
 * Strictly validate one transcript item. Returns a clean SessionItem with only
 * known, well-typed fields (unknown kinds and wrong-typed fields are dropped
 * or rejected). Never throws — corrupt items become `null` for the caller to
 * skip, so a single bad row never poisons the whole record.
 *
 * `rejectUnknownKind` controls whether an item whose `kind` is not in the
 * closed set is dropped (true, the default — disk content is untrusted) or
 * kept as-is (false — only used internally where a kind was already vetted).
 */
export function validateSessionItem(
  value: unknown,
  rejectUnknownKind = true
): SessionItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const kind = item['kind'];
  if (typeof kind !== 'string') return null;
  if (rejectUnknownKind && !SESSION_ITEM_KINDS.has(kind)) return null;
  const id = item['id'];
  if (typeof id !== 'string' || id === '') return null;
  const out: SessionItem = { kind: kind as SessionItem['kind'], id };
  for (const [key, guard] of Object.entries(ITEM_FIELD_TYPES)) {
    if (key in item && item[key] !== undefined && item[key] !== null) {
      if (guard(item[key])) {
        (out as unknown as Record<string, unknown>)[key] = item[key];
      }
      // Wrong-typed fields are silently dropped, never force-cast.
    }
  }
  return out;
}

const AGENT_STATES: ReadonlySet<string> = new Set([
  'idle', 'running', 'awaiting_approval', 'awaiting_cancel', 'crashed'
]);

/**
 * Validate a full SessionRecord payload arriving from the renderer (save IPC)
 * or read from disk. Enforces the §15 field set with strict types and the
 * closed item-kind set; rejects records whose `id` / `workspaceRoot` do not
 * match the caller's context (cross-workspace / forged-id protection).
 *
 * Returns `{ ok, record, error }` — never throws — so callers degrade a bad
 * record to a recoverable error instead of executing it.
 */
export function validateSessionRecord(
  value: unknown,
  context: { expectedId?: string; expectedWorkspaceRoot?: string } = {}
): { ok: true; record: SessionRecord } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: '会话记录不是合法对象' };
  }
  const r = value as Record<string, unknown>;
  if (!isValidSessionId(r['id'])) {
    return { ok: false, error: '会话 id 非法' };
  }
  if (context.expectedId !== undefined && r['id'] !== context.expectedId) {
    return { ok: false, error: '会话 id 与请求上下文不一致' };
  }
  if (typeof r['workspaceRoot'] !== 'string' || r['workspaceRoot'].trim() === '') {
    return { ok: false, error: 'workspaceRoot 缺失或非法' };
  }
  if (
    context.expectedWorkspaceRoot !== undefined &&
    r['workspaceRoot'] !== context.expectedWorkspaceRoot
  ) {
    return { ok: false, error: 'workspaceRoot 与当前工作区不一致' };
  }
  if (typeof r['title'] !== 'string') return { ok: false, error: 'title 字段非法' };
  if (typeof r['createdAt'] !== 'string' || typeof r['updatedAt'] !== 'string') {
    return { ok: false, error: '时间戳字段非法' };
  }
  if (r['model'] !== null && typeof r['model'] !== 'string') {
    return { ok: false, error: 'model 字段非法' };
  }
  if (r['agentState'] !== null && typeof r['agentState'] !== 'string') {
    return { ok: false, error: 'agentState 字段非法' };
  }
  if (typeof r['agentState'] === 'string' && !AGENT_STATES.has(r['agentState'])) {
    return { ok: false, error: 'agentState 取值非法' };
  }
  if (r['tokenUsage'] !== null) {
    const usage = r['tokenUsage'];
    if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
      return { ok: false, error: 'tokenUsage 字段非法' };
    }
    // Per-value guard: the map is force-cast to Record<string, number>, so
    // every value must actually be a finite number — a NaN/Infinity/string
    // value would otherwise ride along unvalidated.
    for (const value of Object.values(usage)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: 'tokenUsage 字段非法' };
      }
    }
  }
  if (!Array.isArray(r['items'])) {
    return { ok: false, error: 'items 不是数组' };
  }
  const items: SessionItem[] = [];
  for (const raw of r['items']) {
    const validated = validateSessionItem(raw, true);
    if (validated === null) continue; // drop bad rows instead of poisoning the record
    items.push(validated);
  }
  const record: SessionRecord = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: r['id'],
    workspaceRoot: r['workspaceRoot'],
    title: r['title'],
    createdAt: r['createdAt'],
    updatedAt: r['updatedAt'],
    model: r['model'] === null ? null : r['model'] as string,
    agentState: r['agentState'] === null ? 'idle' : r['agentState'] as SessionRecord['agentState'],
    tokenUsage: r['tokenUsage'] === null ? null : r['tokenUsage'] as Record<string, number>,
    items
  };
  return { ok: true, record };
}
