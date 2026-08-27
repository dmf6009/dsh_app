#!/usr/bin/env node
/**
 * Fail-closed launcher for the DSHA-6 Diff capture + assertion gate.
 *
 * `scripts/capture/main.cjs` uses the Electron main-process API (`app`,
 * `BrowserWindow`) and therefore must be executed BY the Electron binary (as
 * the app entry), not by plain `node`.
 *
 * Process-tree ownership (review requirement: "no orphaned processes"):
 * The prior launcher used `spawnSync('xvfb-run', ...)` with a `timeout` — but
 * Node only signals/reaps the DIRECT child (the xvfb-run shell); Electron and
 * the Xvfb server are grandchildren. The `xvfb-run` script traps only `EXIT`,
 * not `SIGTERM`, so a timeout could kill the wrapper while leaving Electron +
 * Xvfb running. This launcher instead manages the process tree directly:
 *  - on a display-less Linux box it spawns `Xvfb` ITSELF (not via xvfb-run),
 *    owns its pid, waits for readiness, sets DISPLAY, and reaps it explicitly;
 *  - it spawns Electron as a detached process-group leader and runs it under a
 *    bounded timeout, using proc-tree.runChild which tree-kills the whole
 *    group (SIGTERM → SIGKILL escalation) on timeout/error/exit;
 *  - on every exit path (success, timeout, error) it tree-kills Electron then
 *    kills Xvfb, so no descendants are orphaned.
 *
 * Fail-closed: if the Electron binary, the built renderer entry, or Xvfb (on a
 * display-less Linux box) is missing, the command exits NON-ZERO — never a
 * green-looking SKIP. The pure decision logic lives in launcher.mjs and
 * proc-tree.mjs, both unit-tested; the process-tree behaviour is covered by
 * tests/launcher-integration.test.ts.
 *
 * Run:  npm run capture:diff   (exit 0 only if every assertion passes)
 */
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { preflightErrors, spawnPlan, DEFAULT_TIMEOUT_MS } from './launcher.mjs';
import { exitCodeFor, isPidAliveSync, runChild, treeKill } from './proc-tree.mjs';

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

const { useXvfb, extraElectronArgs } = spawnPlan({
  platform: process.platform,
  hasDisplay: !!process.env.DISPLAY,
  electronArgsEnv: process.env.DSH_ELECTRON_ARGS
});

