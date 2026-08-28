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
  isValidSessionId,
  SESSION_SCHEMA_VERSION,
  validateSessionRecord,
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
    const expectedRoot = expandAndNormalize(workspaceRoot);
    const index = this.loadIndex(dir);
    const resolvedActive = activeId === undefined ? index.activeId : activeId;
    const summaries: SessionSummary[] = [];
    const seen = new Set<string>();
    for (const id of index.sessions) {
      // Enforce workspaceRoot consistency on listing too, so a tampered record
      // that no longer belongs to this workspace is dropped from the list.
      const record = this.loadRecord(dir, id, expectedRoot);
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
   * discard it. Never throws (§ 损坏文件恢复). Only sessions that are members
   * of this workspace's index may be loaded — a forged id that happens to
   * name a file is rejected as not-found.
   */
  load(workspaceRoot: string, id: string): SessionLoadResult {
    if (!isValidSessionId(id)) {
      return { ok: false, error: '会话 id 非法' };
    }
    const dir = this.workspaceDir(workspaceRoot);
    // Index membership: a request for an id that is not part of THIS
    // workspace's index is treated as not-found, so a crafted id cannot read a
    // record belonging to another workspace.
    if (!this.loadIndex(dir).sessions.includes(id)) {
      return { ok: false, error: '会话不存在' };
    }
    const record = this.loadRecord(dir, id, expandAndNormalize(workspaceRoot));
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
   *
   * The record is validated as untrusted input: id shape, index membership,
   * closed item-kind set, per-field types and id/workspaceRoot consistency
   * with the request context are all enforced before a single byte is
   * written.
   */
  save(workspaceRoot: string, record: SessionRecord): SessionMutationResult {
    const normalizedRoot = expandAndNormalize(workspaceRoot);
    const dir = this.workspaceDir(workspaceRoot);
    if (!isValidSessionId(record.id)) {
      return { ok: false, error: '会话 id 非法' };
    }
    if (!this.loadIndex(dir).sessions.includes(record.id)) {
      return { ok: false, error: '会话不存在' };
    }
    const validated = validateSessionRecord(record, {
      expectedId: record.id,
      expectedWorkspaceRoot: normalizedRoot
    });
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }
    const stamped: SessionRecord = {
      ...validated.record,
      schemaVersion: SESSION_SCHEMA_VERSION,
      workspaceRoot: normalizedRoot,
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
    if (!isValidSessionId(id)) {
      return { ok: false, error: '会话 id 非法' };
    }
    const dir = this.workspaceDir(workspaceRoot);
    if (!this.loadIndex(dir).sessions.includes(id)) {
      return { ok: false, error: '会话不存在' };
    }
    this.mutateIndex(dir, (index) => ({ ...index, activeId: id }));
    return { ok: true, id };
  }

  /**
   * Delete a session record and drop it from the index (§15 删除). Idempotent:
   * deleting a missing id is a no-op success. The on-disk record removal is
   * atomic with the index update — if `rmSync` fails the index is NOT mutated
   * and a failure is returned, so the list never claims a deletion that did
   * not happen on disk.
   */
  delete(workspaceRoot: string, id: string): SessionMutationResult {
    if (!isValidSessionId(id)) {
      return { ok: false, error: '会话 id 非法' };
    }
    const dir = this.workspaceDir(workspaceRoot);
    const index = this.loadIndex(dir);
    if (!index.sessions.includes(id)) {
      return { ok: true, id };
    }
    // Remove the record file first. Only on success do we mutate the index —
    // a leftover file is recoverable; a missing-file-but-listed record is not.
    const filePath = this.recordPath(workspaceRoot, id);
    let fileExists = true;
    try {
      fs.rmSync(filePath, { force: true });
    } catch (err) {
      // `force:true` already swallows ENOENT; any other error is real.
      return { ok: false, error: `删除会话文件失败：${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      fileExists = fs.existsSync(filePath);
    } catch {
      fileExists = true;
    }
    if (fileExists) {
      // File survived the rm — do not pretend it was deleted.
      return { ok: false, error: '删除会话文件失败：文件仍存在' };
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

  /**
   * Read + strictly validate one record file. The owning workspace root is
   * passed in (when known) so a disk record whose `workspaceRoot`/`id` was
   * tampered with (or that belongs to a different workspace after a move) is
   * rejected as corrupt rather than loaded. Unknown item kinds and wrong-typed
   * fields are dropped, never force-cast. Returns null on any failure (caller
   * probes file existence to distinguish missing from corrupt).
   */
  private loadRecord(dir: string, id: string, expectedWorkspaceRoot?: string): SessionRecord | null {
    if (!isValidSessionId(id)) return null;
    const filePath = path.join(dir, `${id}.json`);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // corrupt JSON
    }
    // Trust-but-verify: the file's own id must match its filename id, and —
    // when the caller knows the owning workspace — the workspaceRoot must
    // match too. A mismatched record is treated as corrupt so it cannot
    // masquerade as another session or workspace.
    const result = validateSessionRecord(parsed, {
      expectedId: id,
      expectedWorkspaceRoot
    });
    if (!result.ok) return null;
    // Stamp the current schema version (migration) and return the vetted record.
    return { ...result.record, schemaVersion: SESSION_SCHEMA_VERSION };
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
