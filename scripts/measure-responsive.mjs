#!/usr/bin/env node
/**
 * Responsive-layout regression runner (#5): two Electron launches under
 * Xvfb (or the user's display) drive the real UI at 500×400 / 700×500 /
 * 1280×800:
 *
 *   A) workspace legs  — idle + drawers, running, awaiting_cancel
 *   B) approval leg    — long-command modal, sticky Reject, internal scroll
 *
 * Element bounds land in docs/responsive/responsive-report*.json next to
 * PNG screenshots. Skips with exit code 0 when the Electron binary is not
 * downloaded (same policy as smoke:app).
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
    '[responsive] SKIP — Electron binary not downloaded in this environment. ' +
      'Layout regressions need the real renderer; run in a full checkout.'
  );
  process.exit(0);
}

const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const baseArgs =
  process.platform === 'linux'
    ? ['--no-sandbox', '--disable-dev-shm-usage']
    : [];

function launch(label, extraEnv) {
  console.log(`[responsive] launch ${label}${useXvfb ? ' (xvfb-run)' : ''} …`);
  const env = {
    ...process.env,
    DSH_RESPONSIVE_MEASURE: '1',
    STUB_RESIDENT_CANCEL: '1',
    STUB_DELTA_DELAY_MS: '220',
    ...extraEnv
  };
  const result = useXvfb
    ? spawnSync('xvfb-run', ['-a', electronPath, root, ...baseArgs], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    : spawnSync(electronPath, [root, ...baseArgs], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status === 0 && /"responsive":\s*"ok"/.test(result.stdout ?? '');
}

const workspaceOk = launch('workspace', {});
const approvalOk = launch('approval', { STUB_APPROVAL_FLOW: '1' });

if (workspaceOk && approvalOk) {
  console.log('[responsive] PASS — 500×400 / 700×500 / 1280×800 verified with element bounds and screenshots');
  process.exit(0);
}
console.error('[responsive] FAIL — see docs/responsive/responsive-report*.json');
process.exit(1);
