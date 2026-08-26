/**
 * Renderer state for the aggregated Changes layer (issue DSHA-6).
 *
 * Pure reducer + selectors — no React/DOM imports so it stays unit-testable.
 * The authoritative data source is the main process snapshot push (runtime
 * events already merged with read-only git facts there); this module tracks
 * presentation concerns: selection, revert feedback, summary visibility.
 */

import type {
  ChangeRecord,
  ChangeKind,
  ChangesSnapshot,
  RevertFileResult
} from '../../../shared/changes';

export interface ChangesState {
  /** Latest merged snapshot from main (null before the first push). */
  snapshot: ChangesSnapshot | null;
  /** File currently opened in the Diff page (null = none/empty state). */
  selectedPath: string | null;
  /** Last completed revert, kept briefly so the UI can flash the row. */
  lastRevert: { path: string; ok: boolean; residual?: boolean; noop?: boolean; at: number } | null;
  revertError: string | null;
}

export const initialChangesState: ChangesState = {
  snapshot: null,
  selectedPath: null,
  lastRevert: null,
  revertError: null
};

export type ChangesAction =
  | { type: 'snapshot'; snapshot: ChangesSnapshot }
  | { type: 'select'; path: string | null }
  | {
      type: 'revert-result';
      path: string;
      result: RevertFileResult;
    }
  | { type: 'revert-error'; path: string; error: string }
  | { type: 'revert-feedback-expired' };

export function reduceChanges(state: ChangesState, action: ChangesAction): ChangesState {
  switch (action.type) {
    case 'snapshot': {
      // Keep selection only when the file still exists in the new snapshot;
      // a reverted/deleted row must not leave the Diff page dangling.
      const stillThere =
        action.snapshot.records.some((r) => r.path === state.selectedPath);
      return {
        ...state,
        snapshot: action.snapshot,
        selectedPath: stillThere ? state.selectedPath : null,
        // A revert that removed the record clears any previous error banner.
        revertError: stillThere ? state.revertError : null
      };
    }
    case 'select':
      return { ...state, selectedPath: action.path };
    case 'revert-result':
      return {
        ...state,
        lastRevert: {
          path: action.path,
          ok: action.result.ok === true,
          residual: action.result.residual,
          noop: action.result.noop,
          at: Date.now()
        },
        revertError: action.result.ok ? null : action.result.error ?? '恢复失败'
      };
    case 'revert-error':
      return {
        ...state,
        lastRevert: { path: action.path, ok: false, at: Date.now() },
        revertError: action.error
      };
    case 'revert-feedback-expired':
      return { ...state, lastRevert: null };
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

/** Records in display order (snapshot order is already stable). */
export function changedFiles(snapshot: ChangesSnapshot | null): ChangeRecord[] {
  return snapshot?.records ?? [];
}

/**
 * Pinned run summary line ("N files changed · View Diff") is shown after a
 * run ends while changes exist; hidden live (the list itself is live) and
 * when nothing changed.
 */
export function showRunSummary(runActive: boolean, snapshot: ChangesSnapshot | null): boolean {
  return !runActive && changedFiles(snapshot).length > 0;
}

export function summaryLabel(count: number): string {
  if (count <= 0) return '没有文件变更';
  return `${count} 个文件变更`;
}

/** Badge letter per design spec §5 (letter + color dual encoding). */
export const CHANGE_BADGE: Record<ChangeKind, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D'
};

export function badgeTitle(kind: ChangeKind): string {
  switch (kind) {
    case 'added':
      return '新增';
    case 'modified':
      return '修改';
    case 'deleted':
      return '删除';
  }
}

/** Stable sort for pickers: keep snapshot order (events first, git appended). */
export function orderedPaths(snapshot: ChangesSnapshot | null): string[] {
  return changedFiles(snapshot).map((r) => r.path);
}

/** Next/prev neighbor for hunk-style file navigation on the Diff page. */
export function neighborPath(
  snapshot: ChangesSnapshot | null,
  path: string | null,
  delta: 1 | -1
): string | null {
  const paths = orderedPaths(snapshot);
  if (paths.length === 0 || path == null) return null;
  const idx = paths.indexOf(path);
  if (idx === -1) return null;
  return paths[idx + delta] ?? null;
}
