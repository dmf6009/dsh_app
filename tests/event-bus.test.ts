/**
 * Runtime Event Bus tests (DSHA-5, AC-08): ordered delivery with strictly
 * increasing sequence numbers, event-id / terminal / idempotent-type
 * de-duplication, and listener isolation under malformed or throwing
 * consumers.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  RuntimeEventBus,
  dedupeKeyOf,
  type BusMessage,
  type ProtocolViolationInfo
} from '../src/main/runtime/event-bus';
import type { RuntimeEventFrame } from '../src/shared/protocol/types';

interface FakeSource {
  emitEvent: (frame: RuntimeEventFrame) => void;
  emitViolation: (info: ProtocolViolationInfo) => void;
}

function makeSource(): { source: FakeSource; clientLike: FakeClient } {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const clientLike = {
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      handlers.set(event, listener);
      return this;
    }
  };
  return {
    source: {
      emitEvent: (frame) => handlers.get('event')!(frame),
      emitViolation: (info) => handlers.get('protocol-violation')!(info)
    },
    clientLike: clientLike as unknown as FakeClient
  };
}

type FakeClient = ConstructorParameters<typeof RuntimeEventBus>[0];

function frame(partial: Partial<RuntimeEventFrame> & { type: string }): RuntimeEventFrame {
  return { v: 1, ...partial } as unknown as RuntimeEventFrame;
}

describe('RuntimeEventBus — ordering', () => {
  it('delivers messages in arrival order with strictly increasing seq', () => {
    const { source, clientLike } = makeSource();
    const bus = new RuntimeEventBus(clientLike);
    const seen: BusMessage[] = [];
    bus.subscribe((m) => seen.push(m));

    source.emitEvent(frame({ type: 'run_started', run_id: 'r1' }));
    source.emitEvent(frame({ type: 'message_delta', run_id: 'r1', content: 'a' }));
    source.emitEvent(frame({ type: 'message_delta', run_id: 'r1', content: 'b' }));

    expect(seen.map((m) => (m.kind === 'event' ? m.frame.type : 'violation'))).toEqual([
      'run_started',
      'message_delta',
      'message_delta'
    ]);
    const seqs = seen.map((m) => (m.kind === 'event' ? m.seq : -1));
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('keeps dispatching to healthy listeners when one throws', () => {
    const { source, clientLike } = makeSource();
    const bus = new RuntimeEventBus(clientLike);
    const errors: unknown[] = [];
    bus.on('handler-error', (err) => errors.push(err));

    const good: string[] = [];
    bus.subscribe(() => {
      throw new Error('bad consumer');
    });
    bus.subscribe((m) => {
      if (m.kind === 'event') good.push(m.frame.type);
    });

    source.emitEvent(frame({ type: 'ready' }));
    source.emitEvent(frame({ type: 'session_created', session_id: 's' }));

    expect(good).toEqual(['ready', 'session_created']);
    expect(errors).toHaveLength(2);
    expect(bus.currentStats.dispatched).toBe(2);
  });
});

describe('RuntimeEventBus — de-duplication', () => {
  it('drops repeats carrying the same event_id but keeps distinct ids', () => {
    const { source, clientLike } = makeSource();
    const bus = new RuntimeEventBus(clientLike);
    const types: string[] = [];
    bus.subscribe((m) => {
      if (m.kind === 'event') types.push(m.frame.type);
    });

    source.emitEvent(frame({ type: 'tool_started', run_id: 'r', event_id: 'e-1' }));
    source.emitEvent(frame({ type: 'tool_started', run_id: 'r', event_id: 'e-1' }));
    source.emitEvent(frame({ type: 'tool_started', run_id: 'r', event_id: 'e-2' }));

    expect(types).toEqual(['tool_started', 'tool_started']);
    expect(bus.currentStats.duplicatesDropped).toBe(1);
  });

  it('enforces exactly one terminal per run across aliases', () => {
    const { source, clientLike } = makeSource();
    const bus = new RuntimeEventBus(clientLike);
    const terminals: string[] = [];
    bus.subscribe((m) => {
      if (m.kind === 'event' && ['done', 'run_completed', 'run_cancelled'].includes(m.frame.type)) {
        terminals.push(m.frame.type);
      }
    });

    source.emitEvent(frame({ type: 'done', run_id: 'r1' }));
    source.emitEvent(frame({ type: 'done', run_id: 'r1' })); // duplicate terminal
    source.emitEvent(frame({ type: 'run_completed', run_id: 'r1' })); // alias repeat
    source.emitEvent(frame({ type: 'done', run_id: 'r2' })); // different run passes

    expect(terminals).toEqual(['done', 'done']);
    expect(bus.currentStats.duplicatesDropped).toBe(2);
  });

  it('collapses byte-identical idempotent frames but never streaming payloads', () => {
    const { source, clientLike } = makeSource();
    const bus = new RuntimeEventBus(clientLike);
    let readySeen = 0;
    let deltaSeen = 0;
    bus.subscribe((m) => {
      if (m.kind !== 'event') return;
      if (m.frame.type === 'ready') readySeen += 1;
      if (m.frame.type === 'message_delta') deltaSeen += 1;
    });

    source.emitEvent(frame({ type: 'ready', profile: 'desktop-stub' }));
    source.emitEvent(frame({ type: 'ready', profile: 'desktop-stub' })); // identical → dup
    source.emitEvent(
      frame({ type: 'message_delta', run_id: 'r', content: 'same' })
    );
    source.emitEvent(
      frame({ type: 'message_delta', run_id: 'r', content: 'same' })
    ); // legitimate retransmission of streamed text

    expect(readySeen).toBe(1);
    expect(deltaSeen).toBe(2);
  });

  it('dedupes approval_required by approval_id', () => {
    const { source, clientLike } = makeSource();
    const bus = new RuntimeEventBus(clientLike);
    let prompts = 0;
    bus.subscribe((m) => {
      if (m.kind === 'event' && m.frame.type === 'approval_required') prompts += 1;
    });

    source.emitEvent(
      frame({
        type: 'approval_required',
        run_id: 'r',
        approval_id: 'apr-1',
        tool: 'shell',
        command: 'rm -rf build/'
      })
    );
    source.emitEvent(
      frame({
        type: 'approval_required',
        run_id: 'r',
        approval_id: 'apr-1',
        tool: 'shell',
        command: 'rm -rf build/'
      })
    );

    expect(prompts).toBe(1);
  });

  it('exposes stable dedupe keys for keyable frames and null for streams', () => {
    expect(dedupeKeyOf(frame({ type: 'tool_output', run_id: 'r', event_id: 'x' }))).toBe('eid:x');
    expect(dedupeKeyOf(frame({ type: 'ready', profile: 'p' }))).toMatch(/^raw:/);
    expect(dedupeKeyOf(frame({ type: 'message_delta', run_id: 'r', content: 'x' }))).toBeNull();
  });
});

describe('RuntimeEventBus — violations & stats', () => {
  it('routes protocol violations through the same ordered channel', () => {
    const { source, clientLike } = makeSource();
    const bus = new RuntimeEventBus(clientLike);
    const kinds: string[] = [];
    bus.subscribe((m) => kinds.push(m.kind));

    source.emitEvent(frame({ type: 'ready' }));
    source.emitViolation({ reason: 'json_parse_error', detail: 'boom' });

    expect(kinds).toEqual(['event', 'violation']);
    expect(bus.currentStats.violations).toBe(1);
  });

  it('counts received vs dispatched including dropped duplicates', () => {
    const { source, clientLike } = makeSource();
    const bus = new RuntimeEventBus(clientLike);
    bus.subscribe(() => undefined);

    source.emitEvent(frame({ type: 'run_started', run_id: 'r' }));
    source.emitEvent(frame({ type: 'run_started', run_id: 'r' }));

    const stats = bus.currentStats;
    expect(stats.received).toBe(2);
    expect(stats.dispatched).toBe(1);
    expect(stats.duplicatesDropped).toBe(1);
  });

  it('supports unsubscribe', () => {
    const { source, clientLike } = makeSource();
    const bus = new RuntimeEventBus(clientLike);
    const spy = vi.fn();
    const off = bus.subscribe(spy);
    source.emitEvent(frame({ type: 'ready' }));
    off();
    source.emitEvent(frame({ type: 'session_created', session_id: 's' }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bus.subscriberCount).toBe(0);
  });
});
