#!/usr/bin/env node
/**
 * Optional smoke test against a real DSH desktop profile.
 *
 * The Phase 0 contract is `dsh --profile desktop --stdio` (§19). This script:
 *   1. resolves the runtime command from DSH_RUNTIME_BIN/DSH_RUNTIME_ARGS, or
 *      falls back to the dsh installed together with this app
 *      (`node_modules/.bin/dsh` from the @deepseek-ai/dsh dependency), then to
 *      `dsh --profile desktop --stdio` on the PATH
 *   2. SKIPs with exit code 0 when the command cannot start, so CI stays green
 *   3. otherwise drives one `run` and prints the observed event stream
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledBin = path.join(appRoot, 'node_modules', '.bin', 'dsh');

function resolveBundledDsh() {
  try {
    accessSync(bundledBin, fsConstants.X_OK);
    return bundledBin;
  } catch {
    return null;
  }
}

const bin =
  process.env.DSH_RUNTIME_BIN?.trim() ||
  resolveBundledDsh() ||
  'dsh';
const args = process.env.DSH_RUNTIME_ARGS
  ? process.env.DSH_RUNTIME_ARGS.split(/\s+/).filter(Boolean)
  : ['--profile', 'desktop', '--stdio'];

console.log(`[dsh-smoke] trying: ${bin} ${args.join(' ')}`);

const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const failSkip = (why) => {
  console.log(`[dsh-smoke] SKIP — ${why}`);
  console.log(
    '[dsh-smoke] The desktop profile ships with the dsh-desktop-runtime plugin (later phase).' +
      ' Protocol-level verification uses scripts/stub-runtime.mjs meanwhile.'
  );
};

const timer = setTimeout(() => {
  child.kill('SIGKILL');
  console.error('[dsh-smoke] FAIL — no ready frame within 10s');
  if (stderr.trim()) console.error(`[dsh-smoke] stderr:\n${stderr}`);
  process.exit(1);
}, 10_000);

let buffer = '';
let sawReady = false;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue; // tolerate non-protocol chatter on stdout
    }
    clearTimeout(timer);
    console.log(`[dsh-smoke] event: ${frame.type}`, JSON.stringify(frame));
    if (frame.type === 'ready') {
      sawReady = true;
      sendRun();
    } else if (frame.type === 'done' || frame.type === 'run_completed') {
      console.log('[dsh-smoke] PASS — real runtime closed the loop');
      child.kill('SIGTERM');
      process.exit(0);
    }
  }
});

function sendRun() {
  const runFrame = {
    v: 1,
    type: 'run',
    run_id: `smoke-${Date.now()}`,
    session_id: 'smoke-session',
    workspace: process.cwd(),
    message: '列出当前目录的文件'
  };
  child.stdin.write(`${JSON.stringify(runFrame)}\n`);
}

child.on('error', (err) => {
  clearTimeout(timer);
  failSkip(`cannot spawn "${bin}": ${err.message}`);
});

child.on('exit', (code) => {
  clearTimeout(timer);
  if (!sawReady) {
    // Most likely "profile desktop does not exist".
    const profileMissing = /profile .* does not exist/i.test(stderr);
    failSkip(
      profileMissing
        ? `desktop profile not installed in this environment (exit=${code})`
        : `runtime exited before ready (exit=${code})${stderr ? `; stderr: ${stderr.trim().slice(0, 400)}` : ''}`
    );
  }
});
