/**
 * Workspace boundary service tests (§35, baseline F12):
 * lexical escape (`../`), absolute-outside, symlink escape (real fs), the
 * explicit authorization interface and path normalization.
 *
 * Authorization keys are exact and case-preserving (QA-3/QA-4): the case-twin
 * suite below pins that one grant never spreads to a second, distinct file, and
 * that `grantedPaths()` stays an auditable list of real paths.
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

  it('allows the real canonical spelling of an in-root file under a symlinked root (QA-2, real fs)', async () => {
    // macOS `/tmp`→`/private/tmp` shape: the workspace is opened through a
    // symlinked prefix, but downstream producers (git output, `realpath`, DSH's
    // own resolution) hand back the canonical spelling of the very same file.
    const realProject = makeDir('qa2/private/tmp/proj');
    fs.writeFileSync(path.join(realProject, 'a.ts'), 'export {};\n');
    const tmpLink = path.join(TEST_ROOT, 'qa2', 'tmp');
    try {
      fs.symlinkSync(path.join(TEST_ROOT, 'qa2', 'private', 'tmp'), tmpLink, 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const linkedRoot = path.join(tmpLink, 'proj');
    const b = new WorkspaceBoundary(linkedRoot);
    expect(fs.realpathSync(b.rootPath)).toBe(realProject);

    // The link spelling was already allowed by FIX-2 …
    const viaLink = await b.check(path.join(linkedRoot, 'a.ts'));
    expect(viaLink.allowed).toBe(true);
    expect(viaLink.escape).toBe('none');

    // … and the real canonical spelling of the same file must be allowed too:
    // the real root is authoritative on the allow side as well as the deny side.
    const viaReal = await b.check(path.join(realProject, 'a.ts'));
    expect(viaReal.allowed).toBe(true);
    expect(viaReal.needsAuthorization).toBe(false);
    expect(viaReal.escape).toBe('none');

    // Not-yet-created target named canonically is in-root as well.
    const creation = await b.check(path.join(realProject, 'gen', 'out.md'));
    expect(creation.allowed).toBe(true);

    // A prefix sibling of the REAL root is still a lexical escape — being real
    // does not make it in-root.
    makeDir('qa2/private/tmp/proj-evil');
    const sibling = await b.check(path.join(TEST_ROOT, 'qa2', 'private', 'tmp', 'proj-evil', 'f.txt'));
    expect(sibling.allowed).toBe(false);
    expect(sibling.escape).toBe('lexical');
    expect(sibling.needsAuthorization).toBe(true);
  });

  it('keeps `../` and absolute-outside targets on the lexical escape kind under a symlinked root', async () => {
    // Guards the QA-2 reordering: making the real root authoritative must not
    // reclassify plain out-of-boundary paths as symlink escapes.
    const realProject = makeDir('qa2-kind/real/proj');
    const aliasLink = path.join(TEST_ROOT, 'qa2-kind', 'alias');
    try {
      fs.symlinkSync(path.join(TEST_ROOT, 'qa2-kind', 'real'), aliasLink, 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const b = new WorkspaceBoundary(path.join(aliasLink, 'proj'));

    const dotdot = await b.check(path.join(aliasLink, 'proj', '..', '..', 'escaped.txt'));
    expect(dotdot.allowed).toBe(false);
    expect(dotdot.escape).toBe('lexical');

    const absolute = await b.check(path.join(outsideDir, 'data.txt'));
    expect(absolute.allowed).toBe(false);
    expect(absolute.escape).toBe('lexical');

    // In-root symlink leaving the workspace stays a symlink escape.
    fs.symlinkSync(outsideDir, path.join(realProject, 'out'), 'dir');
    const escaping = await b.check(path.join(aliasLink, 'proj', 'out', 'x.txt'));
    expect(escaping.allowed).toBe(false);
    expect(escaping.escape).toBe('symlink');
  });
});

describe('WorkspaceBoundary authorization grants', () => {
  it('does not let one grant authorize a case-twin file on a case-sensitive fs (QA-3, real fs)', async () => {
    const grantRoot = makeDir('grants/ws');
    const upper = path.join(TEST_ROOT, 'grants', 'Notes', 'Report.TXT');
    const lower = path.join(TEST_ROOT, 'grants', 'notes', 'report.txt');
    fs.mkdirSync(path.dirname(upper), { recursive: true });
    fs.writeFileSync(upper, 'approved-content\n');
    fs.mkdirSync(path.dirname(lower), { recursive: true });
    fs.writeFileSync(lower, 'never-approved-content\n');

    // Only meaningful where the two spellings really are two different files.
    const caseSensitiveFs =
      fs.existsSync(upper) &&
      fs.existsSync(lower) &&
      fs.readFileSync(upper, 'utf8') !== fs.readFileSync(lower, 'utf8');
    if (!caseSensitiveFs) return;

    const b = new WorkspaceBoundary(grantRoot);
    // Both live outside the workspace, so both start out needing authorization.
    expect((await b.check(upper)).allowed).toBe(false);
    expect((await b.check(lower)).allowed).toBe(false);

    // The user authorizes exactly ONE of them.
    b.grant(upper);
    expect(b.hasGrant(upper)).toBe(true);
    expect((await b.check(upper)).allowed).toBe(true);

    // The distinct case-twin file must stay unauthorized — a grant may never
    // spread to a file the user did not approve.
    expect(b.hasGrant(lower)).toBe(false);
    const twin = await b.check(lower);
    expect(twin.allowed).toBe(false);
    expect(twin.needsAuthorization).toBe(true);

    // Revoking the twin spelling must not silently revoke the real grant …
    b.revoke(lower);
    expect(b.hasGrant(upper)).toBe(true);
    // … and revoking the granted spelling closes it.
    b.revoke(upper);
    expect(b.hasGrant(upper)).toBe(false);
    expect((await b.check(upper)).allowed).toBe(false);
  });

  it('returns auditable real paths from grantedPaths(), not folded keys (QA-4)', async () => {
    const grantRoot = makeDir('grants-audit/ws');
    const mixedCase = path.join(TEST_ROOT, 'grants-audit', 'Outside', 'File.TXT');
    fs.mkdirSync(path.dirname(mixedCase), { recursive: true });
    fs.writeFileSync(mixedCase, 'x\n');

    const b = new WorkspaceBoundary(grantRoot);
    b.grant(mixedCase);

    // The audit surface shows the path exactly as authorized, and that path
    // actually exists on disk — a lowercased key would show a path the user
    // never granted and that cannot be opened.
    const listed = b.grantedPaths();
    expect(listed).toEqual([mixedCase]);
    expect(fs.existsSync(listed[0] ?? '')).toBe(true);

    // Grants are normalized, so `~`/`..`/duplicate-separator spellings of the
    // same path are one entry rather than several.
    b.grant(path.join(TEST_ROOT, 'grants-audit', 'Outside', '.', 'File.TXT'));
    expect(b.grantedPaths()).toEqual([mixedCase]);

    b.revoke(mixedCase);
    expect(b.grantedPaths()).toEqual([]);
  });

  it('keys grant, revoke and hasGrant identically for the same normalized path', async () => {
    const grantRoot = makeDir('grants-key/ws');
    const target = path.join(TEST_ROOT, 'grants-key', 'outside', 'Deep', 'file.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x\n');
    const b = new WorkspaceBoundary(grantRoot, { home: fakeHome });

    // Un-normalized spelling on the way in, normalized spelling on the way out.
    const messy = path.join(TEST_ROOT, 'grants-key', 'outside', 'x', '..', 'Deep', 'file.txt');
    b.grant(messy);
    expect(b.hasGrant(target)).toBe(true);
    expect(b.grantedPaths()).toEqual([target]);
    expect((await b.check(messy)).allowed).toBe(true);

    b.revoke(target);
    expect(b.hasGrant(messy)).toBe(false);
    expect(b.grantedPaths()).toEqual([]);
  });

  it('grants a symlink-escaping target under a symlinked root and revokes it again', async () => {
    // Authorization closure must keep working on top of the QA-2 reordering.
    const realProject = makeDir('grants-sym/real/proj');
    const aliasLink = path.join(TEST_ROOT, 'grants-sym', 'alias');
    const escapeTarget = makeDir('grants-sym/elsewhere');
    try {
      fs.symlinkSync(path.join(TEST_ROOT, 'grants-sym', 'real'), aliasLink, 'dir');
      fs.symlinkSync(escapeTarget, path.join(realProject, 'out'), 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    const b = new WorkspaceBoundary(path.join(aliasLink, 'proj'));
    // Not-yet-created target behind the escaping link.
    const target = path.join(aliasLink, 'proj', 'out', 'new-dir', 'new.txt');

    expect((await b.check(target)).allowed).toBe(false);
    b.grant(target);
    const granted = await b.check(target);
    expect(granted.allowed).toBe(true);
    expect(granted.needsAuthorization).toBe(false);
    expect(b.grantedPaths()).toEqual([path.normalize(target)]);

    b.revoke(target);
    expect((await b.check(target)).allowed).toBe(false);
  });

  it('falls back to the lexical verdict when nothing resolves, without failing open', async () => {
    // Every ancestor unreadable (permission walls): the real-root layer cannot
    // decide, so the lexical verdict stands — in-root allowed, outside denied.
    const b = new WorkspaceBoundary('/ws/root', {
      home: fakeHome,
      exists: () => true,
      realpath: async (): Promise<string> => {
        throw new Error('EACCES');
      }
    });

    const inside = await b.check('/ws/root/src/a.ts');
    expect(inside.allowed).toBe(true);
    expect(inside.escape).toBe('none');

    const outside = await b.check('/elsewhere/secret.txt');
    expect(outside.allowed).toBe(false);
    expect(outside.escape).toBe('lexical');
    expect(outside.needsAuthorization).toBe(true);

    // An explicit grant still opens that outside path.
    b.grant('/elsewhere/secret.txt');
    expect((await b.check('/elsewhere/secret.txt')).allowed).toBe(true);
  });
});
