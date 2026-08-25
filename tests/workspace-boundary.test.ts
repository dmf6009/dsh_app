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

  it('allows access through a symlinked workspace-root layout (QA-1, real fs)', async () => {
    // macOS /tmp→/private/tmp style layouts: the visible root differs from the
    // real location it points at.
    const realProject = makeDir('sym-layout/real/proj');
    fs.writeFileSync(path.join(realProject, 'main.ts'), 'export {};\n');
    const aliasLink = path.join(TEST_ROOT, 'sym-layout', 'alias');
    try {
      fs.symlinkSync(path.join(TEST_ROOT, 'sym-layout', 'real'), aliasLink, 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const b = new WorkspaceBoundary(path.join(aliasLink, 'proj'));
    expect(fs.realpathSync(b.rootPath)).toBe(realProject);

    // Existing file behind the linked root: the target's real location is
    // inside the root's real location — allowed, no per-path authorization.
    const existing = await b.check(path.join(aliasLink, 'proj', 'main.ts'));
    expect(existing.allowed).toBe(true);
    expect(existing.needsAuthorization).toBe(false);

    // Not-yet-created target: resolved through the nearest existing ancestor,
    // which sits behind the symlinked root — still allowed.
    const creation = await b.check(path.join(aliasLink, 'proj', 'new-folder', 'file.md'));
    expect(creation.allowed).toBe(true);
  });

  it('still rejects links leaving the workspace behind a symlinked root (real fs)', async () => {
    const realProject = makeDir('sym-escape/real/proj');
    const aliasLink = path.join(TEST_ROOT, 'sym-escape', 'alias');
    try {
      fs.symlinkSync(path.join(TEST_ROOT, 'sym-escape', 'real'), aliasLink, 'dir');
      fs.symlinkSync(outsideDir, path.join(realProject, 'out-link'), 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const b = new WorkspaceBoundary(path.join(aliasLink, 'proj'));
    const result = await b.check(path.join(aliasLink, 'proj', 'out-link', 'x.txt'));
    expect(result.allowed).toBe(false);
    expect(result.needsAuthorization).toBe(true);
    expect(result.escape).toBe('symlink');
  });

  it('keeps the real-root layer authoritative when only realpath escapes', async () => {
    // Injected resolver: a link inside the visible root lands on a real
    // location that is lexically inside the root but outside realpath(root).
    const b = new WorkspaceBoundary('/ws/root', {
      home: fakeHome,
      exists: () => true,
      realpath: async (p) => {
        if (p === '/ws/root') return '/real/root';
        if (p === '/ws/root/mirror/x.txt') return '/ws/root/.mirror-store/x.txt';
        return p.replace('/ws/root/', '/real/root/');
      }
    });
    const result = await b.check('/ws/root/mirror/x.txt');
    expect(result.allowed).toBe(false);
    expect(result.escape).toBe('symlink');
    expect(result.reason).toBe('Workspace 根目录解析后不包含该路径');
  });
});
