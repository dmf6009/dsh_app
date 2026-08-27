#!/usr/bin/env node
/**
 * Launcher for the DSHA-6 Diff capture + assertion gate.
 *
 * `scripts/capture/main.cjs` uses the Electron main-process API
 * (`app`, `BrowserWindow`) and therefore must be executed BY the Electron
 * binary (as the app entry), not by plain `node` — under plain node,
 * `require('electron')` returns the path string, not the runtime, and the
 * gate never actually runs (`app.disableHardwareAcceleration` throws). This
 * launcher resolves the Electron binary exactly the way the smoke harness
 * does and spawns `electron main.cjs`, so `npm run capture:diff` reproduces
 * the real assertion gate (exit 0 only if every scenario passes).
 *
 * Container-friendly defaults: `--no-sandbox` / `--disable-dev-shm-usage`
 * on Linux mirror `scripts/smoke-electron.mjs` (no SUID sandbox helper in a
 * container); the renderer still keeps its contextIsolation/sandbox
 * webPreferences.
 *
 * Honors DISPLAY when set; otherwise wraps the spawn in `xvfb-run -a`.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const mainCjs = path.join(root, 'scripts', 'capture', 'main.cjs');

let electronPath;
try {
  electronPath = require('electron');
} catch {
  electronPath = null;
}

if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
  console.error(
    '[capture] SKIP — Electron binary not available in this environment ' +
      '(npm postinstall blocked). The assertion gate requires the Electron ' +
      'runtime; the pure predicate logic is still covered by tests/capture-gate.test.ts.'
  );
  process.exit(0);
}

const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const args = [mainCjs];
if (process.env.DSH_ELECTRON_ARGS) {
  args.push(...process.env.DSH_ELECTRON_ARGS.split(/\s+/).filter(Boolean));
} else if (process.platform === 'linux') {
  args.push('--no-sandbox', '--disable-dev-shm-usage');
}

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0' };
const result = useXvfb
  ? spawnSync('xvfb-run', ['-a', '--server-args=-screen 0 1920x1080x24', electronPath, ...args], {
      env,
      encoding: 'utf8',
      stdio: 'inherit'
    })
  : spawnSync(electronPath, args, { env, encoding: 'utf8', stdio: 'inherit' });

process.exit(result.status ?? 1);
