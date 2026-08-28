/**
 * Shared test helpers: spawn the stub runtime with fast pacing and collect
 * protocol frames through a real DshProcessManager.
 */

import path from 'node:path';
import process from 'node:process';

import { DshProcessManager } from '../src/main/runtime/dsh-process-manager';
import type { RuntimeEventFrame } from '../src/shared/protocol/types';

export const ROOT = path.resolve(__dirname, '..');
export const STUB_PATH = path.join(ROOT, 'scripts', 'stub-runtime.mjs');
export const DESKTOP_PROFILE_PATH = path.join(ROOT, 'scripts', 'dsh-desktop-profile.mjs');
export const MOCK_DSH_PATH = path.join(__dirname, 'fixtures', 'mock-dsh.mjs');

/** Env for spawning the stub quickly in tests. */
export function stubEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, STUB_DELTA_DELAY_MS: '10', ...extra };
}

export function makeStubManager(
  options: Partial<ConstructorParameters<typeof DshProcessManager>[0]> & {
    env?: NodeJS.ProcessEnv;
  } = {}
): DshProcessManager {
  const { env, ...rest } = options;
  return new DshProcessManager({
    command: process.execPath,
    args: [STUB_PATH],
    env: stubEnv(env),
    ...rest
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FrameSink {
  frames: RuntimeEventFrame[];
  /** Resolves when `until` matches; rejects on timeout. */
  done: Promise<void>;
  errors: { reason: string; detail?: string; preview?: string }[];
  oversized: number[];
  stderrText: string;
  exits: { code: number | null; signal: string | null; expected: boolean }[];
}

/** Attach collectors to a manager and expose an `until`-style completion promise. */
export function collect(
  manager: DshProcessManager,
  until: (frames: RuntimeEventFrame[]) => boolean,
  timeoutMs = 15_000
): FrameSink {
  const sink: FrameSink = {
    frames: [],
    done: undefined as unknown as Promise<void>,
    errors: [],
    oversized: [],
    stderrText: '',
    exits: []
  };
  let timer: NodeJS.Timeout | null = null;
  sink.done = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timeout waiting for condition; got ${JSON.stringify(sink.frames.map((f) => f.type))}`));
    }, timeoutMs);
    const check = (): void => {
      if (until(sink.frames)) {
        if (timer) clearTimeout(timer);
        resolve();
      }
    };
    manager.on('frame', (frame) => {
      sink.frames.push(frame as RuntimeEventFrame);
      check();
    });
    manager.on('decode-error', (info) => sink.errors.push(info));
    manager.on('oversized-line', (info) => sink.oversized.push(info.count));
    manager.on('stderr', (text) => {
      sink.stderrText += text;
    });
    manager.on('exit', (info) => {
      sink.exits.push({ code: info.code, signal: info.signal, expected: info.expected });
    });
  });
  void timer;
  return sink;
}

/** True when `pid` no longer refers to a live process. */
export function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export async function waitForPidGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isPidGone(pid)) return true;
    await sleep(25);
  }
  return isPidGone(pid);
}
