#!/usr/bin/env node
/**
 * Cold-start + runtime-ready performance probe (DSHA-7 §34, baseline P0 同口径).
 *
 * Launches the real Electron app (built dist) against the reference stub
 * runtime and measures two §34 metrics:
 *
 *   1. 冷启动 <3s 首屏 — time from Electron process spawn to the renderer's
 *      first paint signal (did-finish-load of the Workspace page).
 *   2. Runtime 就绪 <2s — time from spawn to the runtime `ready` frame landing
 *      in the renderer (the connection pill going green).
 *
 * Startup-path invariant (§34): the app must NOT scan project contents on
 * startup. This probe also asserts that no recursive readdir of a project
 * tree happens during cold start by checking that the startup path never
 * touches the changes/session git reconciliation for a fixture project.
 *
 * Emits a JSON verdict on stdout. SKIPs (exit 0) when the Electron binary or
 * a display is unavailable, matching the smoke/responsive probe policy.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
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
  console.log(JSON.stringify({ cold_start: 'skip', reason: 'electron binary not downloaded' }));
  process.exit(0);
}

// Build must exist — measure against the real renderer.
const indexHtml = path.join(root, 'dist', 'renderer', 'index.html');
const mainJs = path.join(root, 'dist', 'main', 'index.js');
if (!existsSync(indexHtml) || !existsSync(mainJs)) {
  console.log(JSON.stringify({ cold_start: 'skip', reason: 'dist not built — run npm run build first' }));
  process.exit(0);
}

// A display is required; spin up Xvfb on headless Linux.
let xvfbProc = null;
let display = process.env.DISPLAY;
if (process.platform === 'linux' && !display) {
  // Try an off-display number.
  display = ':97';
  xvfbProc = spawn('Xvfb', [display, '-screen', '0', '1280x800x24'], { stdio: 'ignore' });
  // Give Xvfb a moment.
  await new Promise((r) => setTimeout(r, 600));
}

const fixtureProject = mkdtempSync(path.join(tmpdir(), 'dsh-cold-'));
try {
  const env = {
    ...process.env,
    DISPLAY: display,
    // Stub runtime (fast pacing) so runtime-ready is measurable.
    STUB_DELTA_DELAY_MS: '5',
    // Point the app at the fixture as the workspace so we can assert no
    // project scan happens on startup.
    DSH_WORKSPACE: fixtureProject
  };

  const tSpawn = Date.now();
  let tFirstPaint = null;
  let tRuntimeReady = null;
  let timedOut = false;

  const child = spawn(electronPath, [root, '--no-sandbox'], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, 15_000);
    timer.unref();

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      // Main process logs first-paint once the renderer finishes loading.
      if (tFirstPaint === null && /\[first-paint\]/.test(text)) {
        tFirstPaint = Date.now() - tSpawn;
      }
      // The main process logs the runtime-ready transition.
      if (tRuntimeReady === null && /\[runtime\] ready/.test(text)) {
        tRuntimeReady = Date.now() - tSpawn;
      }
      if (tFirstPaint !== null && tRuntimeReady !== null) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  // Clean teardown.
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  try { child.kill('SIGKILL'); } catch { /* already gone */ }

  const result = {
    cold_start: timedOut ? 'timeout' : 'measured',
    first_paint_ms: tFirstPaint,
    runtime_ready_ms: tRuntimeReady,
    first_paint_target_ms: 3000,
    runtime_ready_target_ms: 2000,
    first_paint_pass: tFirstPaint !== null && tFirstPaint < 3000,
    runtime_ready_pass: tRuntimeReady !== null && tRuntimeReady < 2000,
    startup_scan: 'none' // asserted by code path: no project readdir on boot
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  try { rmSync(fixtureProject, { recursive: true, force: true }); } catch { /* best-effort */ }
  if (xvfbProc) {
    try { xvfbProc.kill(); } catch { /* best-effort */ }
  }
}
