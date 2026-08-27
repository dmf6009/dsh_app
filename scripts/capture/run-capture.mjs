#!/usr/bin/env node
/**
 * Fail-closed launcher for the DSHA-6 Diff capture + assertion gate.
 *
 * `scripts/capture/main.cjs` uses the Electron main-process API (`app`,
 * `BrowserWindow`) and therefore must be executed BY the Electron binary (as
 * the app entry), not by plain `node` — under plain `node`, `require('electron')`
 * returns the path string, not the runtime, and the gate never actually runs.
 *
 * This launcher resolves the Electron binary exactly the way the smoke harness
 * does and spawns `electron main.cjs`, so `npm run capture:diff` reproduces the
 * real assertion gate. **Fail-closed:** if ANY run dependency is missing
 * (Electron binary, built renderer entry, or xvfb on a display-less Linux box)
 * the command exits NON-ZERO — never a green-looking "SKIP". The Electron child
 * is run with a bounded timeout and full error/signal propagation so a wedged
 * child (e.g. ERR_FILE_NOT_FOUND on a missing build) cannot hang CI or leak a
 * process. The pure decision logic lives in ./launcher.mjs and is unit-tested.
 *
 * Run:  npm run capture:diff   (exit 0 only if every assertion passes)
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { preflightErrors, spawnPlan, exitCode, DEFAULT_TIMEOUT_MS } from './launcher.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const mainCjs = path.join(root, 'scripts', 'capture', 'main.cjs');
const indexHtml = path.join(root, 'dist', 'renderer', 'index.html');

let electronPath;
try {
  electronPath = require('electron');
} catch {
  electronPath = null;
}

// Is an Xvfb wrapper required? (Linux with no DISPLAY.) If so, xvfb-run must be
// discoverable, otherwise the gate cannot run and we fail-closed.
const useXvfbNeeded = process.platform === 'linux' && !process.env.DISPLAY;
let xvfbAvailable = !useXvfbNeeded;
if (useXvfbNeeded) {
  try {
    execFileSync('which', ['xvfb-run'], { stdio: 'ignore' });
    xvfbAvailable = true;
  } catch {
    xvfbAvailable = false;
  }
}

const preflight = preflightErrors({
  electronPath,
  electronExists: typeof electronPath === 'string' && existsSync(electronPath),
  indexExists: existsSync(indexHtml),
  xvfbNeeded: useXvfbNeeded,
  xvfbAvailable,
});
if (preflight.length > 0) {
  console.error('[capture] FAIL — capture gate cannot run (fail-closed):');
  for (const e of preflight) console.error('  - ' + e);
  console.error('The assertion gate was NOT executed. This is a non-zero failure, not a skip.');
  process.exit(1);
}

const { useXvfb, extraElectronArgs } = spawnPlan({
  platform: process.platform,
  hasDisplay: !!process.env.DISPLAY,
  electronArgsEnv: process.env.DSH_ELECTRON_ARGS
});
const childArgs = [mainCjs, ...extraElectronArgs];

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0' };
const timeoutMs = (() => {
  const v = process.env.DSH_CAPTURE_TIMEOUT_MS;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
})();

// stdio:'inherit' surfaces Electron stderr (e.g. ERR_FILE_NOT_FOUND) to CI.
// killSignal: SIGTERM so a timed-out child is reaped; spawnSync returns signal
// on kill and exitCode() maps that to 1 (fail-closed).
let result;
if (useXvfb) {
  result = spawnSync(
    'xvfb-run',
    ['-a', '--server-args=-screen 0 1920x1080x24', electronPath, ...childArgs],
    { env, stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGTERM' }
  );
} else {
  result = spawnSync(electronPath, childArgs, {
    env,
    stdio: 'inherit',
    timeout: timeoutMs,
    killSignal: 'SIGTERM'
  });
}

const code = exitCode({
  status: result.status,
  signal: result.signal,
  error: result.error ?? null,
  timedOut: !!result.timedOut
});

if (result.timedOut) {
  console.error(`[capture] FAIL — capture gate timed out after ${timeoutMs}ms and was terminated (fail-closed).`);
} else if (result.error) {
  console.error(`[capture] FAIL — capture gate child failed to spawn or crashed: ${result.error.message}`);
}

process.exit(code);
