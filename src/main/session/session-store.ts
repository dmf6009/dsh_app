/**
 * Session Store (§15/§16, baseline F10/AC-12) — local-first persistence of
 * coding conversations, scoped per workspace root.
 *
 * Records live on disk under `<home>/.dsh/desktop/sessions/<workspaceId>/`
 * with one JSON file per session plus an `index.json` listing. The layout
 * mirrors the Recent Projects + Settings stores (atomic write-then-rename,
 * schema version stamp, corrupt-file tolerance that degrades to empty rather
 * than throwing) so a broken file never blocks the Sessions panel from
 * opening (AC-12: history must always be回看able).
 *
 * No interrupted-task resume (out of scope per the issue: 被中断任务的恢复
 * 不做, P1 之后). The store only persists completed/idle state and loads it
 * back; a resumed session renders its transcript but does not auto-continue
 * a running task.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { expandAndNormalize } from '../workspace/boundary';
import { idForPath } from '../workspace/recent-projects';
import {
  SESSION_SCHEMA_VERSION,
  type SessionItem,
  type SessionLoadResult,
  type SessionMutationResult,
  type SessionRecord,
  type SessionSummary
} from '../../shared/session';

export interface SessionStoreOptions {
  /** Directory holding all session folders; defaults to `~/.dsh/desktop`. */
  baseDirectory?: string;
  now?: () => Date;
  /** Injectable id generator (tests); default crypto.randomUUID. */
  generateId?: () => string;
}

interface StoredIndex {
  version: 1;
  /** Session ids in the order they were created (oldest first). */
  sessions: string[];
  /** Id of the session the UI last switched to, if any. */
  activeId: string | null;
}

export class SessionStore {
  private readonly baseDirectory: string;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(options: SessionStoreOptions = {}) {
    const home = homedir();
    this.baseDirectory = options.baseDirectory ?? path.join(home, '.dsh', 'desktop');
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? (() => randomUUID());
  }

  /* ---- Listing (§15 multi-session create/switch/delete) -------------- */

  /**
   * Summaries for the Sessions sidebar, newest-updated first. A missing or
   * corrupt index degrades to an empty list — the panel still renders.
   *
   * The active session is resolved from the persisted index unless an explicit
   * `activeId` is passed (used by callers that already hold the resolved id).
   */
  listSummaries(workspaceRoot: string, activeId: string | null | undefined = undefined): SessionSummary[] {
    const dir = this.workspaceDir(workspaceRoot);
    const index = this.loadIndex(dir);
    const resolvedActive = activeId === undefined ? index.activeId : activeId;
    const summaries: SessionSummary[] = [];
    const seen = new Set<string>();
    for (const id of index.sessions) {
      const record = this.loadRecord(dir, id);
      if (record === null) continue; // corrupt/missing file — skip, keep listing
      seen.add(id);
      summaries.push({
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        active: resolvedActive === id
      });
    }
    // Newest-updated first so the most recent conversation floats to the top.
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  /**
   * Persisted index of the active session for a workspace. Used on app reopen
   * to restore which conversation the user was looking at (AC-12).
   */
  getActiveId(workspaceRoot: string): string | null {
    return this.loadIndex(this.workspaceDir(workspaceRoot)).activeId;
  }

  /* ---- Create / Load / Delete ---------------------------------------- */

  /**
   * Create a new session record and persist it. The new session becomes the
   * active one. Returns the fresh record.
   */
  create(workspaceRoot: string, title?: string): SessionRecord {
    const dir = this.workspaceDir(workspaceRoot);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = this.generateId();
    const stamp = this.now().toISOString();
    const record: SessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      workspaceRoot: expandAndNormalize(workspaceRoot),
      title: (title && title.trim() !== '') ? title.trim() : `会话 ${stamp.slice(0, 16).replace('T', ' ')}`,
      createdAt: stamp,
      updatedAt: stamp,
      model: null,
      agentState: 'idle',
      tokenUsage: null,
      items: []
    };
    this.writeRecord(dir, record);
    this.mutateIndex(dir, (index) => ({
      ...index,
      sessions: index.sessions.includes(id) ? index.sessions : [...index.sessions, id],
      activeId: id
    }));
    return record;
  }

  /**
   * Load one session record. A missing file is a soft failure (the session
   * may have been deleted); a corrupt file is flagged so the UI can offer to
   * discard it. Never throws (§ 损坏文件恢复).
   */
  load(workspaceRoot: string, id: string): SessionLoadResult {
    const record = this.loadRecord(this.workspaceDir(workspaceRoot), id);
    if (record === null) {
      // Distinguish missing from corrupt by probing the raw file.
      const filePath = this.recordPath(workspaceRoot, id);
      let exists = false;
      try {
        exists = fs.statSync(filePath).isFile();
      } catch {
        exists = false;
      }
      return exists
        ? { ok: false, corrupt: true, error: '会话文件已损坏，无法读取' }
        : { ok: false, error: '会话不存在' };
    }
    return { ok: true, record };
  }

