/**
 * Workspace boundary service tests (§35, baseline F12):
 * lexical escape (`../`), absolute-outside, symlink escape (real fs), the
 * explicit authorization interface and path normalization.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { expandAndNormalize, WorkspaceBoundary } from '../src/main/workspace/boundary';
import { ROOT } from './helpers';

const TEST_ROOT = path.join(ROOT, '.tmp-tests', 'boundary');

function makeDir(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let workspaceRoot = '';
let outsideDir = '';
let fakeHome = '';

beforeAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  workspaceRoot = makeDir('root/project');
  outsideDir = makeDir('outside');
  fakeHome = makeDir('home');
});

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('expandAndNormalize', () => {
  it('expands ~ against the given home and normalizes separators', () => {
    expect(expandAndNormalize('~', fakeHome)).toBe(path.normalize(fakeHome));
    expect(expandAndNormalize('~/projects/app', fakeHome)).toBe(
      path.join(fakeHome, 'projects', 'app')
    );
  });

  it('resolves relative and dotted segments', () => {
    const base = process.cwd();
    expect(expandAndNormalize('./a/b/../c', base)).toBe(path.join(base, 'a', 'c'));
    expect(expandAndNormalize('/tmp/x//y/', fakeHome)).toBe(path.normalize('/tmp/x/y'));
  });
});

describe('WorkspaceBoundary.check', () => {
  it('allows paths inside the root', async () => {
    const b = new WorkspaceBoundary(workspaceRoot);
    const result = await b.check(path.join(workspaceRoot, 'src', 'main.ts'));
    expect(result.allowed).toBe(true);
    expect(result.needsAuthorization).toBe(false);
    expect(result.escape).toBe('none');
  });

  it('rejects `../` traversal as a lexical escape', async () => {
    const b = new WorkspaceBoundary(workspaceRoot);
    const result = await b.check('../sibling/secret.txt');
    expect(result.allowed).toBe(false);
    expect(result.needsAuthorization).toBe(true);
    expect(result.escape).toBe('lexical');
  });

  it('rejects absolute paths outside the root', async () => {
    const b = new WorkspaceBoundary(workspaceRoot);
    const result = await b.check(path.join(outsideDir, 'data.txt'));
    expect(result.allowed).toBe(false);
    expect(result.escape).toBe('lexical');
  });

  it('reports a missing root instead of pretending containment', async () => {
    const b = new WorkspaceBoundary(path.join(TEST_ROOT, 'root', 'does-not-exist'));
    const result = await b.check('anything.txt');
    expect(result.allowed).toBe(false);
    expect(result.needsAuthorization).toBe(false);
    expect(result.escape).toBe('root_missing');
  });

  it('detects symlink escape via realpath (real fs)', async () => {
    const linkPath = path.join(workspaceRoot, 'innocent-link');
    try {
      fs.symlinkSync(outsideDir, linkPath, 'dir');
    } catch (err) {
      // Windows without privileges — skip rather than fail.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const b = new WorkspaceBoundary(workspaceRoot);
    const result = await b.check(path.join(linkPath, 'leak.txt'));
    expect(result.allowed).toBe(false);
    expect(result.escape).toBe('symlink');

    // With an explicit grant for that resolved path, access is allowed.
    const targetFile = path.join(fs.realpathSync(linkPath), 'leak.txt');
    b.grant(targetFile);
    const granted = await b.check(targetFile);
    expect(granted.allowed).toBe(true);

    b.revoke(targetFile);
    expect(b.hasGrant(targetFile)).toBe(false);
    const revoked = await b.check(targetFile);
    expect(revoked.allowed).toBe(false);
  });

  it('treats not-yet-existing creation targets inside the root as allowed', async () => {
    const b = new WorkspaceBoundary(workspaceRoot);
    const result = await b.check(path.join(workspaceRoot, 'new-folder', 'file.md'));
    expect(result.allowed).toBe(true);
  });
});
