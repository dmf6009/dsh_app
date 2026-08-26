/**
 * Runtime Client integration tests (DSHA-3 测试要求 #4):
 * full Desktop-side closed loop over the real stub process — start→ready,
 * run→terminal with run-id bookkeeping, cancel, crash recovery, restart.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { DshProcessManager } from '../src/main/runtime/dsh-process-manager';
import { RuntimeClient } from '../src/main/runtime/runtime-client';
import { makeStubManager } from './helpers';
import type { RuntimeEventFrame } from '../src/shared/protocol/types';

const clients: { dispose: () => Promise<void> }[] = [];

function makeClient(): { client: RuntimeClient; manager: DshProcessManager } {
  const manager = makeStubManager();
  const client = new RuntimeClient(manager);
  clients.push({ dispose: async () => { await client.stop().catch(() => undefined); } });
  return { client, manager };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 15_000,
  message = 'condition'
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${message}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.dispose()));
});

describe('RuntimeClient — lifecycle', () => {
  it('start() resolves on the stub ready frame and flips connection state', async () => {
    const { client } = makeClient();
    const states: string[] = [];
    client.on('connection-state', (s) => states.push(s));

    expect(client.state).toBe('stopped');
    await client.start();
    expect(client.state).toBe('ready');
    expect(states).toEqual(['starting', 'ready']);
    expect(client.runtimeReady).toBe(true);
    expect(client.currentSessionId).toBeTruthy();

    await client.stop();
    expect(client.state).toBe('stopped');
  });

  it('start() rejects with a recoverable state + diagnostics when the command cannot spawn', async () => {
    const manager = makeStubManager({
      command: '/no/such/binary',
      args: []
    });
    const client = new RuntimeClient(manager);
    clients.push({ dispose: async () => { await manager.stop().catch(() => undefined); } });

    await expect(client.start()).rejects.toThrow(/failed to start|ENOENT|spawn/i);
    // Review fix 2: never stuck in `starting`; lands in the clean retryable
    // state with the diagnostic preserved for the startup-failure banner.
    expect(client.state).toBe('stopped');
    expect(client.lastStartupError).toMatch(/failed to start|ENOENT|spawn/i);
    // Retry is not blocked by a stale `starting` guard.
    await expect(client.start()).rejects.toThrow(/failed to start|ENOENT|spawn/i);
    expect(client.state).toBe('stopped');
    // Recovery: pointing at the stub works again from the same client shape.
    // (manager options are immutable; build a fresh one to prove restartability
    // of the flow itself.)
    const recovered = makeClient();
    await recovered.client.start();
    expect(recovered.client.state).toBe('ready');
    expect(recovered.client.lastStartupError).toBeNull();
  }, 20_000);

  // Review fix 2 (生命周期阻断): process alive but NEVER ready — start() must
  // reject on the ready timeout, stop the surviving child, land in a
  // recoverable state and keep diagnostics; retry must be possible.
  it('start() recovers when the process stays alive but never becomes ready', async () => {
    const manager = makeStubManager({ env: { STUB_SILENT: '1' } });
    const client = new RuntimeClient(manager, { readyTimeoutMs: 600 });
    clients.push({ dispose: async () => { await manager.stop().catch(() => undefined); } });

    await expect(client.start()).rejects.toThrow(/did not become ready within 600ms/);
    expect(client.state).toBe('stopped'); // recoverable, NOT stuck in starting
    expect(client.lastStartupError).toMatch(/did not become ready/);
    // The surviving-but-not-ready child was cleaned up.
    await until(() => manager.currentState === 'idle', 5_000, 'silent child reaped');

    // Retry path: a new attempt actually spawns again (not blocked by the
    // old `starting` guard) and fails cleanly the same way.
    await expect(client.start()).rejects.toThrow(/did not become ready within 600ms/);
    expect(client.state).toBe('stopped');
  }, 20_000);

  // Review fix 2: exit BEFORE ready — rejects fast, keeps crash semantics
  // (the child really died) and stays retryable instead of wedging start().
  it('start() is retryable after the runtime exits before becoming ready', async () => {
    const manager = makeStubManager({ env: { STUB_EXIT_BEFORE_READY: '1' } });
    const client = new RuntimeClient(manager, { readyTimeoutMs: 8_000 });
    clients.push({ dispose: async () => { await manager.stop().catch(() => undefined); } });

    await expect(client.start()).rejects.toThrow(/exited before becoming ready/);
    expect(['crashed', 'stopped']).toContain(client.state); // recoverable either way
    expect(client.lastStartupError).toMatch(/exited before becoming ready/);
    await until(
      () => manager.currentState === 'exited' || manager.currentState === 'idle',
      5_000,
      'dead child reaped'
    );

    // Retry attempts a fresh spawn rather than being rejected by lifecycle guards.
    await expect(client.start()).rejects.toThrow(/exited before becoming ready/);
  }, 20_000);
});

describe('RuntimeClient — run / cancel', () => {
  it('run() streams events to completion and clears the active run id', async () => {
    const { client } = makeClient();
    await client.start();

    const events: RuntimeEventFrame[] = [];
    client.on('event', (frame) => events.push(frame));

    const runId = client.run('修复登录接口偶发 500', '/tmp/proj');
    expect(runId).toBeTruthy();
    expect(client.activeRun).toBe(runId);

    await until(
      () => events.some((f) => isTerminal(f)),
      15_000,
      'terminal frame'
    );

    const types = events.map((f) => f.type);
    expect(types[0]).toBe('run_started');
    expect(types).toContain('message_delta');
    expect(types.at(-1)).toMatch(/^(done|run_completed)$/);
    // Terminal frames are stamped with the originating run id even if the
    // runtime omits it.
    const terminal = events.find((f) => isTerminal(f))!;
    expect(terminal.run_id).toBe(runId);
    // Bookkeeping cleared after terminal.
    expect(client.activeRun).toBeNull();
  });

  it('cancel() stops the active run; run_cancelled arrives as a terminal frame', async () => {
    const { client } = makeClient();
    await client.start();

    const events: RuntimeEventFrame[] = [];
    let sawDelta = false;
    client.on('event', (frame) => {
      events.push(frame);
      if (!sawDelta && frame.type === 'message_delta') {
        sawDelta = true;
        expect(client.cancel()).toBe(true); // cancels the active run
      }
    });

    client.run('再跑一次，这次中途取消', '/tmp/proj');
    await until(() => events.some((f) => f.type === 'run_cancelled'), 15_000, 'run_cancelled');

    const cancelledIdx = events.findIndex((f) => f.type === 'run_cancelled');
    expect(cancelledIdx).toBeGreaterThan(0);
    expect(events.slice(cancelledIdx + 1)).toEqual([]); // nothing after terminal
    expect(events[cancelledIdx]!.run_id).toBeTruthy();
    expect(client.activeRun).toBeNull();
  });

  it('cancel() without an active run returns false instead of sending garbage', async () => {
    const { client } = makeClient();
    await client.start();
    expect(client.cancel()).toBe(false);
  });

  it('rejects run() before the runtime exists', () => {
    const { client } = makeClient();
    expect(() => client.run('hello', '/tmp')).toThrow(/runtime is idle/);
  });
});

describe('RuntimeClient — crash & restart semantics', () => {
  it('marks crashed when the runtime dies unexpectedly mid-session', async () => {
    const { client, manager } = makeClient();
    await client.start();
    const states: string[] = [];
    client.on('connection-state', (s) => states.push(s));

    const pid = manager.pid!;
    process.kill(pid, 'SIGKILL');

    await until(() => client.state === 'crashed', 10_000, 'crashed state');
    expect(states).toEqual(['crashed']);
  });

  it('restart() brings the runtime back to ready after a crash', async () => {
    const { client, manager } = makeClient();
    await client.start();
    const firstPid = manager.pid!;

    process.kill(firstPid, 'SIGKILL');
    await until(() => client.state === 'crashed', 10_000, 'crashed');

    await client.restart();
    expect(client.state).toBe('ready');
    expect(manager.pid).not.toBe(firstPid);

    // The restarted runtime serves runs again.
    const events: RuntimeEventFrame[] = [];
    client.on('event', (f) => events.push(f));
    client.run('post-restart run', '/tmp/proj');
    await until(() => events.some(isTerminal), 15_000, 'post-restart terminal');
  }, 25_000);

  it('intentional stop() does NOT flip the connection state to crashed', async () => {
    const { client } = makeClient();
    await client.start();
    const states: string[] = [];
    client.on('connection-state', (s) => states.push(s));

    await client.stop();
    await new Promise((r) => setTimeout(r, 100)); // allow any stray exit event
    expect(client.state).toBe('stopped');
    expect(states.filter((s) => s === 'crashed')).toEqual([]);
  });

  // Phase 0 memo ②: restarting from the READY state replaces the child; the
  // old child's exit must never flash `crashed` before the new one is ready.
  it('restart() from ready goes straight back to ready without a crash flash', async () => {
    const { client, manager } = makeClient();
    await client.start();
    const sessionBefore = client.currentSessionId;
    const states: string[] = [];
    client.on('connection-state', (s) => states.push(s));
    const oldPid = manager.pid!;

    await client.restart();

    expect(manager.pid).not.toBe(oldPid);
    expect(manager.pid).toBeGreaterThan(0);
    await until(() => client.state === 'ready', 10_000, 'ready after restart');
    expect(states.filter((s) => s === 'crashed')).toEqual([]);
    expect(states[states.length - 1]).toBe('ready');
    // Session identity is preserved across restart — only the transport resets.
    expect(client.currentSessionId).toBe(sessionBefore);

    // The replacement child is fully functional.
    const events: RuntimeEventFrame[] = [];
    client.on('event', (f) => events.push(f));
    client.run('after clean restart', '/tmp/proj');
    await until(() => events.some(isTerminal), 15_000, 'post-restart terminal');
  }, 25_000);
});

describe('RuntimeClient — resident cancel (stub stays alive)', () => {
  // Back-compat + AC-11 support: with STUB_RESIDENT_CANCEL=1 the stub keeps
  // running after run_cancelled. The client must resolve cancel() on the
  // TERMINAL FRAME (not on process exit), stay ready and keep the session.
  it('cancel() resolves on run_cancelled while the runtime remains resident', async () => {
    const manager = makeStubManager({ env: { STUB_RESIDENT_CANCEL: '1' } });
    const client = new RuntimeClient(manager);
    clients.push({ dispose: async () => { await client.stop().catch(() => undefined); } });
    await client.start();

    const events: RuntimeEventFrame[] = [];
    client.on('event', (f) => events.push(f));
    void client.run('resident cancel probe', '/tmp/proj');

    await until(
      () => events.some((f) => f.type === 'run_started'),
      15_000,
      'run_started'
    );
    expect(client.cancel()).toBe(true);

    await until(
      () => events.some((f) => f.type === 'run_cancelled'),
      15_000,
      'run_cancelled'
    );
    expect(client.activeRun).toBeNull();

    // Resident: give the stub a moment to exit if it were going to.
    await new Promise((r) => setTimeout(r, 400));
    expect(client.state).toBe('ready');           // not crashed / stopped
    expect(manager.currentState).toBe('running'); // child still alive
    expect(client.currentSessionId).toBeTruthy(); // session preserved

    // The same resident runtime accepts another run afterwards.
    const second: RuntimeEventFrame[] = [];
    client.on('event', (f) => second.push(f));
    void client.run('second run on resident stub', '/tmp/proj');
    await until(() => second.some(isTerminal), 15_000, 'second terminal');
  }, 30_000);
});

describe('RuntimeClient — stderr + protocol violations fan-out', () => {
  it('forwards stderr diagnostics from the child', async () => {
    const { client, manager } = makeClient();
    const chunks: string[] = [];
    client.on('stderr', (t) => chunks.push(t));
    await client.start();
    // The stub only writes diagnostics on protocol violations; provoke one.
    manager.send({ v: 1, type: 'definitely-unsupported' });
    await until(() => chunks.join('').includes('[stub]'), 10_000, 'stderr output');
    expect(chunks.join('')).toContain('[stub]');
  });

  it('emits protocol-violation when the child writes undecodable lines', async () => {
    const noisy = makeStubManager({
      args: ['-e', [
        `console.log('{oops');`,          // malformed JSON line
        `console.log(JSON.stringify({v:1,type:'ready'}));`,
        `setInterval(() => {}, 1000);`
      ].join('\n')]
    });
    const client = new RuntimeClient(noisy);
    clients.push({ dispose: async () => { await client.stop().catch(() => undefined); } });

    const violations: unknown[] = [];
    client.on('protocol-violation', (v) => violations.push(v));

    await client.start(); // resolves on the valid ready line
    await until(() => violations.length >= 1, 10_000, 'protocol violation');
    expect((violations[0] as { reason: string }).reason).toBe('json_parse_error');
  }, 20_000);
});

function isTerminal(frame: RuntimeEventFrame): boolean {
  return ['done', 'run_completed', 'run_cancelled'].includes(frame.type);
}
