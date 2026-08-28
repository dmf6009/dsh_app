/**
 * Desktop profile adapter protocol self-test.
 *
 * Drives scripts/dsh-desktop-profile.mjs (raw child_process + codec) against
 * a mock dsh CLI and asserts the Runtime Protocol v1 contract the desktop
 * depends on: ready handshake (with the probed dsh version) → run_started →
 * message_delta chunks ⊆ message_completed content → run_completed terminal;
 * failure surfaces as error + run_cancelled (reason dsh_run_failed); cancel
 * mid-run emits run_cancelled (client_requested) and the process stays
 * resident; malformed inbound lines are tolerated; sequential runs work on
 * one process.
 */

import { chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

import { FrameDecoder } from '../src/shared/protocol/codec';
import { isTerminalEventType, type RuntimeEventFrame } from '../src/shared/protocol/types';
import { DESKTOP_PROFILE_PATH, MOCK_DSH_PATH } from './helpers';

// The adapter spawns the dsh binary directly, so the mock must be executable
// just like the real node_modules/.bin/dsh shim.
chmodSync(MOCK_DSH_PATH, 0o755);

interface Harness {
  child: ReturnType<typeof spawn>;
  frames: RuntimeEventFrame[];
  stderrText: string;
  send: (frame: Record<string, unknown>) => void;
  writeRaw: (text: string) => void;
  waitUntil: (predicate: (frames: RuntimeEventFrame[]) => boolean, timeoutMs?: number) => Promise<void>;
  exitInfo: () => { code: number | null; signal: string | null } | null;
}

const harnesses: Harness[] = [];

function launch(env: NodeJS.ProcessEnv = {}): Harness {
  const child = spawn(process.execPath, [DESKTOP_PROFILE_PATH], {
    env: {
      ...process.env,
      DSH_DESKTOP_DSH_BIN: MOCK_DSH_PATH,
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const decoder = new FrameDecoder();
  const h: Harness = {
    child,
    frames: [],
    stderrText: '',
    send: (frame) => child.stdin!.write(`${JSON.stringify(frame)}\n`),
    writeRaw: (text) => child.stdin!.write(text),
    waitUntil: async (predicate, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(h.frames)) {
        if (Date.now() > deadline) {
          throw new Error(`timeout; frames so far: ${h.frames.map((f) => f.type).join(',')}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    exitInfo: () =>
      child.exitCode !== null || child.signalCode !== null
        ? { code: child.exitCode, signal: child.signalCode }
        : null
  };
  child.stdout!.on('data', (chunk: Buffer) => {
    const result = decoder.push(chunk);
    h.frames.push(...(result.frames as RuntimeEventFrame[]));
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk) => {
    h.stderrText += chunk;
  });
  harnesses.push(h);
  return h;
}

function frameTypes(frames: RuntimeEventFrame[]): string[] {
  return frames.map((f) => f.type);
}

afterEach(() => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!;
    h.child.kill('SIGKILL');
  }
});

describe('desktop profile adapter — protocol contract', () => {
  it('handshakes with the probed dsh version before any run', async () => {
    const h = launch();
    // Send the run IMMEDIATELY — before the version probe completes — to pin
    // the guarantee that `ready` is always the first frame on the wire.
    h.send({
      v: 1,
      type: 'run',
      run_id: 'run-early',
      session_id: 'sess-1',
      workspace: process.cwd(),
      message: '早到的任务'
    });
    await h.waitUntil((frames) => frames.some((f) => f.type === 'ready'));
    const ready = h.frames.find((f) => f.type === 'ready');
    expect(ready).toMatchObject({ profile: 'desktop', dsh_version: 'mock-dsh 0.0.1' });
    expect(h.frames[0]!.type).toBe('ready');
    await h.waitUntil((frames) => frames.some((f) => isTerminalEventType(f.type)));
    expect(frameTypes(h.frames).at(-1)).toBe('run_completed');
  });

  it('runs a task: run_started → deltas ⊆ completed → run_completed terminal', async () => {
    const h = launch();
    await h.waitUntil((frames) => frames.some((f) => f.type === 'ready'));
    h.send({
      v: 1,
      type: 'run',
      run_id: 'run-1',
      session_id: 'sess-1',
      workspace: process.cwd(),
      message: '修复登录问题'
    });
    await h.waitUntil((frames) => frames.some((f) => isTerminalEventType(f.type)));

    const runStarted = h.frames.find((f) => f.type === 'run_started')!;
    expect(runStarted).toMatchObject({ run_id: 'run-1', session_id: 'sess-1' });

    expect(frameTypes(h.frames).filter((t) => t !== 'message_delta')).toEqual([
      'ready',
      'run_started',
      'message_completed',
      'run_completed'
    ]);
    const deltas = h.frames.filter((f) => f.type === 'message_delta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);

    const deltaText = deltas.map((f) => (f as { content: string }).content).join('');
    const completed = h.frames.find((f) => f.type === 'message_completed') as {
      content?: string;
    };
    expect(completed.content).toBe(deltaText);
    expect(completed.content).toContain('修复登录问题');

    const terminal = h.frames.at(-1)!;
    expect(terminal.type).toBe('run_completed');
    expect(terminal).toMatchObject({ run_id: 'run-1' });
    const summary = (terminal as { summary?: string }).summary ?? '';
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toBe(summary.split('\n')[0]);
  });

  it('surfaces a failing dsh run as error + run_cancelled (dsh_run_failed)', async () => {
    const h = launch({ MOCK_DSH_MODE: 'fail' });
    await h.waitUntil((frames) => frames.some((f) => f.type === 'ready'));
    h.send({ v: 1, type: 'run', run_id: 'run-f', session_id: 'sess-1', workspace: process.cwd(), message: 'x' });
    await h.waitUntil(
      (frames) => frames.some((f) => f.type === 'run_cancelled'),
      10_000
    );

    const error = h.frames.find((f) => f.type === 'error') as { code?: string; message?: string };
    expect(error.code).toBe('dsh_run_failed');
    expect(error.message).toContain('exit=3');

    const terminal = h.frames.at(-1)!;
    expect(terminal.type).toBe('run_cancelled');
    expect(terminal).toMatchObject({ run_id: 'run-f', reason: 'dsh_run_failed' });
    expect(frameTypes(h.frames)).not.toContain('run_completed');
  });

  it('cancel mid-run: run_cancelled (client_requested), process stays resident', async () => {
    const h = launch({ MOCK_DSH_DELAY_MS: '10000' });
    await h.waitUntil((frames) => frames.some((f) => f.type === 'ready'));
    h.send({ v: 1, type: 'run', run_id: 'run-c', session_id: 'sess-1', workspace: process.cwd(), message: 'x' });
    await h.waitUntil((frames) => frames.some((f) => f.type === 'run_started'));
    h.send({ v: 1, type: 'cancel' });
    await h.waitUntil((frames) => frames.some((f) => f.type === 'run_cancelled'));

    const cancelled = h.frames.find((f) => f.type === 'run_cancelled')!;
    expect(cancelled).toMatchObject({ run_id: 'run-c', reason: 'client_requested' });
    expect(frameTypes(h.frames)).not.toContain('run_completed');

    // Resident semantics: the adapter must NOT exit after a cancel (AC-11 —
    // input unlocks on run_cancelled without a runtime restart).
    await new Promise((r) => setTimeout(r, 120));
    expect(h.exitInfo()).toBeNull();

    // Still usable: closing stdin ends the process cleanly.
    h.child.stdin!.end();
    await new Promise((r) => setTimeout(r, 200));
    expect(h.exitInfo()?.code).toBe(0);
  });

  it('tolerates malformed inbound lines and still completes the next run', async () => {
    const h = launch();
    await h.waitUntil((frames) => frames.some((f) => f.type === 'ready'));
    h.writeRaw('this is not json at all\n{"v": 1, "type": "run_\n');
    h.send({ v: 1, type: 'run', run_id: 'run-m', session_id: 'sess-1', workspace: process.cwd(), message: 'y' });
    await h.waitUntil((frames) => frames.some((f) => isTerminalEventType(f.type)));
    expect(frameTypes(h.frames).at(-1)).toBe('run_completed');
    expect(h.frames.at(-1)).toMatchObject({ run_id: 'run-m' });
  });

  it('supports sequential runs over one process', async () => {
    const h = launch();
    await h.waitUntil((frames) => frames.some((f) => f.type === 'ready'));
    h.send({ v: 1, type: 'run', run_id: 'run-s1', session_id: 'sess-1', workspace: process.cwd(), message: 'a' });
    await h.waitUntil((frames) => frames.filter((f) => isTerminalEventType(f.type)).length >= 1);
    h.send({ v: 1, type: 'run', run_id: 'run-s2', session_id: 'sess-1', workspace: process.cwd(), message: 'b' });
    await h.waitUntil((frames) => frames.filter((f) => isTerminalEventType(f.type)).length >= 2);

    const terminals = h.frames.filter((f) => isTerminalEventType(f.type));
    expect(terminals.map((f) => f.run_id)).toEqual(['run-s1', 'run-s2']);
    expect(h.exitInfo()).toBeNull();
  });

  it('reports a missing dsh CLI as a diagnosable error instead of crashing', async () => {
    const h = launch({ DSH_DESKTOP_DSH_BIN: path.join(__dirname, 'fixtures', 'no-such-dsh') });
    await h.waitUntil((frames) => frames.some((f) => f.type === 'ready'));
    h.send({ v: 1, type: 'run', run_id: 'run-n', session_id: 'sess-1', workspace: process.cwd(), message: 'x' });
    await h.waitUntil((frames) => frames.some((f) => f.type === 'run_cancelled'));

    const error = h.frames.find((f) => f.type === 'error') as { code?: string };
    expect(error.code).toBe('dsh_cli_not_found');
    expect(h.exitInfo()).toBeNull();
  });
});
