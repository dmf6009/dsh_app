/**
 * Stub runtime protocol consistency self-test (DSHA-3 测试要求 #3).
 *
 * Drives scripts/stub-runtime.mjs directly (raw child_process + codec) and
 * asserts the invariants the desktop profile contract must hold:
 * ready first → run_started → deltas ⊆ completed content → tool trio in
 * order → done terminal; every frame carries v=1 and a consistent run_id.
 * Also covers cancel-mid-run semantics, malformed-input tolerance, and
 * sequential runs on one process.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FrameDecoder
} from '../src/shared/protocol/codec';
import {
  RUNTIME_EVENT_TYPES,
  isTerminalEventType,
  type RuntimeEventFrame
} from '../src/shared/protocol/types';
import { STUB_PATH } from './helpers';

interface Harness {
  child: ReturnType<typeof spawn>;
  frames: RuntimeEventFrame[];
  invalidCount: number;
  stderrText: string;
  send: (frame: Record<string, unknown>) => void;
  writeRaw: (text: string) => void;
  waitUntil: (
    predicate: (frames: RuntimeEventFrame[]) => boolean,
    timeoutMs?: number
  ) => Promise<void>;
  exitInfo: () => { code: number | null; signal: string | null } | null;
}

const harnesses: Harness[] = [];

function launch(env: NodeJS.ProcessEnv = {}): Harness {
  const child = spawn(process.execPath, [STUB_PATH], {
    env: { ...process.env, STUB_DELTA_DELAY_MS: '8', ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  // Reuse the production decoder — the stub's stdout must be decodable by it.
  const decoder = new FrameDecoder();
  const h: Harness = {
    child,
    frames: [],
    invalidCount: 0,
    stderrText: '',
    send: (frame) => child.stdin!.write(`${JSON.stringify(frame)}\n`),
    writeRaw: (text) => child.stdin!.write(text),
    waitUntil: async (predicate, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(h.frames)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timeout; frames so far: ${h.frames.map((f) => f.type).join(',')}`
          );
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
    h.invalidCount += result.invalid.length;
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (text: string) => {
    h.stderrText += text;
  });
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    if (h.child.exitCode === null && h.child.signalCode === null) {
      h.child.kill('SIGKILL');
    }
  }
});

function runCommand(runId: string): Record<string, unknown> {
  return {
    v: 1,
    type: 'run',
    run_id: runId,
    session_id: 'selftest',
    workspace: '/tmp/proj',
    message: '修复登录接口偶发 500'
  };
}

describe('stub runtime — protocol consistency', () => {
  it('replays the full canonical scenario with correct ordering', async () => {
    const h = launch();
    await h.waitUntil((f) => f[0]?.type === 'ready');

    h.send(runCommand('run-1'));
    await h.waitUntil(
      (f) => f.filter((x) => x.type === 'done').length >= 1 && f.at(-1)!.type === 'done'
    );

    const types = h.frames.map((f) => f.type);
    const idxOf = (t: string): number[] =>
      types.map((x, i) => (x === t ? i : -1)).filter((i) => i >= 0);

    // Envelope sanity for every frame.
    for (const frame of h.frames) {
      expect(frame.v).toBe(1);
      expect(RUNTIME_EVENT_TYPES).toContain(frame.type);
    }
    // Every run-scoped frame echoes the requested run_id; only the
    // pre-run `ready` frame omits it.
    const readyCount = h.frames.filter((f) => f.type === 'ready').length;
    expect(readyCount).toBe(1);
    for (const frame of h.frames.slice(1)) {
      expect(frame.run_id).toBe('run-1');
    }

    // Ordering invariants.
    expect(types[0]).toBe('ready');
    expect(idxOf('run_started')).toHaveLength(1);
    const startedAt = idxOf('run_started')[0]!;
    const firstDeltaAt = idxOf('message_delta')[0]!;
    const lastDeltaAt = Math.max(...idxOf('message_delta'));
    const completedAt = idxOf('message_completed')[0]!;
    const toolStartedAt = idxOf('tool_started')[0]!;
    const firstToolOutputAt = idxOf('tool_output')[0]!;
    const lastToolOutputAt = Math.max(...idxOf('tool_output'));
    const toolCompletedAt = idxOf('tool_completed')[0]!;
    expect(startedAt).toBeLessThan(firstDeltaAt);
    expect(lastDeltaAt).toBeLessThan(completedAt);
    expect(toolStartedAt).toBeLessThan(firstToolOutputAt);
    expect(lastToolOutputAt).toBeLessThan(toolCompletedAt);
    expect(idxOf('done')).toEqual([types.length - 1]); // terminal & last
    expect(isTerminalEventType(h.frames.at(-1)!.type)).toBe(true);

    // Content coherence: streamed deltas concatenate to the completed message.
    const streamed = h.frames
      .filter((f) => f.type === 'message_delta')
      .map((f) => (f as { content?: string }).content ?? '')
      .join('');
    const completed = h.frames.find((f) => f.type === 'message_completed')! as {
      content?: string;
    };
    expect(streamed.length).toBeGreaterThan(0);
    expect(completed.content).toBe(streamed);

    // Tool trio shares one tool_call_id and reports success.
    type WithToolCallId = { run_id?: string; tool_call_id?: string };
    const startedToolId = (
      h.frames.find((f) => f.type === 'tool_started')! as unknown as WithToolCallId
    ).tool_call_id;
    expect(typeof startedToolId).toBe('string');
    for (const frame of h.frames) {
      if (frame.type === 'tool_output' || frame.type === 'tool_completed') {
        expect((frame as unknown as WithToolCallId).tool_call_id).toBe(startedToolId);
      }
    }
    const toolCompleted = h.frames.find((f) => f.type === 'tool_completed')! as unknown as {
      status?: string;
    };
    expect(toolCompleted.status).toBe('ok');
    expect(h.frames.find((f) => f.type === 'done')!.summary).toBeTruthy();

    // No decoder-level violations were produced by a well-behaved stub.
    expect(h.invalidCount).toBe(0);
  });

  it('supports multiple sequential runs over one process', async () => {
    const h = launch();
    await h.waitUntil((f) => f[0]?.type === 'ready');
    const pidAliveBefore = h.child.exitCode === null;

    h.send(runCommand('seq-1'));
    await h.waitUntil((f) => f.some((x) => x.type === 'done' && x.run_id === 'seq-1'));
    h.send(runCommand('seq-2'));
    await h.waitUntil(
      (f) => f.some((x) => x.type === 'done' && x.run_id === 'seq-2') && f.at(-1)!.type === 'done'
    );

    expect(pidAliveBefore).toBe(true);
    expect(h.frames.filter((f) => f.type === 'run_started').map((f) => f.run_id)).toEqual([
      'seq-1',
      'seq-2'
    ]);
    expect(h.child.exitCode).toBeNull(); // still serving after two runs
  });

  it('cancel mid-run: stops streaming, emits run_cancelled last, exits 0', async () => {
    const h = launch();
    await h.waitUntil((f) => f[0]?.type === 'ready');

    let cancelRequested = false;
    h.send(runCommand('cancel-me'));
    await h.waitUntil((f) => f.some((x) => x.type === 'message_delta'));
    h.send({ v: 1, type: 'cancel', run_id: 'cancel-me' });
    cancelRequested = true;
    await h.waitUntil(
      (f) => cancelRequested && f.some((x) => x.type === 'run_cancelled')
    );

    // Nothing may follow the cancellation: the stub stops streaming and exits.
    const cancelledIdx = h.frames.findIndex((f) => f.type === 'run_cancelled');
    expect(cancelledIdx).toBeGreaterThan(0);
    const tailTypes = h.frames.slice(cancelledIdx + 1).map((f) => f.type);
    for (const banned of [
      'message_delta',
      'message_completed',
      'tool_started',
      'tool_output',
      'tool_completed',
      'done'
    ]) {
      expect(tailTypes).not.toContain(banned);
    }
    const cancelled = h.frames.find((f) => f.type === 'run_cancelled')!;
    expect(cancelled.run_id).toBe('cancel-me');

    // Stub exits promptly with code 0 after run_cancelled.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const tick = (): void => {
        if (h.exitInfo()) resolve();
        else if (Date.now() > deadline) reject(new Error('stub did not exit after cancel'));
        else setTimeout(tick, 20);
      };
      tick();
    });
    expect(h.exitInfo()).toMatchObject({ code: 0, signal: null });
  });

  it('survives malformed and oversized inbound lines, then still completes a run', async () => {
    const h = launch({ STUB_MAX_LINE_BYTES: String(1024 * 64) });
    await h.waitUntil((f) => f[0]?.type === 'ready');

    h.writeRaw('this line is not JSON\n');
    h.writeRaw('[1,2,3]\n');
    h.writeRaw(`{"v":1,"bloat":"${'x'.repeat(200 * 1024)}"}\n`); // terminated oversize
    h.writeRaw(`${'y'.repeat(300 * 1024)}`); // unterminated oversize
    h.send({ v: 999, type: 'mystery' }); // bad envelope version

    h.send(runCommand('after-garbage'));
    await h.waitUntil((f) => f.some((x) => x.type === 'done' && x.run_id === 'after-garbage'));

    expect(h.stderrText).toMatch(/malformed|oversized|ignoring/i);
    // The garbage never leaked into the event stream as frames.
    expect(h.frames.every((f) => f.type !== undefined)).toBe(true);
    expect(h.frames.some((f) => (f as { type?: string }).type === 'mystery')).toBe(false);
  }, 20_000);

  it('exits cleanly when stdin closes', async () => {
    const h = launch();
    await h.waitUntil((f) => f[0]?.type === 'ready');
    h.child.stdin!.end();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const tick = (): void => {
        if (h.exitInfo()) resolve();
        else if (Date.now() > deadline) reject(new Error('stub did not exit on stdin close'));
        else setTimeout(tick, 20);
      };
      tick();
    });
    expect(h.exitInfo()).toMatchObject({ code: 0 });
  });
});
