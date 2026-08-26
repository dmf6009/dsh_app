/**
 * Aggregated Changes renderer-state tests (DSHA-6): snapshot merging into UI
 * state, selection lifecycle, revert feedback and summary gating.
 */

import { describe, expect, it } from 'vitest';

import {
  badgeTitle,
  changedFiles,
  initialChangesState,
  neighborPath,
  orderedPaths,
  reduceChanges,
  showRunSummary,
  summaryLabel
} from '../src/renderer/src/changes/model';
import type { ChangeRecord, ChangesSnapshot } from '../src/shared/changes';

function rec(path: string, kind: ChangeRecord['kind'], source: ChangeRecord['source'] = 'event'): ChangeRecord {
  const at = '2025-01-01T00:00:00.000Z';
  return { path, kind, source, firstSeenAt: at, lastSeenAt: at };
}

function snap(records: ChangeRecord[], branch = 'main'): ChangesSnapshot {
  return {
    root: '/ws',
    branch,
    detached: false,
    gitAvailable: true,
    records,
    generatedAt: Date.now()
  };
}

describe('snapshot handling', () => {
  it('stores snapshots and drops a selection whose file vanished', () => {
    let s = reduceChanges(initialChangesState, {
      type: 'select',
      path: 'src/a.ts'
    });
    s = reduceChanges(s, {
      type: 'snapshot',
      snapshot: snap([rec('src/b.ts', 'modified', 'git')])
    });
    expect(s.selectedPath).toBeNull();
  });

  it('keeps the selection when the file still exists after reconcile', () => {
    let s = reduceChanges(initialChangesState, { type: 'select', path: 'src/a.ts' });
    s = reduceChanges(s, {
      type: 'snapshot',
      snapshot: snap([
        rec('src/a.ts', 'modified'),
        rec('src/b.ts', 'added')
      ])
    });
    expect(s.selectedPath).toBe('src/a.ts');
  });

  it('aggregation vs git reconciliation parity: rows carry merged sources', () => {
    const merged = snap([
      rec('evt-only.md', 'added'),
      rec('both.py', 'modified', 'git'),
      rec('git-only.rb', 'deleted', 'git')
    ]);
    const s = reduceChanges(initialChangesState, { type: 'snapshot', snapshot: merged });
    expect(changedFiles(s.snapshot).map((r) => r.source)).toEqual(['event', 'git', 'git']);
    expect(orderedPaths(s.snapshot)).toEqual(['evt-only.md', 'both.py', 'git-only.rb']);
  });
});

describe('revert feedback', () => {
  it('records success with residual flag and clears on next clean snapshot', () => {
    let s = reduceChanges(initialChangesState, { type: 'select', path: 'x.txt' });
    s = reduceChanges(s, {
      type: 'revert-result',
      path: 'x.txt',
      result: { ok: true, action: 'restored-content', residual: false }
    });
    expect(s.lastRevert).toMatchObject({ ok: true, path: 'x.txt' });

    // Snapshot without x.txt ⇒ record removed, selection dropped.
    s = reduceChanges(s, { type: 'snapshot', snapshot: snap([]) });
    expect(s.selectedPath).toBeNull();
  });

  it('keeps the record when residual=true so the user sees staged remains', () => {
    const before = snap([rec('s.txt', 'modified', 'git')]);
    let s = reduceChanges(initialChangesState, { type: 'snapshot', snapshot: before });
    s = reduceChanges(s, { type: 'select', path: 's.txt' });
    s = reduceChanges(s, {
      type: 'revert-result',
      path: 's.txt',
      result: { ok: true, action: 'restored-content', residual: true }
    });
    expect(s.lastRevert?.residual).toBe(true);
    // A following snapshot still containing the file keeps selection + no error.
    s = reduceChanges(s, { type: 'snapshot', snapshot: snap([rec('s.txt', 'modified', 'git')]) });
    expect(s.selectedPath).toBe('s.txt');
    expect(s.revertError).toBeNull();
  });

  it('surfaces revert errors as a banner message', () => {
    const s = reduceChanges(initialChangesState, {
      type: 'revert-error',
      path: 'y.txt',
      error: '该目录不是 Git 仓库'
    });
    expect(s.revertError).toContain('不是 Git 仓库');
  });

  it('expires feedback via the expiry action', () => {
    let s = reduceChanges(initialChangesState, {
      type: 'revert-result',
      path: 'z',
      result: { ok: true }
    });
    s = reduceChanges(s, { type: 'revert-feedback-expired' });
    expect(s.lastRevert).toBeNull();
  });
});

describe('summary gating & navigation helpers', () => {
  it('shows the pinned summary only when the run ended and files changed', () => {
    const withFiles = snap([rec('a', 'added')]);
    expect(showRunSummary(true, withFiles)).toBe(false); // live run → live list only
    expect(showRunSummary(false, withFiles)).toBe(true); // pinned after end
    expect(showRunSummary(false, snap([]))).toBe(false); // nothing to show
    expect(showRunSummary(false, null)).toBe(false);
  });

  it('formats the summary label with count', () => {
    expect(summaryLabel(0)).toBe('没有文件变更');
    expect(summaryLabel(3)).toBe('3 个文件变更');
  });

  it('navigates neighbor paths without wrapping (disabled ends instead)', () => {
    const s = snap([
      rec('a.ts', 'added'),
      rec('b.ts', 'modified'),
      rec('c.ts', 'deleted')
    ]);
    expect(neighborPath(s, 'a.ts', -1)).toBeNull(); // first → prev disabled
    expect(neighborPath(s, 'a.ts', 1)).toBe('b.ts');
    expect(neighborPath(s, 'c.ts', 1)).toBeNull(); // last → next disabled
    expect(neighborPath(s, 'missing', 1)).toBeNull();
  });

  it('maps kinds onto badge letters and titles', () => {
    expect(badgeTitle('added')).toBe('新增');
    expect(badgeTitle('modified')).toBe('修改');
    expect(badgeTitle('deleted')).toBe('删除');
  });
});
