/**
 * DSH Process Manager unit/integration tests (DSHA-3 测试要求 #2):
 * spawn stub→ready；cancel→run_cancelled 且子进程退出；子进程崩溃→error 且可重启；
 * 结束后无残留进程；SIGTERM 无响应时 SIGKILL 兜底。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ErrorEventFrame } from '../src/shared/protocol/types';
import { DshProcessManager } from '../src/main/runtime/dsh-process-manager';
import { makeCancelCommand, makeRunCommand } from '../src/shared/protocol/types';
import {
  collect,
  isPidGone,
  makeStubManager,
  sleep,
  waitForPidGone
} from './helpers';

const managers: { dispose: () => Promise<void> }[] = [];

function track<T extends { dispose: () => Promise<void> }>(manager: T): T {
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose().catch(() => undefined)));
});

describe('DshProcessManager — spawn → ready', () => {
  it('spawns the stub runtime and surfaces the ready frame', async () => {
    const manager = track(makeStubManager());
    const sink = collect(manager, (frames) => frames.some((f) => f.type === 'ready'));
    await manager.start();
    expect(manager.pid).toBeGreaterThan(0);
    expect(manager.currentState).toBe('running');

    await sink.done;
    const ready = sink.frames.find((f) => f.type === 'ready');
    expect(ready).toMatchObject({ v: 1, type: 'ready', profile: 'desktop-stub' });
    expect(sink.errors).toEqual([]);
  });

  it('rejects a second concurrent start and reports spawn failures as recoverable', async () => {
    const manager = track(makeStubManager());
    await manager.start();
    await expect(manager.start()).rejects.toThrow(/is running/);
    await manager.stop();

    const bad = track(
      makeStubManager({ command: '/definitely/not/an/executable', args: [] })
    );
    const onSpawnError = vi.fn();
    bad.on('spawn-error', onSpawnError);
    await expect(bad.start()).rejects.toThrow();
    expect(onSpawnError).toHaveBeenCalledTimes(1);
    expect(bad.currentState).toBe('idle');
  });
});

describe('DshProcessManager — run / cancel / exit', () => {
  it('delivers run frames end-to-end through stdin/stdout', async () => {
    const manager = track(makeStubManager());
    const sink = collect(manager, (frames) => frames.some((f) => f.type === 'done'));
    await manager.start();

    const ok = manager.send(
      makeRunCommand({
        run_id: 'pm-run-1',
        session_id: 'pm-session',
        workspace: process.cwd(),
        message: 'run the tests'
      })
    );
    expect(ok).toBe(true);

    await sink.done;
    const types = sink.frames.map((f) => f.type);
    expect(types.indexOf('run_started')).toBeGreaterThan(types.indexOf('ready'));
    expect(types).toContain('message_delta');
    expect(types).toContain('tool_started');
    expect(types).toContain('done');
    // Every inbound frame echoes the protocol version.
    for (const frame of sink.frames) expect(frame.v).toBe(1);
  });

  it('forwards cancel; stub replies run_cancelled and exits by itself', async () => {
    const manager = track(makeStubManager());
    let cancelSent = false;
    const sink = collect(
      manager,
      (frames) =>
        frames.some((f) => f.type === 'run_cancelled') &&
        frames.findIndex((f) => f.type === 'run_cancelled') >
          frames.findIndex(() => cancelSent),
      15_000
    );
    await manager.start();
    const pid = manager.pid!;
    manager.send(
      makeRunCommand({
        run_id: 'pm-run-cancel',
        session_id: 'pm-session',
        workspace: process.cwd(),
        message: 'start then cancel'
      })
    );

    // Cancel as soon as streaming begins.
    const stopWatching = setInterval(() => {
      if (sink.frames.some((f) => f.type === 'message_delta')) {
        cancelSent = true;
        manager.send(makeCancelCommand('pm-run-cancel'));
        clearInterval(stopWatching);
      }
    }, 5);

    await sink.done;
    expect(sink.frames.at(-1)?.type).toBe('run_cancelled');
    // The stub exits on its own after cancelling (deliverable #4 contract).
    await expect(waitForPidGone(pid)).resolves.toBe(true);
    const exit = sink.exits.at(-1);
    expect(exit?.code).toBe(0);
    expect(exit?.expected).toBe(false); // self-exit, not manager-initiated
    clearInterval(stopWatching);
  });

  it('stop() terminates the child gracefully and leaves no residual process', async () => {
    const manager = track(makeStubManager());
    const sink = collect(manager, (frames) => frames.some((f) => f.type === 'ready'));
    await manager.start();
    await sink.done;
    const pid = manager.pid!;

    const exitInfo = await manager.stop();
    expect(exitInfo.expected).toBe(true);
    expect(manager.currentState).toBe('idle');
    await expect(waitForPidGone(pid)).resolves.toBe(true);
    expect(isPidGone(pid)).toBe(true);
  }, 20_000);

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const manager = track(
      new DshProcessManager({
        command: process.execPath,
        args: ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`],
        killGraceMs: 150
      })
    );

    await manager.start();
    const pid = manager.pid!;
    // Give the child time to install its SIGTERM handler before stopping —
    // a signal arriving during interpreter boot takes the default action.
    await sleep(600);
    const startedAt = Date.now();
    const info = await manager.stop();
    const elapsed = Date.now() - startedAt;

    expect(info.expected).toBe(true);
    expect(info.signal).toBe('SIGKILL');
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(isPidGone(pid)).toBe(true);
  }, 20_000);
});

describe('DshProcessManager — crash handling & restart', () => {
  it('surfaces abnormal exit as a synthesized protocol error frame', async () => {
    const crasher = track(makeStubManager({ args: ['-e', 'process.exit(3)'] }));
    const sink = collect(crasher, (frames) => frames.some((f) => f.type === 'error'));
    await crasher.start();

    await sink.done;
    const errorFrame = sink.frames.find((f) => f.type === 'error') as ErrorEventFrame;
    expect(errorFrame.code).toBe('process_exited_unexpectedly');
    expect(errorFrame.recoverable).toBe(true);
    expect(errorFrame.message).toContain('code=3');
    expect(crasher.currentState).toBe('exited');
    const exit = sink.exits.at(-1);
    expect(exit).toMatchObject({ code: 3, expected: false });
  });

  it('does NOT synthesize an error frame on clean self-exit (code 0)', async () => {
    const quitter = track(makeStubManager({ args: ['-e', 'process.exit(0)'] }));
    const sink = collect(quitter, (_frames) => false, 10_000);
    await quitter.start();
    await vi.waitFor(
      () => {
        if (quitter.currentState !== 'exited') throw new Error('still running');
      },
      { timeout: 8000 }
    );
    await sleep(50);
    expect(sink.frames.filter((f) => f.type === 'error')).toEqual([]);
  });

  it('can be restarted after a crash and serves a fresh ready frame', async () => {
    const manager = track(makeStubManager());
    const firstSink = collect(manager, (frames) => frames.some((f) => f.type === 'ready'));
    await manager.start();
    const firstPid = manager.pid!;
    await firstSink.done;

    // Simulate an external kill (crash).
    process.kill(firstPid, 'SIGKILL');
    await vi.waitFor(
      () => {
        if (manager.currentState !== 'exited') throw new Error(`state=${manager.currentState}`);
      },
      { timeout: 8000 }
    );

    await manager.start(); // restart path after crash
    const secondPid = manager.pid!;
    expect(secondPid).not.toBe(firstPid);
    expect(manager.currentState).toBe('running');

    const restartSink = collect(manager, (frames) => frames.length >= 1 && frames.some((f) => f.type === 'ready'));
    // The fresh child emits its own ready.
    await expect(waitForPidGone(firstPid)).resolves.toBe(true);
    await restartSink.done;
    const lastReady = [...restartSink.frames].reverse().find((f) => f.type === 'ready');
    expect(lastReady).toBeDefined();

    await manager.stop();
  }, 25_000);

  it('restart() replaces a live child with a new one (no zombie left)', async () => {
    const manager = track(makeStubManager());
    const first = collect(manager, (frames) => frames.some((f) => f.type === 'ready'));
    await manager.start();
    const oldPid = manager.pid!;
    await first.done;

    await manager.restart();
    const newPid = manager.pid!;
    expect(newPid).toBeTruthy();
    expect(newPid).not.toBe(oldPid);
    await expect(waitForPidGone(oldPid)).resolves.toBe(true);

    const second = collect(manager, (frames) => frames.some((f) => f.type === 'done'));
    manager.send(
      makeRunCommand({
        run_id: 'after-restart',
        session_id: 's',
        workspace: process.cwd(),
        message: 'hello again'
      })
    );
    await second.done; // proves the new child is fully functional
  }, 30_000);
});

describe('DshProcessManager — decode diagnostics pass-through', () => {
  // Memo ③: a REAL child writes undecodable bytes followed by a valid frame;
  // the manager must surface both diagnostics and keep decoding the stream.
  it('reports decode errors from real garbage stdout without dying', async () => {
    const manager = track(makeStubManager({ env: { STUB_GARBAGE_STDOUT: '1' } }));
    const sink = collect(manager, (frames) => frames.some((f) => f.type === 'ready'));
    await manager.start();
    await sink.done; // the valid ready frame decoded despite the garbage

    // Diagnostics for BOTH malformed chunks surfaced with previews.
    await vi.waitFor(
      () => {
        if (sink.errors.length < 2) throw new Error(`errors=${JSON.stringify(sink.errors)}`);
      },
      { timeout: 8000 }
    );
    expect(sink.errors.map((e) => e.preview ?? '')).toEqual([
      expect.stringContaining('this is not json'),
      expect.stringContaining('"type": "run_')
    ]);
    for (const err of sink.errors) {
      expect(err.reason).toMatch(/json|decode|parse/i);
    }

    // The valid ready frame after the garbage still decoded.
    const readyFrame = sink.frames.find((f) => f.type === 'ready');
    expect(readyFrame).toMatchObject({ profile: 'desktop-stub' });

    // The manager survived: it still accepts and completes a run.
    const runSink = collect(manager, (frames) => frames.some((f) => f.type === 'done'));
    expect(manager.send(makeRunCommand({
      run_id: 'after-garbage',
      session_id: 'pm-session',
      workspace: process.cwd(),
      message: 'still alive'
    }))).toBe(true);
    await runSink.done;

    await manager.stop();
    expect(sink.exits.every((e) => e.expected)).toBe(true);
  }, 30_000);
});
