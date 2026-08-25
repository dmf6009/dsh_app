#!/usr/bin/env node
/**
 * Protocol smoke test — human-visible proof of the Phase 0 closed loop
 * without Electron: spawns the stub runtime, drives `run`, prints every
 * inbound protocol frame, then verifies the cancel path end-to-end.
 *
 * Usage: npm run smoke:protocol
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stubPath = path.join(root, 'scripts', 'stub-runtime.mjs');

const child = spawn(process.execPath, [stubPath], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
const frames = [];

const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);

async function main() {
  console.log(`[smoke] stub runtime spawned pid=${child.pid}`);
  let sawReady = false;
  let phase = 'ready';
  let deltas = 0;
  let cancelled = false;

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
        console.log(`  <malformed> ${line.slice(0, 80)}`);
        continue;
      }
      frames.push(frame.type);
      if (!sawReady && frame.type === 'ready') sawReady = true;

      switch (phase) {
        case 'ready':
          if (frame.type === 'run_started') phase = 'streaming';
          break;
        case 'streaming':
          if (frame.type === 'message_delta') deltas += 1;
          if (frame.type === 'done') phase = 'second-run';
          break;
        case 'second-run':
          if (frame.type === 'tool_started') {
            phase = 'cancel-pending';
            send({ v: 1, type: 'cancel' });
          }
          break;
        default:
          break;
      }
    }
  });

  // Drive scenario 1: full run → done.
  await sleepUntil(() => sawReady, 5000);
  console.log('[smoke] ready received; sending run');
  send({
    v: 1,
    type: 'run',
    run_id: 'smoke-run-1',
    session_id: 'smoke-session',
    workspace: process.cwd(),
    message: '修复登录接口偶发 500 的问题'
  });
  await sleepUntil(() => phase === 'second-run', 15000);

  // Scenario 2: cancel mid-run.
  send({
    v: 1,
    type: 'run',
    run_id: 'smoke-run-2',
    session_id: 'smoke-session',
    workspace: process.cwd(),
    message: '再跑一次，这次中途取消'
  });
  await sleepUntil(() => phase === 'cancel-pending', 15000);

  const exited = new Promise((resolve) => child.once('exit', resolve));
  const code = await Promise.race([exited, sleep(3000).then(() => 'timeout')]);
  cancelled = frames.includes('run_cancelled');

  console.log('[smoke] frame sequence:');
  for (const type of frames) {
    // compact: collapse repeated deltas visually
    console.log(`   · ${type}`);
  }

  const ok =
    sawReady &&
    deltas >= 3 &&
    frames.includes('message_completed') &&
    frames.includes('tool_started') &&
    frames.includes('tool_output') &&
    frames.includes('tool_completed') &&
    frames.filter((t) => t === 'done').length === 1 &&
    cancelled &&
    code === 0;

  console.log(
    ok
      ? '[smoke] PASS — ready/stream/tool/done/cancel closed loop verified'
      : `[smoke] FAIL — sawReady=${sawReady} deltas=${deltas} cancelled=${cancelled} exit=${code}`
  );
  child.kill('SIGKILL');
  process.exit(ok ? 0 : 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepUntil(predicate, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) resolve();
      else if (Date.now() - start > timeoutMs) reject(new Error('smoke timeout'));
      else setTimeout(tick, 25);
    };
    tick();
  });
}

main().catch((err) => {
  console.error('[smoke] error:', err.message);
  child.kill('SIGKILL');
  process.exit(1);
});