  /**
   * Persist the full transcript + metadata of an existing session. Called by
   * the renderer whenever the conversation state should be checkpointed
   * (after a run completes, on session switch, before app close).
   */
  save(workspaceRoot: string, record: SessionRecord): SessionMutationResult {
    const dir = this.workspaceDir(workspaceRoot);
    if (!this.loadIndex(dir).sessions.includes(record.id)) {
      return { ok: false, error: '会话不存在' };
    }
    const stamped: SessionRecord = {
      ...record,
      schemaVersion: SESSION_SCHEMA_VERSION,
      workspaceRoot: expandAndNormalize(workspaceRoot),
      updatedAt: this.now().toISOString()
    };
    try {
      this.writeRecord(dir, stamped);
      return { ok: true, id: stamped.id };
    } catch (err) {
      return { ok: false, error: `保存会话失败：${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Mark a session as the active one (§15 切换). */
  switchTo(workspaceRoot: string, id: string): SessionMutationResult {
    const dir = this.workspaceDir(workspaceRoot);
    if (!this.loadIndex(dir).sessions.includes(id)) {
      return { ok: false, error: '会话不存在' };
    }
    this.mutateIndex(dir, (index) => ({ ...index, activeId: id }));
    return { ok: true, id };
  }

  /**
   * Delete a session record and drop it from the index (§15 删除). Idempotent:
   * deleting a missing id is a no-op success.
   */
  delete(workspaceRoot: string, id: string): SessionMutationResult {
    const dir = this.workspaceDir(workspaceRoot);
    const index = this.loadIndex(dir);
    if (!index.sessions.includes(id)) {
      return { ok: true, id };
    }
    try {
      fs.rmSync(this.recordPath(workspaceRoot, id), { force: true });
    } catch {
      /* best-effort */
    }
    const remaining = index.sessions.filter((sid) => sid !== id);
    const nextActive = index.activeId === id ? (remaining[remaining.length - 1] ?? null) : index.activeId;
    this.writeIndex(dir, { version: 1, sessions: remaining, activeId: nextActive });
    return { ok: true, id };
  }

  /* ---- Paths ---------------------------------------------------------- */

  /** Workspace id reuses the recent-projects stable id (base64url of path). */
  workspaceDir(workspaceRoot: string): string {
    return path.join(this.baseDirectory, 'sessions', idForPath(expandAndNormalize(workspaceRoot)));
  }

  recordPath(workspaceRoot: string, id: string): string {
    return path.join(this.workspaceDir(workspaceRoot), `${id}.json`);
  }

  get indexPath(): string {
    return path.join(this.baseDirectory, 'sessions', 'index.json');
  }

  /* ---- Low-level IO --------------------------------------------------- */

  private loadRecord(dir: string, id: string): SessionRecord | null {
    const filePath = path.join(dir, `${id}.json`);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as SessionRecord;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed.id !== 'string' ||
        !Array.isArray(parsed.items)
      ) {
        return null; // corrupt — caller distinguishes via file existence probe
      }
      // Migrate / normalize: stamp current schema version if older.
      const items = parsed.items.map(normalizeItem).filter((v): v is SessionItem => v !== null);
      return { ...parsed, schemaVersion: SESSION_SCHEMA_VERSION, items };
    } catch {
      return null;
    }
  }

  private loadIndex(dir: string): StoredIndex {
    const filePath = path.join(dir, 'index.json');
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { version: 1, sessions: [], activeId: null };
    }
    try {
      const parsed = JSON.parse(raw) as StoredIndex;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray(parsed.sessions) ||
        (parsed.activeId !== null && typeof parsed.activeId !== 'string')
      ) {
        // Corrupt index: rebuild from the session files that actually exist
        // on disk so a broken index never hides valid sessions.
        return this.rebuildIndex(dir);
      }
      return { version: 1, sessions: parsed.sessions, activeId: parsed.activeId ?? null };
    } catch {
      return this.rebuildIndex(dir);
    }
  }

  /**
   * Recover an index from the files on disk when index.json is missing or
   * corrupt. This is the § 损坏文件恢复 path for the index itself.
   */
  private rebuildIndex(dir: string): StoredIndex {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { version: 1, sessions: [], activeId: null };
    }
    const sessions: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'index.json') continue;
      const id = entry.name.slice(0, -5);
      // Only keep ids whose record actually parses — corrupt files are dropped
      // from the index but left on disk so the user can recover them.
      if (this.loadRecord(dir, id) !== null) {
        sessions.push(id);
      }
    }
    return { version: 1, sessions, activeId: sessions.at(-1) ?? null };
  }

  private writeIndex(dir: string, index: StoredIndex): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `index.tmp-${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(dir, 'index.json'));
  }

  private writeRecord(dir: string, record: SessionRecord): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `${record.id}.tmp-${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, path.join(dir, `${record.id}.json`));
  }

  private mutateIndex(dir: string, fn: (index: StoredIndex) => StoredIndex): void {
    const next = fn(this.loadIndex(dir));
    this.writeIndex(dir, next);
  }
}

/**
 * Normalize one persisted transcript item defensively: drop anything that is
 * not a plain object with a string `kind`, and trim unknown fields later code
 * won't expect. Keeps load resilient to hand-edited or partially-written files.
 */
function normalizeItem(value: unknown): SessionItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item['kind'] !== 'string') return null;
  const out: SessionItem = { kind: item['kind'] as SessionItem['kind'], id: typeof item['id'] === 'string' ? item['id'] : '' };
  for (const key of [
    'text', 'steps', 'toolCallId', 'tool', 'command', 'output', 'status',
    'level', 'category', 'basis', 'form', 'path', 'change', 'sizeBytes',
    'label', 'summary', 'tone'
  ] as const) {
    if (key in item && item[key] !== undefined && item[key] !== null) {
      (out as unknown as Record<string, unknown>)[key] = item[key];
    }
  }
  return out;
}
