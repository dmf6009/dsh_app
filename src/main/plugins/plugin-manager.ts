/**
 * Profile plugin management — the Desktop surface of dsh「万物皆可插」.
 *
 * Listing reads the profile manifest directly
 * (`~/.dsh/profiles/<profile>/package.json`): its `dsh.profile.bundles` is
 * the ordered boot stack and `dependencies` the installed package set — the
 * authoritative installed state, without depending on pnpm output formatting.
 * Mutations go through the sanctioned CLI path
 * (`dsh plugin --profile <profile> add|remove <pkg>`), which forwards to pnpm
 * and then reconciles the bundle list against the installed state.
 *
 * All failures degrade to `{ ok: false, error }` / an empty snapshot — never
 * throw. The runner is injectable for tests.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  CORE_BUNDLE,
  DEFAULT_PLUGIN_PROFILE,
  isValidPluginSpec,
  type InstalledPlugin,
  type PluginsSnapshot,
  type PluginMutationResult
} from '../../shared/plugins';

const MUTATE_TIMEOUT_MS = 180_000;
const OUTPUT_TAIL_BYTES = 4000;

export interface PluginManagerOptions {
  /** User home (profile root is `<home>/.dsh/profiles`). */
  home: string;
  /** Resolved dsh CLI path; null disables add/remove (list still works). */
  dshBin: string | null;
  /** Profile whose plugins the Desktop manages (default `headless`). */
  profile?: string;
  /** Injectable command runner (tests); defaults to spawning the dsh CLI. */
  runCommand?: (input: { dshBin: string; args: string[] }) => Promise<{ code: number; stdout: string; stderr: string }>;
}

interface ProfileManifest {
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } };
}

function profilePaths(home: string, profile: string): { profilesRoot: string; profileDir: string; manifestPath: string } {
  const profilesRoot = path.join(home, '.dsh', 'profiles');
  const profileDir = path.join(profilesRoot, profile);
  return { profilesRoot, profileDir, manifestPath: path.join(profileDir, 'package.json') };
}

function readManifest(manifestPath: string): ProfileManifest | null {
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** Installed version of one package inside the shared profile store. */
function installedVersion(profilesRoot: string, name: string): string | undefined {
  const pkgPath = path.join(profilesRoot, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export class PluginManager {
  private readonly home: string;
  private readonly dshBin: string | null;
  private readonly profile: string;
  private readonly runCommand: NonNullable<PluginManagerOptions['runCommand']>;

  constructor(options: PluginManagerOptions) {
    this.home = options.home;
    this.dshBin = options.dshBin;
    this.profile = options.profile?.trim() || DEFAULT_PLUGIN_PROFILE;
    this.runCommand =
      options.runCommand ??
      ((input) =>
        new Promise((resolve) => {
          const child = spawn(input.dshBin, input.args, { stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (c) => {
            stdout += c;
          });
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (c) => {
            stderr += c;
          });
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }, MUTATE_TIMEOUT_MS);
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout, stderr });
          });
          child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`.trim() });
          });
        }));
  }

  snapshot(): PluginsSnapshot {
    const { profilesRoot, profileDir, manifestPath } = profilePaths(this.home, this.profile);
    const profileExists = existsSync(profileDir);
    // A corrupt manifest still means "profile exists" — degrade to an empty
    // plugin list so the UI stays diagnosable instead of claiming absence.
    const manifest = readManifest(manifestPath);
    if (!manifest) {
      return { profile: this.profile, profileDir, profileExists, plugins: [] };
    }
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh!.profile!.bundles : [];
    const deps = Object.keys(manifest.dependencies ?? {});
    const seen = new Set<string>();
    const plugins: InstalledPlugin[] = [];
    for (const name of [...bundles, ...deps.sort()]) {
      if (typeof name !== 'string' || name === '' || seen.has(name)) continue;
      seen.add(name);
      plugins.push({
        name,
        version: installedVersion(profilesRoot, name),
        isBundle: bundles.includes(name),
        protected: name === CORE_BUNDLE
      });
    }
    return { profile: this.profile, profileDir, profileExists: true, plugins };
  }

  async addPlugin(spec: string): Promise<PluginMutationResult> {
    const target = spec.trim();
    if (!isValidPluginSpec(target)) {
      return { ok: false, error: '无效的包名（支持 npm 名称与版本范围，如 @scope/pkg@^1.0.0）' };
    }
    return this.mutate('add', target);
  }

  async removePlugin(name: string): Promise<PluginMutationResult> {
    const target = name.trim();
    if (!isValidPluginSpec(target)) {
      return { ok: false, error: '无效的包名' };
    }
    if (target === CORE_BUNDLE) {
      return { ok: false, error: `${CORE_BUNDLE} 是 dsh 核心组件，不能卸载` };
    }
    return this.mutate('remove', target);
  }

  private async mutate(op: 'add' | 'remove', target: string): Promise<PluginMutationResult> {
    if (!this.dshBin) {
      return { ok: false, error: '未找到 dsh CLI，无法管理插件（请先完成 DSH 安装/路径配置）' };
    }
    const { code, stdout, stderr } = await this.runCommand({
      dshBin: this.dshBin,
      args: ['plugin', '--profile', this.profile, op, target]
    });
    if (code !== 0) {
      return { ok: false, error: `插件${op === 'add' ? '安装' : '卸载'}失败（exit=${code}）`, output: tail(stdout, stderr) };
    }
    return { ok: true, output: tail(stdout, stderr) || undefined, snapshot: this.snapshot() };
  }
}

function tail(stdout: string, stderr: string): string {
  const merged = `${stdout}\n${stderr}`.trim();
  return merged.length > OUTPUT_TAIL_BYTES ? merged.slice(-OUTPUT_TAIL_BYTES) : merged;
}
