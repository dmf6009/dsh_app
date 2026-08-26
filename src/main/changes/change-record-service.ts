/**
 * Change Record service (issue DSHA-6).
 *
 * Responsibilities:
 *  1. Aggregate `file_changed` events into per-path change records
 *     (re-modifying a file updates its existing record instead of adding a
 *     duplicate row). `file_read` frames feed a separate "touched" ledger —
 *     reading a file is not a change and must never fabricate one (AC-06:
 *     Changes 与实际改动一致).
 *  2. Reconcile those event-driven records against the strictly read-only
 *     git sources (`status --porcelain`, F3 对账兜底): git is authoritative
 *     for paths both sides saw, event-only records survive (runtime writes
 *     outside git or in non-git roots), git-only records are appended so
 *     external edits are caught up too.
 *  3. Revert file (S-5 裁定①): restore the worktree file to its pre-change
 *     content. This is a discardable, L2-grade destructive action gated by a
 *     double confirmation in the UI. Restoration deliberately avoids git
 *     write commands: tracked content is re-written from `git show HEAD:<p>`
 *     (read-only plumbing) with plain filesystem writes, added files are
 *     unlinked. Running revert twice is a safe no-op.
 */

import fs from 'node:fs';
import path from 'node:path';

import type {
  ChangeRecord,
  ChangesSnapshot,
  RevertFileResult
} from '../../shared/changes';
import type { RuntimeEventFrame } from '../../shared/protocol/types';
import {
  currentBranch,
  defaultGitRunner,
  headFileBytes,
  isGitWorkTree,
  normalizeRel,
  safeResolve,
  statusEntries,
  type GitRunner,
  type StatusEntry
} from './git-readonly';

export interface MergeInput {
  eventRecords: ReadonlyArray<ChangeRecord>;
  gitEntries: ReadonlyArray<StatusEntry>;
  nowIso: string;
}

/**
 * Pure reconciliation merge (unit-tested):
 * event order first, git overrides shared paths, git-only paths appended in
 * ascending path order so the result is deterministic.
 */
export function mergeRecords(input: MergeInput): ChangeRecord[] {
  const byPath = new Map<string, ChangeRecord>();
  const order: string[] = [];
  for (const rec of input.eventRecords) {
    if (byPath.has(rec.path)) continue;
    byPath.set(rec.path, { ...rec });
    order.push(rec.path);
  }
  const gitOnly: StatusEntry[] = [];
  for (const entry of input.gitEntries) {
    const key = normalizeRel(entry.path);
    const existing = byPath.get(key);
    if (existing) {
      byPath.set(key, { ...existing, kind: entry.kind, source: 'git', lastSeenAt: input.nowIso });
    } else {
      gitOnly.push({ ...entry, path: key });
    }
  }
  gitOnly.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const merged = order.map((p) => byPath.get(p)!);
  for (const entry of gitOnly) {
    merged.push({
      path: entry.path,
      kind: entry.kind,
      source: 'git',
      firstSeenAt: input.nowIso,
      lastSeenAt: input.nowIso
    });
  }
  return merged;
}

/** Relativize an event path against the workspace root when possible. */
export function normalizeEventPath(root: string | null, rawPath: string): string {
  const cleaned = normalizeRel(String(rawPath ?? '').trim());
  if (root && path.isAbsolute(cleaned)) {
    const rel = path.relative(path.resolve(root), path.resolve(cleaned));
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return normalizeRel(rel);
    }
  }
  return cleaned;
}

export class ChangeRecordService {
  /** Event-driven records keyed by normalized relative path. */
  private readonly eventRecords = new Map<string, ChangeRecord>();
  /** Paths the agent merely READ this session (never shown as changes). */
  private readonly readPaths = new Set<string>();
  /** Cached merged view + branch facts for the active root. */
  private cachedSnapshot: ChangesSnapshot | null = null;
  private cachedRoot: string | null = null;
  private reconciling: Promise<ChangesSnapshot> | null = null;

