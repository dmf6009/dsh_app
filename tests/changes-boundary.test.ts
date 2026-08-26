/**
 * P0 regression tests (DSHA-6 review fix): canonical workspace-boundary
 * enforcement against symlink escapes, on the REAL filesystem.
 *
 *  - a file symlink inside the workspace pointing outside must NOT be
 *    readable by the Diff page
 *  - a directory symlink inside the workspace pointing outside must NOT be
 *    writable/deletable by Revert
 *  - a legitimately symlinked workspace ROOT (visible vs real spelling
 *    differ) must still work — the real root is the authority
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChangeRecordService } from '../src/main/changes/change-record-service';
import { buildFileDiff } from '../src/main/changes/file-diff';
import type { RuntimeEventFrame } from '../src/shared/protocol/types';

let root = '';
let outsideDir = '';

function git(args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  });
}

function write(rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

function fileChanged(p: string, change: 'added' | 'modified' | 'deleted' = 'modified'): RuntimeEventFrame {
  return { v: 1, type: 'file_changed', path: p, change };
}

function symlinkSupported(): boolean {
  try {
    const t = path.join(os.tmpdir(), `dsh-symlink-probe-${process.pid}`);
    fs.writeFileSync(t, 'x');
    const l = `${t}-l`;
    fs.symlinkSync(t, l);
    fs.unlinkSync(l);
    fs.unlinkSync(t);
    return true;
  } catch {
    return false;
  }
}

const HAS_SYMLINKS = symlinkSupported();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsha6-bnd-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsha6-out-'));
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe('P0: symlink boundary on the Diff read path', () => {
  it('file symlink inside workspace pointing outside is NOT readable', async () => {
    if (!HAS_SYMLINKS) return;
    const secret = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secret, 'OUTSIDE SECRET\n');
    write('tracked.py', 'public v1\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);
    // Swap the tracked path to a symlink pointing at the outside file.
    fs.rmSync(path.join(root, 'tracked.py'));
    fs.symlinkSync(secret, path.join(root, 'tracked.py'));

    const res = await buildFileDiff(root, 'tracked.py');
    // Rejected: the worktree read must not leak outside bytes. ok may be false
    // (guard error) or binary — but must NEVER contain the secret text.
    if (res.ok) {
      expect(res.modified ?? '').not.toContain('OUTSIDE SECRET');
      expect(res.unified ?? '').not.toContain('OUTSIDE SECRET');
    }
  });

  it('directory symlink inside workspace pointing outside is NOT readable', async () => {
    if (!HAS_SYMLINKS) return;
    fs.writeFileSync(path.join(outsideDir, 'leak.txt'), 'DIR OUTSIDE SECRET\n');
    fs.symlinkSync(outsideDir, path.join(root, 'linked'));

    const res = await buildFileDiff(root, 'linked/leak.txt');
    if (res.ok) {
      expect(res.modified ?? '').not.toContain('DIR OUTSIDE SECRET');
    }
  });

  it('untracked FILE symlink pointing outside does not leak (synthesizeAddDiff)', async () => {
    if (!HAS_SYMLINKS) return;
    git(['commit', '--allow-empty', '-m', 'seed']); // HEAD exists → add-diff path
    const secret = path.join(outsideDir, 'untracked-secret.txt');
    fs.writeFileSync(secret, 'UNTRACKED OUTSIDE SECRET\n');
    fs.symlinkSync(secret, path.join(root, 'evil.py')); // untracked, never added

    const res = await buildFileDiff(root, 'evil.py');
    // Both worktree and synthesized unified must never contain outside bytes.
    expect(res.modified ?? '').not.toContain('UNTRACKED OUTSIDE SECRET');
    expect(res.unified ?? '').not.toContain('UNTRACKED OUTSIDE SECRET');
  });

  it('untracked DIRECTORY symlink pointing outside does not leak (synthesizeAddDiff)', async () => {
    if (!HAS_SYMLINKS) return;
    git(['commit', '--allow-empty', '-m', 'seed']);
    fs.writeFileSync(path.join(outsideDir, 'leak2.txt'), 'UNTRACKED DIR SECRET\n');
    fs.symlinkSync(outsideDir, path.join(root, 'linked2'));

    const res = await buildFileDiff(root, 'linked2/leak2.txt');
    expect(res.modified ?? '').not.toContain('UNTRACKED DIR SECRET');
    expect(res.unified ?? '').not.toContain('UNTRACKED DIR SECRET');
  });
});

describe('P0: symlink boundary on the Revert write/delete path', () => {
  it('revert must not overwrite an outside target through a file symlink', async () => {
    if (!HAS_SYMLINKS) return;
    const target = path.join(outsideDir, 'victim.txt');
    fs.writeFileSync(target, 'DO NOT TOUCH\n');
    write('app.py', 'orig\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);
    write('app.py', 'agent edit\n');
    // Swap worktree path to a symlink to the outside file.
    fs.rmSync(path.join(root, 'app.py'));
    fs.symlinkSync(target, path.join(root, 'app.py'));

    const res = await new ChangeRecordService().revertFile(root, 'app.py');
    // Must fail (guardWrite refuses file-level symlinks) and NOT write outside.
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('DO NOT TOUCH\n');
  });

  it('revert must not delete an outside target through a symlink', async () => {
    if (!HAS_SYMLINKS) return;
    const target = path.join(outsideDir, 'precious.txt');
    fs.writeFileSync(target, 'KEEP ME\n');
    // A tracked modification path whose worktree entry is now a symlink.
    write('del.txt', 'v1\n');
    git(['add', '.']);
    git(['commit', '-m', 'c1']);
    fs.rmSync(path.join(root, 'del.txt'));
    fs.symlinkSync(target, path.join(root, 'del.txt'));

    const res = await new ChangeRecordService().revertFile(root, 'del.txt');
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP ME\n');
    expect(fs.existsSync(path.join(root, 'del.txt'))).toBe(true); // link left in place
  });

  it('non-git root: revert of a session-added file that is a symlink is refused', async () => {
    if (!HAS_SYMLINKS) return;
    const target = path.join(outsideDir, 'added-target.txt');
    fs.writeFileSync(target, 'SAFE\n');
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dsha6-bnd-ng-'));
    try {
      fs.symlinkSync(target, path.join(plain, 'added.txt'));
      const s = new ChangeRecordService();
      s.onRuntimeEvent(fileChanged('added.txt', 'added'), plain);
      const res = await s.revertFile(plain, 'added.txt');
      expect(res.ok).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('SAFE\n');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('P0: legitimately symlinked workspace ROOT still works', () => {
  it('opening the workspace through a symlink keeps Diff + Revert usable', async () => {
    if (!HAS_SYMLINKS) return;
    const linkRoot = path.join(os.tmpdir(), `dsha6-bnd-rootlink-${process.pid}`);
    fs.rmSync(linkRoot, { force: true });
    fs.symlinkSync(root, linkRoot);
    try {
      write('app.py', 'one\n');
      git(['add', '.']);
      git(['commit', '-m', 'c1']);
      write('app.py', 'two\n');

      const diff = await buildFileDiff(linkRoot, 'app.py');
      expect(diff.ok).toBe(true);
      expect(diff.modified).toBe('two\n');
      expect(diff.original).toBe('one\n');

      const res = await new ChangeRecordService().revertFile(linkRoot, 'app.py');
      expect(res.ok).toBe(true);
      expect(fs.readFileSync(path.join(linkRoot, 'app.py'), 'utf8')).toBe('one\n');
    } finally {
      fs.rmSync(linkRoot, { force: true });
    }
  });
});
