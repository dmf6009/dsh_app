/**
 * Cancel e2e (issue DSHA-5, AC-11): real stub process → RuntimeClient →
 * RuntimeEventBus → chat reducer. The UI unlock must be driven by the
 * `run_cancelled` TERMINAL FRAME — never by process exit — and the reducer
 * must end in phase 'idle' with exactly one stop notice.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { DshProcessManager } from '../src/main/runtime/dsh-process-manager';
import { RuntimeClient } from '../src/main/runtime/runtime-client';
import { RuntimeEventBus, type BusMessage } from '../src/main/runtime/event-bus';
import { makeStubManager } from './helpers';
import {
  INITIAL_MODEL,
  reduceChat,
  reduceEvent,
  type ChatModel,
  type SubagentItem,
  type ToolCardItem
} from '../src/renderer/src/chat/model';

const disposables: { dispose: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(disposables.splice(0).map((d) => d.dispose().catch(() => undefined)));
});

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

function wire(bus: RuntimeEventBus, initialText: string): { model: () => ChatModel } {
  let model: ChatModel = reduceChat(INITIAL_MODEL, { type: 'send', text: initialText });
  bus.subscribe((message: BusMessage) => {
    if (message.kind === 'event') model = reduceEvent(model, message.frame);
  });
  return { model: () => model };
}

describe('cancel e2e — process → bus → reducer', () => {
  it('unlock happens on run_cancelled with the resident stub still alive', async () => {
    // Resident mode keeps the child alive after cancel so the test proves
    // the UNLOCK comes from the terminal frame, not from an exit event.
    const manager: DshProcessManager = makeStubManager({
      env: { STUB_RESIDENT_CANCEL: '1' }
    });
    const client = new RuntimeClient(manager);
    const bus = new RuntimeEventBus(client);
    disposables.push({ dispose: async () => { await client.stop().catch(() => undefined); } });

    await client.start();
    const { model } = wire(bus, '长任务');

    void client.run('e2e cancel run', '/tmp/proj');
    await until(
      () => model().items.some((i) => i.kind === 'tool'),
      15_000,
      'first tool card'
    );
    expect(model().phase).toBe('running');

    // User presses Stop → UI enters awaiting_cancel immediately.
    const awaiting = reduceChat(model(), { type: 'cancel-requested' });
    expect(awaiting.phase).toBe('awaiting_cancel');

    // Real cancel through the client (manager.send under the hood).
    expect(client.cancel()).toBe(true);

    // While the terminal frame is in flight the phase must still be
    // awaiting_cancel — unlock ONLY happens when run_cancelled arrives.
    expect(model().phase === 'idle').toBe(false);

    await until(
      () =>
        model().phase === 'idle' &&
        model().items.some((i) => i.kind === 'notice' && i.tone === 'stop'),
      15_000,
      'run_cancelled unlock'
    );

    // Post-conditions (AC-11):
    const cards = model().items.filter((i): i is ToolCardItem => i.kind === 'tool');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.status !== 'running')).toBe(true);   // memo ①
    expect(client.state).toBe('ready');           // resident runtime intact
    expect(manager.currentState).toBe('running');
    expect(client.activeRun).toBeNull();
    expect(model().items.filter((i) => i.kind === 'notice' && i.tone === 'stop')).toHaveLength(1);

    await client.stop();
    expect(client.state).toBe('stopped');
  }, 35_000);

  it('a cancelled sub-agent trio also lands as a marked card/notice pair', async () => {
    const manager: DshProcessManager = makeStubManager({
      env: { STUB_RESIDENT_CANCEL: '1' }
    });
    const client = new RuntimeClient(manager);
    const bus = new RuntimeEventBus(client);
    disposables.push({ dispose: async () => { await client.stop().catch(() => undefined); } });
    await client.start();

    let sawSubagent = false;
    let model: ChatModel = reduceChat(INITIAL_MODEL, { type: 'send', text: '带子任务的运行' });
    bus.subscribe((message: BusMessage) => {
      if (message.kind !== 'event') return;
      model = reduceEvent(model, message.frame);
      if (model.items.some((i) => i.kind === 'subagent')) sawSubagent = true;
    });

    void client.run('cancel with subagents', '/tmp/proj');
    await until(() => sawSubagent, 15_000, 'sub-agent card');

    model = reduceChat(model, { type: 'cancel-requested' });
    expect(client.cancel()).toBe(true);
    await until(() => model.phase === 'idle', 15_000, 'idle after cancel');

    const sub = model.items.find((i): i is SubagentItem => i.kind === 'subagent');
    expect(sub).toBeDefined();
    expect(sub!.status).not.toBe('running'); // memo ① covers non-tool kinds too
    await client.stop();
  }, 35_000);
});
