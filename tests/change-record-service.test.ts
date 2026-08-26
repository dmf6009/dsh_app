/**
 * Change Record service tests (DSHA-6): aggregation/reconciliation policy and
 * S-5 revert semantics against REAL temp git repositories.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChangeRecordService,
  mergeRecords,
  normalizeEventPath
} from '../src/main/changes/change-record-service';
import type { RuntimeEventFrame } from '../src/shared/protocol/types';
import type { StatusEntry } from '../src/main/changes/git-readonly';

let root = '';

function git(args: string[]): void {
  execFileSync('git', args, { cwd: root });
}

function write(rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function svc(): ChangeRecordService {
  return new ChangeRecordService();
}

function fileChanged(p: string, change: 'added' | 'modified' | 'deleted' = 'modified'): RuntimeEventFrame {
  return { v: 1, type: 'file_changed', path: p, change };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-crs-'));
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Pure merge policy                                                   */
/* ------------------------------------------------------------------ */

describe('mergeRecords', () => {
  const nowIso = '2025-01-01T00:00:00.000Z';
  const ev = (
    path: string,
    kind: 'added' | 'modified' | 'deleted',
    firstSeenAt = '2024-12-31T00:00:00.000Z'
  ): ChangeRecordLike => ({ path, kind, source: 'event', firstSeenAt, lastSeenAt: firstSeenAt });
  type ChangeRecordLike = import('../src/shared/changes').ChangeRecord;

  it('keeps event arrival order and lets git override shared paths', () => {
    const eventRecords = [ev('b.ts', 'modified'), ev('a.ts', 'added')];
    const gitEntries: StatusEntry[] = [
      { path: 'b.ts', kind: 'deleted', code: ' D' },
      { path: 'z.ts', kind: 'modified', code: 'M ' }
    ];
    const merged = mergeRecords({ eventRecords, gitEntries, nowIso });
    expect(merged.map((r) => r.path)).toEqual(['b.ts', 'a.ts', 'z.ts']);
    expect(merged[0]).toMatchObject({ kind: 'deleted', source: 'git' });
    expect(merged[1]).toMatchObject({ source: 'event' }); // untouched
    expect(merged[2]).toMatchObject({ source: 'git', firstSeenAt: nowIso });
  });

  it('appends multiple git-only paths in ascending order deterministically', () => {
    const merged = mergeRecords({
      eventRecords: [],
      gitEntries: [
        { path: 'c.ts', kind: 'added', code: '??' },
        { path: 'a/b.ts', kind: 'added', code: '??' },
        { path: 'a.ts', kind: 'modified', code: 'M ' }
      ],
      nowIso
    });
    expect(merged.map((r) => r.path)).toEqual(['a.ts', 'a/b.ts', 'c.ts']);
  });

  it('does not mutate caller-owned inputs', () => {
    const eventRecords = [ev('x.ts', 'added')];
    mergeRecords({ eventRecords, gitEntries: [{ path: 'x.ts', kind: 'deleted', code: 'D ' }], nowIso });
    expect(eventRecords[0]!.kind).toBe('added');
  });
});

describe('normalizeEventPath', () => {
  it('relativizes absolute paths inside the root and keeps others as-is', () => {
    expect(normalizeEventPath(root, path.join(root, 'src/a.py'))).toBe('src/a.py');
    expect(normalizeEventPath(root, './src/b.py')).toBe('src/b.py');
    expect(normalizeEventPath(null, '/etc/passwd')).toBe('/etc/passwd');
  });
});

/* ------------------------------------------------------------------ */
/* Event aggregation                                                   */
/* ------------------------------------------------------------------ */

