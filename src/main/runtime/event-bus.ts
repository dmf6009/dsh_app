/**
 * Runtime Event Bus — ordered, de-duplicated dispatch over the runtime's
 * event stream (issue DSHA-5, AC-08).
 *
 * Guarantees:
 * - Ordering: every accepted frame gets a strictly increasing sequence number
 *   and listeners observe messages in arrival order (the transport is a FIFO
 *   pipe, so this reproduces the runtime's emission order).
 * - De-duplication:
 *     · explicit `event_id`      → repeated deliveries of the same logical
 *                                  event are dropped (bounded LRU);
 *     · terminal frames          → exactly one terminal per run is forwarded
 *                                  (P0-6); further ones count as duplicates;
 *     · idempotent frame types   → byte-identical `ready` / `session_created`
 *                                  / `run_started` / `approval_required`(same
 *                                  approval_id) repeats are collapsed.
 *   Streaming frames (`message_delta`, `tool_output`) are never payload-
 *   deduplicated — repeated content there can be legitimate.
 * - Isolation: a throwing listener or malformed frame never breaks the bus;
 *   failures surface as `handler-error` diagnostics and violation messages.
 */

import { EventEmitter } from 'node:events';

import type { RuntimeEventFrame } from '../../shared/protocol/types';
import { isTerminalEventType } from '../../shared/protocol/types';

export interface ProtocolViolationInfo {
  reason: string;
  detail?: string;
  preview?: string;
}

export type BusMessage =
  | { kind: 'event'; seq: number; frame: RuntimeEventFrame }
  | { kind: 'violation'; info: ProtocolViolationInfo };

export type BusListener = (message: BusMessage) => void;

export interface EventBusOptions {
  /** Capacity of the event-id LRU used for de-duplication. */
  dedupCapacity?: number;
}

export interface EventBusStats {
  received: number;
  dispatched: number;
  duplicatesDropped: number;
  violations: number;
}

/** Frame types whose byte-identical repeats carry no new information. */
const IDEMPOTENT_FRAME_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'session_created',
  'run_started'
]);

const DEFAULT_DEDUP_CAPACITY = 4096;

export declare interface RuntimeEventBus {
  on(event: 'handler-error', listener: (err: unknown) => void): this;
  off(event: 'handler-error', listener: (err: unknown) => void): this;
  emit(event: 'handler-error', err: unknown): boolean;
}

export class RuntimeEventBus extends EventEmitter {
  private readonly busListeners = new Set<BusListener>();
  private readonly seenKeys: Map<string, boolean>;
  private readonly capacity: number;
  private readonly terminatedRuns = new Set<string>();
  private seq = 0;
  private stats: EventBusStats = {
    received: 0,
    dispatched: 0,
    duplicatesDropped: 0,
    violations: 0
  };

  constructor(
    source: {
      on(
        event: 'event',
        listener: (frame: RuntimeEventFrame) => void
      ): unknown;
      on(
        event: 'protocol-violation',
        listener: (info: ProtocolViolationInfo) => void
      ): unknown;
    },
    options: EventBusOptions = {}
  ) {
    super();
    this.seenKeys = new Map();
    this.capacity = Math.max(1, options.dedupCapacity ?? DEFAULT_DEDUP_CAPACITY);

    source.on('event', (frame) => this.accept(frame));
    source.on('protocol-violation', (info) => {
      this.stats.violations += 1;
      // Malformed input stays isolated: it becomes data on the same ordered
      // channel instead of an exception path.
      this.dispatch({ kind: 'violation', info });
    });
  }

  get currentStats(): EventBusStats {
    return { ...this.stats };
  }

  get subscriberCount(): number {
    return this.busListeners.size;
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: BusListener): () => void {
    this.busListeners.add(listener);
    return () => {
      this.busListeners.delete(listener);
    };
  }

  /** Feed one frame directly (used by tests and by the wiring layer). */
  accept(rawFrame: unknown): void {
    this.stats.received += 1;
    const frame = rawFrame as RuntimeEventFrame;
    if (this.isDuplicate(frame)) {
      this.stats.duplicatesDropped += 1;
      return;
    }
    this.rememberTermination(frame);
    this.dispatch({ kind: 'event', seq: ++this.seq, frame });
  }

  /* ---------------------------------------------------------------- */

  private dispatch(message: BusMessage): void {
    this.stats.dispatched += 1;
    for (const listener of this.busListeners) {
      try {
        listener(message);
      } catch (err) {
        // One bad consumer must not starve the others or kill the pump.
        this.emit('handler-error', err);
      }
    }
  }

  /** True when this frame is a repeat of an already-delivered logical event. */
  private isDuplicate(frame: RuntimeEventFrame): boolean {
    // Terminal frames: exactly one per run (or globally when untagged), so a
    // second terminal for the same run is a duplicate no matter how tagged.
    if (isTerminalEventType(frame.type)) {
      const runKey = typeof frame.run_id === 'string' ? frame.run_id : '_';
      if (this.terminatedRuns.has(runKey)) return true;
    }
    const key = dedupeKeyOf(frame);
    if (key === null) return false;
    if (this.seenKeys.has(key)) {
      // Refresh recency (LRU behaviour).
      this.seenKeys.delete(key);
      this.seenKeys.set(key, true);
      return true;
    }
    this.remember(key);
    return false;
  }

  private rememberTermination(frame: RuntimeEventFrame): void {
    if (!isTerminalEventType(frame.type)) return;
    const runKey = typeof frame.run_id === 'string' ? frame.run_id : '_';
    this.terminatedRuns.add(runKey);
    if (this.terminatedRuns.size > this.capacity) {
      // Bound the set: clear the oldest entry (insertion order).
      const first = this.terminatedRuns.values().next().value;
      if (first !== undefined) this.terminatedRuns.delete(first);
    }
  }

  private remember(key: string): void {
    this.seenKeys.set(key, true);
    while (this.seenKeys.size > this.capacity) {
      const oldest = this.seenKeys.keys().next().value;
      if (oldest === undefined) break;
      this.seenKeys.delete(oldest);
    }
  }
}

/**
 * Stable de-duplication key for a frame, or null when the frame must always
 * pass through (streaming payloads without an explicit event id).
 */
export function dedupeKeyOf(frame: RuntimeEventFrame): string | null {
  if (typeof frame.event_id === 'string' && frame.event_id.length > 0) {
    return `eid:${frame.event_id}`;
  }
  if (frame.type === 'approval_required') {
    const approvalId = (frame as { approval_id?: unknown }).approval_id;
    if (typeof approvalId === 'string' && approvalId.length > 0) {
      return `approval:${approvalId}`;
    }
  }
  if (IDEMPOTENT_FRAME_TYPES.has(frame.type)) {
    return `raw:${JSON.stringify(frame)}`;
  }
  return null;
}