  constructor(
    private readonly deps: {
      runGit?: GitRunner;
      now?: () => Date;
    } = {}
  ) {}

  /* ---------------- event ingestion ---------------- */

  /**
   * Feed one runtime frame. Returns true when the frame was a terminal run
   * frame (caller usually wants to reconcile against git right away).
   */
  onRuntimeEvent(frame: RuntimeEventFrame, root: string | null): boolean {
    switch (frame.type) {
      case 'run_started':
        return false;
      case 'file_read':
        if (typeof frame.path === 'string' && frame.path.trim() !== '') {
          this.readPaths.add(normalizeEventPath(root, frame.path));
        }
        return false;
      case 'file_changed': {
        if (typeof frame.path !== 'string' || frame.path.trim() === '') return false;
        const p = normalizeEventPath(root, frame.path);
        const kind =
          frame.change === 'added' || frame.change === 'deleted' ? frame.change : 'modified';
        const existing = this.eventRecords.get(p);
        const nowIso = this.now().toISOString();
        if (existing) {
          // Same path again: refresh kind/timestamp, KEEP original position.
          this.eventRecords.set(p, { ...existing, kind, source: 'event', lastSeenAt: nowIso });
        } else {
          this.eventRecords.set(p, {
            path: p,
            kind,
            source: 'event',
            firstSeenAt: nowIso,
            lastSeenAt: nowIso
          });
        }
        this.invalidateCacheFor(root);
        return false;
      }
      case 'run_completed':
      case 'done':
      case 'run_cancelled':
        return true;
      default:
        return false;
      }
  }

  /** Paths observed via file_read (diagnostics; never rendered as changes). */
  get readLedger(): readonly string[] {
    return [...this.readPaths];
  }

  get eventRecordCount(): number {
    return this.eventRecords.size;
  }

  /* ---------------- reconciliation ---------------- */

  /**
   * Rebuild the merged snapshot for `root`. Safe to call concurrently —
   * concurrent callers share one in-flight reconciliation.
   */
  async reconcile(root: string | null): Promise<ChangesSnapshot> {
    if (this.reconciling) return this.cachedSnapshot ?? emptySnapshot(root);
    this.reconciling = this.doReconcile(root).catch(() => {
      return this.cachedSnapshot ?? emptySnapshot(root);
    });
    try {
      return await this.reconciling;
    } finally {
      this.reconciling = null;
    }
  }

  private async doReconcile(root: string | null): Promise<ChangesSnapshot> {
    const run = this.deps.runGit ?? defaultGitRunner;
    let branch: string | null = null;
    let detached = false;
    let gitAvailable = false;
    let entries: StatusEntry[] = [];
    if (root) {
      gitAvailable = await isGitWorkTree(root, run);
      if (gitAvailable) {
        const info = await currentBranch(root, run);
        branch = info.branch;
        detached = info.detached;
        entries = await statusEntries(root, run);
      }
    }
    const nowIso = this.now().toISOString();
    const records = mergeRecords({
      eventRecords: [...this.eventRecords.values()],
      gitEntries: entries,
      nowIso
    });
    const snapshot: ChangesSnapshot = {
      root,
      branch,
      detached,
      gitAvailable,
      records,
      generatedAt: this.now().getTime()
    };
    this.cachedSnapshot = snapshot;
    this.cachedRoot = root;
    return snapshot;
  }

  /** Latest known snapshot; cheap, never spawns git. */
  peekSnapshot(root: string | null): ChangesSnapshot {
    if (this.cachedSnapshot && this.cachedRoot === root) return this.cachedSnapshot;
    return emptySnapshot(root);
  }

  private invalidateCacheFor(_root: string | null): void {
    // Event upserts change the merged view; drop the cache so the next
    // peek/reconcile rebuilds it. Branch facts stay best-effort.
    this.cachedSnapshot = null;
  }

  /* ---------------- revert (S-5) ---------------- */

