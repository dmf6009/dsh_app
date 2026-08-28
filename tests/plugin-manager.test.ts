/**
 * PluginManager unit tests — the Desktop surface of dsh「万物皆可插」.
 *
 * Listing is asserted against a hand-built profile tree (manifest with
 * bundles + dependencies, shared node_modules providing versions). Mutations
 * run through an injectable runner so tests pin the exact CLI argv
 * (`dsh plugin --profile <p> add|remove <pkg>`), the core-bundle guard,
 * flag-injection rejection, failure mapping and the refreshed snapshot.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CORE_BUNDLE, canRemovePlugin, isValidPluginSpec } from '../src/shared/plugins';
import { PluginManager, type PluginManagerOptions } from '../src/main/plugins/plugin-manager';

const tmpHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-plugins-test-'));
  tmpHomes.push(home);
  return home;
}

afterEach(() => {
  while (tmpHomes.length > 0) {
    rmSync(tmpHomes.pop()!, { recursive: true, force: true });
  }
});

/** Build `<home>/.dsh/profiles/headless` with bundles, a dep and versions. */
function seedProfile(home: string, manifest: Record<string, unknown>): string {
  const profileDir = path.join(home, '.dsh', 'profiles', 'headless');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest));
  const store = path.join(home, '.dsh', 'profiles', 'node_modules');
  for (const [name, version] of [
    [CORE_BUNDLE, '0.1.1'],
    ['@deepseek-ai/dsh-headless', '0.1.1-rc.2'],
    ['my-dsh-plugin', '1.2.3']
  ] as const) {
    const dir = path.join(store, ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
  return profileDir;
}

const SEEDED_MANIFEST = {
  name: 'dsh-profile-headless',
  private: true,
  dependencies: { 'my-dsh-plugin': '^1.0.0' },
  dsh: { profile: { bundles: [CORE_BUNDLE, '@deepseek-ai/dsh-headless', 'my-dsh-plugin'] } }
};

describe('PluginManager.snapshot', () => {
  it('lists bundles (in stack order) and dependencies with versions and flags', () => {
    const home = makeHome();
    seedProfile(home, SEEDED_MANIFEST);
    const snapshot = new PluginManager({ home, dshBin: null }).snapshot();

    expect(snapshot.profile).toBe('headless');
    expect(snapshot.profileExists).toBe(true);
    expect(snapshot.profileDir).toBe(path.join(home, '.dsh', 'profiles', 'headless'));
    expect(snapshot.plugins.map((p) => p.name)).toEqual([
      CORE_BUNDLE,
      '@deepseek-ai/dsh-headless',
      'my-dsh-plugin'
    ]);
    const core = snapshot.plugins[0]!;
    expect(core).toMatchObject({ version: '0.1.1', isBundle: true, protected: true });
    const plugin = snapshot.plugins[2]!;
    expect(plugin).toMatchObject({ version: '1.2.3', isBundle: true, protected: false });
    expect(canRemovePlugin(snapshot.plugins[0]!)).toBe(false);
    expect(canRemovePlugin(plugin)).toBe(true);
  });

  it('marks non-bundle dependencies as plain deps', () => {
    const home = makeHome();
    seedProfile(home, {
      dependencies: { 'my-dsh-plugin': '^1.0.0', 'plain-lib': '^2.0.0' },
      dsh: { profile: { bundles: [CORE_BUNDLE] } }
    });
    const snapshot = new PluginManager({ home, dshBin: null }).snapshot();
    const plain = snapshot.plugins.find((p) => p.name === 'plain-lib');
    expect(plain).toMatchObject({ isBundle: false, protected: false });
    // Deps sort alphabetically after the bundle section.
    expect(snapshot.plugins.map((p) => p.name).at(-1)).toBe('plain-lib');
  });

  it('reports an uninitialized profile without throwing', () => {
    const home = makeHome();
    const snapshot = new PluginManager({ home, dshBin: null }).snapshot();
    expect(snapshot.profileExists).toBe(false);
    expect(snapshot.plugins).toEqual([]);
  });

  it('survives a corrupted manifest (empty snapshot)', () => {
    const home = makeHome();
    const profileDir = seedProfile(home, {});
    writeFileSync(path.join(profileDir, 'package.json'), '{not json');
    const snapshot = new PluginManager({ home, dshBin: null }).snapshot();
    expect(snapshot.profileExists).toBe(true);
    expect(snapshot.plugins).toEqual([]);
  });
});

type Runner = NonNullable<PluginManagerOptions['runCommand']>;

function runnerReturning(result: { code: number; stdout: string; stderr: string }): {
  runner: Runner;
  calls: { dshBin: string; args: string[] }[];
} {
  const calls: { dshBin: string; args: string[] }[] = [];
  const runner: Runner = vi.fn(async (input) => {
    calls.push(input);
    return result;
  });
  return { runner, calls };
}

describe('PluginManager mutations', () => {
  it('add: runs the official CLI with the exact argv and returns a refreshed snapshot', async () => {
    const home = makeHome();
    seedProfile(home, SEEDED_MANIFEST);
    const { runner, calls } = runnerReturning({ code: 0, stdout: 'done', stderr: '' });
    const manager = new PluginManager({ home, dshBin: '/bin/dsh', runCommand: runner });

    const result = await manager.addPlugin('@scope/thing@^1.0.0');
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { dshBin: '/bin/dsh', args: ['plugin', '--profile', 'headless', 'add', '@scope/thing@^1.0.0'] }
    ]);
    expect(result.snapshot?.profile).toBe('headless');
  });

  it('remove: runs the official CLI with remove argv', async () => {
    const home = makeHome();
    seedProfile(home, SEEDED_MANIFEST);
    const { runner, calls } = runnerReturning({ code: 0, stdout: '', stderr: '' });
    const manager = new PluginManager({ home, dshBin: '/bin/dsh', runCommand: runner });

    const result = await manager.removePlugin('my-dsh-plugin');
    expect(result.ok).toBe(true);
    expect(calls[0]!.args).toEqual(['plugin', '--profile', 'headless', 'remove', 'my-dsh-plugin']);
  });

  it('refuses to remove the core bundle without touching the CLI', async () => {
    const home = makeHome();
    seedProfile(home, SEEDED_MANIFEST);
    const { runner, calls } = runnerReturning({ code: 0, stdout: '', stderr: '' });
    const manager = new PluginManager({ home, dshBin: '/bin/dsh', runCommand: runner });

    const result = await manager.removePlugin(CORE_BUNDLE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('核心');
    expect(calls).toEqual([]);
  });

  it('rejects flag injection and malformed specs without running the CLI', async () => {
    const home = makeHome();
    seedProfile(home, SEEDED_MANIFEST);
    const { runner, calls } = runnerReturning({ code: 0, stdout: '', stderr: '' });
    const manager = new PluginManager({ home, dshBin: '/bin/dsh', runCommand: runner });

    for (const bad of ['--silent', '-g pkg', 'pkg --force', '', '   ']) {
      expect((await manager.addPlugin(bad)).ok).toBe(false);
      expect((await manager.removePlugin(bad)).ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('maps a non-zero CLI exit to ok:false with the output tail', async () => {
    const home = makeHome();
    seedProfile(home, SEEDED_MANIFEST);
    const { runner } = runnerReturning({ code: 1, stdout: '', stderr: 'pnpm: 404 not found' });
    const manager = new PluginManager({ home, dshBin: '/bin/dsh', runCommand: runner });

    const result = await manager.addPlugin('@scope/missing');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('exit=1');
    expect(result.output).toContain('404 not found');
  });

  it('add/remove without a dsh CLI degrade to a diagnosable error', async () => {
    const home = makeHome();
    seedProfile(home, SEEDED_MANIFEST);
    const manager = new PluginManager({ home, dshBin: null });
    const added = await manager.addPlugin('@scope/pkg');
    expect(added.ok).toBe(false);
    expect(added.error).toContain('未找到 dsh CLI');
    const removed = await manager.removePlugin('my-dsh-plugin');
    expect(removed.ok).toBe(false);
  });
});

describe('isValidPluginSpec', () => {
  it('accepts registry specs (scoped, versioned)', () => {
    for (const ok of ['pkg', 'pkg@^1.0.0', '@scope/pkg', '@scope/pkg@1.x', 'my-dsh-plugin@next']) {
      expect(isValidPluginSpec(ok)).toBe(true);
    }
  });

  it('rejects flags, whitespace and junk', () => {
    for (const bad of ['', '  ', '--silent', '-g', 'pkg name', 'pkg;rm -rf /', '$(x)']) {
      expect(isValidPluginSpec(bad)).toBe(false);
    }
  });
});
