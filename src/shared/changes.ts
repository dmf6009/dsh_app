/**
 * Change visualization layer contracts (issue DSHA-6, F3/F7/AC-09/S-5).
 *
 * Shared between the main-process Change Record service and the renderer
 * Changes panel / Diff page. Everything here is display data only: the git
 * side is strictly read-only (F3 baseline ruling — no git write operations),
 * and file restoration for Revert is performed as plain workspace filesystem
 * writes (S-5), never through mutating git commands.
 */

export type ChangeKind = 'added' | 'modified' | 'deleted';

/** Where a change record was last observed from. */
export type ChangeSource = 'event' | 'git';

/** One entry of the right-column Changes list / Diff page Changed Files. */
export interface ChangeRecord {
  /** Workspace-relative path with `/` separators (normalized, no `./`). */
  path: string;
  kind: ChangeKind;
  source: ChangeSource;
  /** ISO timestamp when this path first appeared (stable ordering anchor). */
  firstSeenAt: string;
  /** ISO timestamp of the most recent observation. */
  lastSeenAt: string;
}

/** Result of reconciling runtime events against the read-only git sources. */
export interface ChangesSnapshot {
  /** Active workspace root; null before a project is opened. */
  root: string | null;
  /**
   * Current branch name (read-only `git rev-parse --abbrev-ref HEAD`).
   * null when the root is not a git work tree.
   */
  branch: string | null;
  /** True while HEAD is detached — `branch` then holds the short SHA. */
  detached: boolean;
  /** False when git is unavailable or the root is not a repository. */
  gitAvailable: boolean;
  /** Reconciled change records in stable display order. */
  records: ChangeRecord[];
  /** When the snapshot was produced (epoch ms). */
  generatedAt: number;
}

export interface FileDiffResult {
  ok: boolean;
  path: string;
  /** Unified diff text (`git diff HEAD -- <path>`), when readable. */
  unified?: string;
  /** True when original content came back from HEAD (deleted/restored files). */
  originalFromHead?: boolean;
  /** True when the target is binary — line rendering refused by design. */
  binary?: boolean;
  /** True when the text exceeded MAX_DIFF_BYTES and was cut off. */
  truncated?: boolean;
  error?: string;
}

export interface RevertFileResult {
  ok: boolean;
  /**
   * True when nothing needed doing (already clean / record already gone) —
   * reverting twice must be safe (S-5 idempotency).
   */
  noop?: boolean;
  /** What the revert actually did to the worktree. */
  action?: 'restored-content' | 'deleted-file' | 'recreated-file';
  /**
   * True when the worktree now matches HEAD but the index still carries
   * staged deltas (git write operations are out of scope, so a staged
   * change cannot be un-staged). The UI keeps the record in that case.
   */
  residual?: boolean;
  error?: string;
}
