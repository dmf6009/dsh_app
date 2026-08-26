/**
 * buildFileDiff integration tests (DSHA-6) against REAL temp git repos:
 * the Diff page data source must hand Monaco a coherent
 * original/modified/unified triple without any git write operation.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFileDiff } from '../src/main/changes/file-diff';

let root = '';

function git(args: string[], opts: { cwd?: string; input?: string } = {}): void {
  execFileSync('git', args, {
    cwd: opts.cwd ?? root,
    input: opts.input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com'
    }
  });
}

function write(rel: string, body: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsha6-filediff-'));
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 't']);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('buildFileDiff (real repo)', () => {
  it('modified tracked file: HEAD text as original, worktree as modified, unified has both sides', async () => {
    write('app.py', 'line one\nline two\n');
    git(['add', '.']);
    git(['commit', '-m', 'init']);
    write('app.py', 'line one\nline two changed\nline three\n');

    const res = await buildFileDiff(root, 'app.py');
    expect(res.ok).toBe(true);
    expect(res.binary).toBe(false);
    expect(res.originalFromHead).toBe(true);
    expect(res.original).toBe('line one\nline two\n');
    expect(res.modified).toBe('line one\nline two changed\nline three\n');
    expect(res.unified).toContain('-line two');
    expect(res.unified).toContain('+line two changed');
    expect(res.truncated).toBe(false);
  });

  it('untracked new file: empty original, add-only unified diff', async () => {
    git(['commit', '--allow-empty', '-m', 'seed']); // give HEAD so status shows '?'
    write('new.py', 'print("hello")\n');

    const res = await buildFileDiff(root, 'new.py');
    expect(res.ok).toBe(true);
    expect(res.original).toBe('');
    expect(res.modified).toContain('print("hello")');
    expect(res.unified).toContain('+print("hello")');
    expect(res.unified).toMatch(/^@@ /m); // synthesized @@ hunk header
  });

  it('staged-only change: index copy becomes the original side', async () => {
    write('s.txt', 'v1\n');
    git(['add', '.']);
    git(['commit', '-m', 'init']);
    write('s.txt', 'v2\n');
    git(['add', 's.txt']);

    const res = await buildFileDiff(root, 's.txt');
    expect(res.ok).toBe(true);
    // HEAD still holds v1 — original comes from HEAD, not the index.
    expect(res.original).toBe('v1\n');
    expect(res.modified).toBe('v2\n');
  });

  it('binary file is flagged and carries no text payload', async () => {
    git(['commit', '--allow-empty', '-m', 'seed']);
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    fs.writeFileSync(path.join(root, 'logo.bin'), bytes);

    const res = await buildFileDiff(root, 'logo.bin');
    expect(res.ok).toBe(true);
    expect(res.binary).toBe(true);
    expect(res.unified ?? '').not.toContain('+');
  });

  it('path escapes are rejected without touching the filesystem', async () => {
    const res = await buildFileDiff(root, '../outside.txt');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('non-git workspace: worktree content only, no unified diff', async () => {
    // A plain directory that is NOT a git work tree.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsha6-nongit-'));
    write('plain.txt', 'hello\n');
    const res = await buildFileDiff(root, 'plain.txt');
    expect(res.ok).toBe(true);
    expect(res.modified).toBe('hello\n');
    expect(res.originalFromHead).toBe(false);
    expect(res.unified).toBe('');
  });

  it('missing file in non-git workspace yields ok with empty texts (graceful)', async () => {
    git(['commit', '--allow-empty', '-m', 'seed']);
    const res = await buildFileDiff(root, 'ghost.py');
    expect(res.ok).toBe(true);
    expect(res.modified).toBe('');
    expect(res.original).toBe('');
    expect(res.unified).toBe('');
  });

  it('null root fails with a clear error', async () => {
    const res = await buildFileDiff(null, 'a.txt');
    expect(res.ok).toBe(false);
  });

  it('revert + rebuild round-trip restores HEAD state byte-for-byte', async () => {
    write('r.md', '# v1\n');
    git(['add', '.']);
    git(['commit', '-m', 'init']);
    write('r.md', '# v2 edited\n');

    const before = await buildFileDiff(root, 'r.md');
    expect(before?.modified).toBe('# v2 edited\n');

    fs.writeFileSync(path.join(root, 'r.md'), '# v1\n', 'utf8'); // simulate revert
    const after = await buildFileDiff(root, 'r.md');
    expect(after?.modified).toBe(after?.original);
    expect(after?.unified).toBe('');
  });
});
