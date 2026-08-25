#!/usr/bin/env node
/**
 * Electron app smoke test: boots the real main process under xvfb with
 * DSH_SMOKE=1. The main process then drives the stub runtime through a full
 * run and exits 0 on `done` / non-zero otherwise.
 *
 * Requires the Electron binary (node_modules/electron/dist/electron).
 * Skips with exit code 0 when the binary is unavailable so this can be wired
 * into CI in environments where the Electron download is blocked.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let electronPath;
try {
  electronPath = require('electron');
} catch {
  electronPath = null;
}

if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
  console.log(
    '[app-smoke] SKIP — Electron binary not downloaded in this environment ' +
      '(npm postinstall blocked). Protocol layer is verified by npm test + npm run smoke:protocol.'
  );
  process.exit(0);
}

const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;

// Containers/CI usually lack a configured SUID sandbox helper; the Electron
// `--no-sandbox` flag only disables the Chromium sandbox layer, while the
// renderer keeps its contextIsolation/sandbox webPreferences from main.
const electronArgs = [root];
if (process.env.DSH_ELECTRON_ARGS) {
  electronArgs.push(...process.env.DSH_ELECTRON_ARGS.split(/\s+/).filter(Boolean));
} else if (process.platform === 'linux') {
  // Container-friendly defaults: no SUID sandbox, no /dev/shm dependency.
  electronArgs.push('--no-sandbox', '--disable-dev-shm-usage');
}

console.log(
  `[app-smoke] launching Electron${useXvfb ? ' under xvfb-run' : ''} with DSH_SMOKE=1 …`
);

const env = { ...process.env, DSH_SMOKE: '1', ELECTRON_ENABLE_LOGGING: '0' };
let result;
if (useXvfb) {
  result = spawnSync('xvfb-run', ['-a', electronPath, ...electronArgs], { env, encoding: 'utf8' });
} else {
  result = spawnSync(electronPath, electronArgs, { env, encoding: 'utf8' });
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

const ok = result.status === 0 && /"smoke": "ok"/.test(result.stdout ?? '');
console.log(ok ? '[app-smoke] PASS — Electron ↔ stub runtime closed loop verified' : '[app-smoke] FAIL');
process.exit(ok ? 0 : 1);