  async revertFile(root: string | null, relPath: string): Promise<RevertFileResult> {
    const run = this.deps.runGit ?? defaultGitRunner;
    if (!root) return { ok: false, error: '没有打开的工作区' };
    let abs: string;
    try {
      abs = safeResolve(root, relPath);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const rel = normalizeRel(relPath);

    if (!(await isGitWorkTree(root, run))) {
      // Non-git workspace: we can only remove files the runtime ADDED.
      const record = this.eventRecords.get(rel);
      if (record?.kind === 'added') {
        try {
          if (fs.existsSync(abs)) fs.unlinkSync(abs);
        } catch (err) {
          return { ok: false, error: `删除文件失败：${describe(err)}` };
        }
        this.forgetRecord(rel);
        return { ok: true, action: 'deleted-file' };
      }
      return {
        ok: false,
        error: '该目录不是 Git 仓库，无法确定改动前内容；只有本会话内新增的文件可以丢弃'
      };
    }

    const entries = await statusEntries(root, run);
    const entry = entries.find((e) => e.path === rel);
    if (!entry) {
      // Nothing differs from HEAD anymore → reverting again is a no-op.
      this.forgetRecord(rel);
      return { ok: true, noop: true };
    }

    const x = entry.code[0] ?? ' ';
    const y = entry.code[1] ?? ' ';
    const untracked = x === '?';
    const deletionish = x === 'D' || y === 'D';
    const additionish = x === 'A' || y === 'A';

    if (untracked || ((additionish || deletionish) && !(await hasHeadBlob(root, rel, run)))) {
      // File unknown to HEAD: discarding the change means deleting it.
      try {
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch (err) {
        return { ok: false, error: `删除文件失败：${describe(err)}` };
      }
      this.forgetRecord(rel);
      return this.withResidual(await this.stillDirty(root, rel, run), 'deleted-file');
    }

    // Tracked modification or deletion: rewrite worktree content from HEAD
    // (falling back to the index when HEAD lacks the blob). No git write
    // commands are involved — this is a plain filesystem restoration.
    const bytes = (await headFileBytes(root, rel, run)) ?? (await indexFileBytes(root, rel, run));
    if (bytes == null) {
      return { ok: false, error: '无法从 Git 读取改动前内容（HEAD 与索引中均无此文件）' };
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
    } catch (err) {
      return { ok: false, error: `写回文件失败：${describe(err)}` };
    }
    this.forgetRecord(rel);
    const action = deletionish ? 'recreated-file' : 'restored-content';
    return this.withResidual(await this.stillDirty(root, rel, run), action);
  }

  private forgetRecord(rel: string): void {
    this.eventRecords.delete(rel);
  }

  private async stillDirty(root: string, rel: string, run: GitRunner): Promise<boolean> {
    const entries = await statusEntries(root, run);
    return entries.some((e) => e.path === rel);
  }

  private withResidual(residual: boolean, action: 'deleted-file' | 'restored-content' | 'recreated-file'): RevertFileResult {
    // Residual happens only when staged deltas remain (index untouched —
    // git write operations are out of scope). The UI keeps such records.
    return residual ? { ok: true, action, residual: true } : { ok: true, action };
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}

async function hasHeadBlob(root: string, rel: string, run: GitRunner): Promise<boolean> {
  const bytes = await headFileBytes(root, rel, run);
  return bytes != null;
}

/** Index copy (`git show :<path>`) — still a read-only plumbing call. */
async function indexFileBytes(root: string, rel: string, run: GitRunner): Promise<Buffer | null> {
  try {
    const res = await run(root, ['show', `:${normalizeRel(rel)}`]);
    if (res.code !== 0) return null;
    return res.stdoutBytes ?? Buffer.from(res.stdout, 'utf8');
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptySnapshot(root: string | null): ChangesSnapshot {
  return {
    root,
    branch: null,
    detached: false,
    gitAvailable: false,
    records: [],
    generatedAt: 0
  };
}
