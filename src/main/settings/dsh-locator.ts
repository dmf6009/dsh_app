/**
 * DSH installation detection (§32/§38 startup chain).
 *
 * Resolution order:
 *   1. explicit override saved in Settings (SettingsStore dsh.path)
 *   2. `dsh` on the PATH
 *
 * A found binary is probed with `--version` (short timeout) so Home can show a
 * real "就绪" signal rather than mere file existence. All failures degrade to
 * `{ found: false }` with a displayable reason — never throw.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface DshLocatorOptions {
  /** Saved path override from Settings; null = resolve from PATH. */
  pathOverride?: string | null;
  /** PATH-like environment string; defaults to process.env.PATH. */
  pathEnv?: string;
  home?: string;
  /** Injectable version probe for tests. */
  runVersionProbe?: (binPath: string) => Promise<string | null>;
  probeTimeoutMs?: number;
}

export interface DshLocatorResult {
  found: boolean;
  path?: string;
  version?: string;
  reason?: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3000;

export async function locateDsh(options: DshLocatorOptions = {}): Promise<DshLocatorResult> {
  const probe =
    options.runVersionProbe ??
    ((bin: string) => defaultVersionProbe(bin, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS));

  if (options.pathOverride && options.pathOverride.trim() !== '') {
    const candidate = expandHome(options.pathOverride.trim(), options.home);
    if (!existsSync(candidate)) {
      return { found: false, reason: `配置的 DSH 路径不存在：${candidate}` };
    }
    if (!isExecutable(candidate)) {
      return { found: false, reason: `配置的 DSH 路径不可执行：${candidate}` };
    }
    const version = await probe(candidate);
    return { found: true, path: candidate, version: version ?? undefined };
  }

  const searched = searchPaths(options.pathEnv ?? process.env.PATH ?? '');
  for (const dir of searched) {
    const candidate = join(dir, 'dsh');
    if (isExecutable(candidate)) {
      const version = await probe(candidate);
      return { found: true, path: candidate, version: version ?? undefined };
    }
  }
  return { found: false, reason: '未在 PATH 中找到可执行的 dsh' };
}

function searchPaths(pathEnv: string): string[] {
  return pathEnv.split(delimiter).filter((dir) => dir.trim() !== '');
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(p: string, home?: string): string {
  if (p === '~') return home ?? '~';
  if (p.startsWith('~/')) return join(home ?? '', p.slice(2));
  return p;
}

/** Run `dsh --version`; resolves null on any failure/timeout. */
async function defaultVersionProbe(binPath: string, timeoutMs: number): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const child = execFile(
        binPath,
        ['--version'],
        { timeout: timeoutMs },
        (err, stdout) => {
          if (settled) return;
          settled = true;
          if (err && !stdout) resolve(null);
          else resolve(String(stdout).trim() || null);
        }
      );
      child.on('error', () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });
    });
  } catch {
    return null;
  }
}