describe('event aggregation', () => {
  it('upserts repeated file_changed events into ONE record per path', () => {
    const s = svc();
    expect(s.onRuntimeEvent(fileChanged('src/login.py'), root)).toBe(false);
    expect(s.onRuntimeEvent({ ...fileChanged('src/login.py'), change: 'deleted' }, root)).toBe(false);
    expect(s.eventRecordCount).toBe(1);
  });

  it('never creates records from file_read events (AC-06 interpretation)', async () => {
    const s = svc();
    s.onRuntimeEvent({ v: 1, type: 'run_started', run_id: 'r1' }, root);
    s.onRuntimeEvent({ v: 1, type: 'file_read', path: 'README.md' }, root);
    s.onRuntimeEvent({ v: 1, type: 'file_read', path: 'src/only-read.ts' }, root);
    expect(s.eventRecordCount).toBe(0);
    expect(s.readLedger).toContain('src/only-read.ts');

    const snap = await s.reconcile(root);
    expect(snap.records).toHaveLength(0); // repo is clean; read ≠ changed
  });

  it('flags terminal frames so callers know to reconcile with git', () => {
    const s = svc();
    for (const type of ['run_completed', 'done', 'run_cancelled'] as const) {
      expect(s.onRuntimeEvent({ v: 1, type } as RuntimeEventFrame, root)).toBe(true);
    }
    expect(s.onRuntimeEvent({ v: 1, type: 'message_delta', content: 'x' }, root)).toBe(false);
  });

  it('reconciles event-only records with real git status (git authoritative)', async () => {
    write('tracked.txt', 'v1\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);

    const s = svc();
    // Event claims an edit that also really happened:
    write('tracked.txt', 'v2\n');
    s.onRuntimeEvent(fileChanged('tracked.txt'), root);
    // Event for a file git cannot see (e.g. written then removed externally,
    // or runtime-side virtual change) — must survive reconciliation:
    s.onRuntimeEvent(fileChanged('.dsh-scratch/virtual.md', 'added'), root);

    const snap = await s.reconcile(root);
    const byPath = new Map(snap.records.map((r) => [r.path, r]));
    expect(byPath.get('tracked.txt')?.source).toBe('git');
    expect(byPath.get('tracked.txt')?.kind).toBe('modified');
    expect(byPath.get('.dsh-scratch/virtual.md')?.source).toBe('event');
    expect(snap.branch).toBe('main');
    expect(snap.gitAvailable).toBe(true);
  });

  it('catches up changes made OUTSIDE the desktop (git-only rows appear)', async () => {
    write('external.txt', 'x\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);

    const s = svc(); // no events at all — pure external edit
    write('external.txt', 'y\n');
    const snap = await s.reconcile(root);
    expect(snap.records.map((r) => [r.path, r.kind])).toContainEqual(['external.txt', 'modified']);
  });

  it('reports non-git roots without crashing and keeps event rows', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nogit-'));
    try {
      const s = svc();
      s.onRuntimeEvent(fileChanged('notes.txt', 'added'), plain);
      const snap = await s.reconcile(plain);
      expect(snap.gitAvailable).toBe(false);
      expect(snap.branch).toBeNull();
      expect(snap.records.map((r) => r.path)).toEqual(['notes.txt']);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('peekSnapshot returns cached data without spawning git', async () => {
    const s = svc();
    const before = s.peekSnapshot(root);
    expect(before.records).toHaveLength(0);
    await s.reconcile(root);
    expect(s.peekSnapshot(root).generatedAt).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Revert (S-5)                                                        */
/* ------------------------------------------------------------------ */

describe('revertFile', () => {
  it('restores a modified tracked file byte-for-byte from HEAD', async () => {
    write('app.py', 'orig\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);
    write('app.py', 'changed by agent\nline2\n');

    const res = await svc().revertFile(root, 'app.py');
    expect(res.ok).toBe(true);
    expect(res.action).toBe('restored-content');
    expect(fs.readFileSync(path.join(root, 'app.py'), 'utf8')).toBe('orig\n');
  });

  it('recreates a deleted tracked file from HEAD', async () => {
    write('gone.py', 'keep me\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);
    fs.rmSync(path.join(root, 'gone.py'));

    const res = await svc().revertFile(root, 'gone.py');
    expect(res.ok).toBe(true);
    expect(res.action).toBe('recreated-file');
    expect(fs.readFileSync(path.join(root, 'gone.py'), 'utf8')).toBe('keep me\n');
  });

  it('deletes untracked files added during the session', async () => {
    write('scratch/new.py', 'print(1)\n');
    const res = await svc().revertFile(root, 'scratch/new.py');
    expect(res.ok).toBe(true);
    expect(res.action).toBe('deleted-file');
    expect(fs.existsSync(path.join(root, 'scratch/new.py'))).toBe(false);
  });

  it('is idempotent: second revert of a clean path reports noop (S-5 裁定③)', async () => {
    write('m.txt', 'one\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);
    write('m.txt', 'two\n');

    const s = svc();
    const first = await s.revertFile(root, 'm.txt');
    expect(first.ok).toBe(true);
    const second = await s.revertFile(root, 'm.txt');
    expect(second.ok).toBe(true);
    expect(second.noop).toBe(true);
  });

  it('flags staged residual instead of pretending full success', async () => {
    write('s.txt', 'base\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);
    write('s.txt', 'staged edit\n');
    git(['add', 's.txt']); // staged only — index cannot be touched

    const res = await svc().revertFile(root, 's.txt');
    expect(res.ok).toBe(true);
    expect(res.residual).toBe(true);
    // Worktree content IS restored to HEAD…
    expect(fs.readFileSync(path.join(root, 's.txt'), 'utf8')).toBe('base\n');
    // …but the index still carries the staged delta.
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root }).toString();
    expect(staged).toContain('s.txt');
  });

  it('rejects path escapes before touching anything', async () => {
    write('../outside.txt', 'nope\n');
    const outsideAbs = path.resolve(root, '../outside.txt');
    try {
      const res = await svc().revertFile(root, '../outside.txt');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/工作区之外/);
      expect(fs.existsSync(outsideAbs)).toBe(true); // untouched
    } finally {
      fs.rmSync(outsideAbs, { force: true });
    }
  });

  it('fails with a clear error in non-git roots unless file was session-added', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nogit-rv-'));
    try {
      fs.writeFileSync(path.join(plain, 'pre-existing.txt'), 'data\n');

      const s = svc();
      const bad = await s.revertFile(plain, 'pre-existing.txt');
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/不是 Git 仓库/);

      s.onRuntimeEvent(fileChanged('made-by-agent.txt', 'added'), plain);
      const good = await s.revertFile(plain, 'made-by-agent.txt');
      expect(good.ok).toBe(true);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('returns an error when no workspace root is open', async () => {
    const res = await svc().revertFile(null, 'anything.txt');
    expect(res.ok).toBe(false);
  });

  it('handles nested paths whose parent dirs were deleted', async () => {
    write('deep/nested/leaf.txt', 'content\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);
    fs.rmSync(path.join(root, 'deep'), { recursive: true });

    const res = await svc().revertFile(root, 'deep/nested/leaf.txt');
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'deep/nested/leaf.txt'), 'utf8')).toBe('content\n');
  });
});