// Resolve the Xvfb binary path when we must manage our own headless server.
// On Linux without a DISPLAY we start Xvfb directly (not via the xvfb-run
// shell) so we own and reap it.
let xvfbBin = null;
if (useXvfb) {
  try {
    xvfbBin = execFileSync('which', ['Xvfb'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    xvfbBin = null;
  }
}

const preflight = preflightErrors({
  electronPath,
  electronExists: typeof electronPath === 'string' && existsSync(electronPath),
  indexExists: existsSync(indexHtml),
  // The preflight helper keys xvfb need/availability off these fields. We have
  // folded the xvfb-binary check into xvfbAvailable so a missing Xvfb binary
  // fails-closed instead of SKIP.
  xvfbNeeded: useXvfb,
  xvfbAvailable: !useXvfb || !!xvfbBin
});
if (preflight.length > 0) {
  console.error('[capture] FAIL — capture gate cannot run (fail-closed):');
  for (const e of preflight) console.error('  - ' + e);
  console.error('The assertion gate was NOT executed. This is a non-zero failure, not a skip.');
  process.exit(1);
}

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '0' };
const timeoutMs = (() => {
  const v = process.env.DSH_CAPTURE_TIMEOUT_MS;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
})();
const childArgs = [mainCjs, ...extraElectronArgs];

// ---- Managed Xvfb (headless Linux) -----------------------------------------
// Start Xvfb directly as a detached process-group leader, wait for it to be
// ready (probe the display), then export DISPLAY for the Electron child. We
// keep its pid so we can tree-kill it on every exit path.
let xvfbChild = null;
let display = null;
let authFile = null;
if (useXvfb) {
  // Use a private Xauthority so we don't touch the user's; mirror xvfb-run.
  const tmpDir = execFileSync('mktemp', ['-d', '-t', 'dsh-capture.Xvfb.XXXXXX'], { encoding: 'utf8' }).trim();
  authFile = path.join(tmpDir, 'Xauthority');
  try {
    execFileSync('touch', [authFile], { stdio: 'ignore' });
  } catch { /* best effort */ }
  // Use a high display number to avoid colliding with stale sockets left by
  // other runs (the ready-probe also requires pid-alive, but a high number
  // reduces collision risk further).
  display = `:${process.env.DSH_XVFB_DISPLAY ?? 219}`;
  const mcookie = execFileSync('mcookie', [], { encoding: 'utf8' }).trim() || '0'.repeat(32);
  try {
    execFileSync('xauth', ['-f', authFile, 'add', display, '.', mcookie], { stdio: 'ignore' });
  } catch { /* xauth optional; Xvfb may allow without */ }
  xvfbChild = spawn(
    xvfbBin,
    [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-auth', authFile],
    { detached: true, stdio: 'ignore', env: { ...env, XAUTHORITY: authFile } }
  );
  xvfbChild.unref?.();
  // Wait for Xvfb readiness (bounded; fail-closed if it never comes up).
  const ready = await waitForXvfb(display, xvfbChild.pid, 8000);
  if (!ready) {
    console.error(`[capture] FAIL — Xvfb did not become ready on ${display} within 8s (fail-closed).`);
    if (xvfbChild.pid) treeKill({ pid: xvfbChild.pid, signal: 'SIGTERM', graceMs: 1500 });
    cleanupAuth(authFile ? path.dirname(authFile) : null, display);
    process.exit(1);
  }
}

env.DISPLAY = display ?? env.DISPLAY ?? '';
if (authFile) env.XAUTHORITY = authFile;

// ---- Run Electron under the capture gate, with process-tree ownership ------
const result = await runChild(electronPath, childArgs, {
  timeoutMs,
  killSignal: 'SIGTERM',
  graceMs: 2000,
  env,
  stdio: 'inherit'
});

// ---- Cleanup: reap Electron tree, then Xvfb (no orphans on any path) ------
if (result.pid) {
  // runChild already tree-kills on finish, but be explicit/belt-and-suspenders.
  treeKill({ pid: result.pid, signal: 'SIGTERM', graceMs: 1500 });
}
if (xvfbChild && xvfbChild.pid) {
  treeKill({ pid: xvfbChild.pid, signal: 'SIGTERM', graceMs: 1500 });
}
cleanupAuth(authFile ? path.dirname(authFile) : null, display);

const code = exitCodeFor(result);
if (isTimeoutErrorShape(result)) {
  console.error(`[capture] FAIL — capture gate timed out after ${timeoutMs}ms; process tree reaped (fail-closed).`);
} else if (result.error) {
  console.error(`[capture] FAIL — capture gate child failed: ${result.error.message}`);
}
process.exit(code);

// ---- helpers ---------------------------------------------------------------

/** Probe Xvfb readiness WITHOUT external X tools (xset/xdpyinfo may be
 * absent). Xvfb binds a Unix socket at /tmp/.X11-unix/X<display> once it is
 * ready to accept connections; we poll for that socket's existence while the
 * process stays alive. If the process died first, Xvfb failed to start →
 * false (fail-closed). No dependency on xset/xdpyinfo.
 *
 * Stale-socket robustness: a leftover socket from a previous run could fool a
 * single sample. We require the socket to be a socket AND the Xvfb pid to be
 * alive — if Xvfb failed to bind the display it exits, so pid-alive already
 * distinguishes a real bind from a stale socket with a dead server. */
async function waitForXvfb(disp, xvfbPid, deadlineMs) {
  // disp looks like ":99" → display number 99 → socket path /tmp/.X11-unix/X99
  const num = parseInt(String(disp).replace(/^:/, ''), 10);
  const sock = Number.isFinite(num) ? `/tmp/.X11-unix/X${num}` : null;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (xvfbPid && !isPidAliveSync(xvfbPid)) return false; // Xvfb exited early
    if (sock && existsSync(sock)) {
      try {
        if (statSync(sock).isSocket()) {
          // Require TWO consecutive samples (a brief stable window) so a
          // transient filesystem race doesn't produce a false ready.
          await new Promise((r) => setTimeout(r, 80));
          if (xvfbPid && !isPidAliveSync(xvfbPid)) return false;
          if (existsSync(sock)) {
            try {
              if (statSync(sock).isSocket()) return true;
            } catch { /* not ready */ }
          }
        }
      } catch { /* not ready yet */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Remove the private Xauthority temp dir and the Xvfb socket for our display;
 * best-effort. Called after Xvfb is tree-killed so we don't leave socket/
 * auth residue for a future run's ready-probe to trip on. */
function cleanupAuth(tmpDir, disp) {
  if (tmpDir) {
    try {
      execFileSync('rm', ['-rf', tmpDir], { stdio: 'ignore' });
    } catch { /* best effort */ }
  }
  if (disp) {
    const num = parseInt(String(disp).replace(/^:/, ''), 10);
    if (Number.isFinite(num)) {
      try {
        const sock = `/tmp/.X11-unix/X${num}`;
        if (existsSync(sock)) execFileSync('rm', ['-f', sock], { stdio: 'ignore' });
      } catch { /* best effort */ }
    }
  }
}

/** Detect the timeout shape for logging. runChild sets timedOut=true OR
 * error.code ETIMEDOUT (spawnSync path) when the deadline fires. */
function isTimeoutErrorShape(r) {
  return !!r && (r.timedOut === true || (r.error && r.error.code === 'ETIMEDOUT'));
}
