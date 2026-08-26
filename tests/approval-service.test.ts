/**
 * Approval service tests (DSHA-5): grant short-circuit, matrix-driven
 * auto-allow / auto-deny, modal round trip with scope semantics, timeout
 * auto-reject, and boundary-service integration.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestPayload } from '../src/shared/approval-protocol';
import type { ApprovalRequiredEventFrame } from '../src/shared/protocol/types';
import { ApprovalService } from '../src/main/approval/approval-service';

function frame(over: Partial<ApprovalRequiredEventFrame> = {}): ApprovalRequiredEventFrame {
  return {
    v: 1,
    type: 'approval_required',
    run_id: 'run-1',
    approval_id: 'apr-1',
    tool: 'shell',
    command: 'rm -rf build/',
    risk_level: 'L2',
    ...over
  } as ApprovalRequiredEventFrame;
}

interface Harness {
  service: ApprovalService;
  respondCalls: Array<{ approvalId: string; decision: string; scope: string }>;
  pushed: ApprovalRequestPayload[];
  bus: { subscribe: (l: (m: unknown) => void) => () => void; emitToBus: (m: unknown) => void };
}

function makeService(
  over: Partial<ConstructorParameters<typeof ApprovalService>[0]> = {}
): Harness {
  const respondCalls: Harness['respondCalls'] = [];
  const pushed: ApprovalRequestPayload[] = [];
  let listener: ((m: unknown) => void) | null = null;
  const bus = {
    subscribe: (l: (m: unknown) => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    emitToBus: (m: unknown) => listener?.(m)
  };
  const service = new ApprovalService({
    respond: (input) => {
      respondCalls.push(input);
      return true;
    },
    getMode: () => 'ask',
    notifyRenderer: (payload) => pushed.push(payload),
    ...over
  });
  return { service, respondCalls, pushed, bus };
}

describe('ApprovalService — non-modal paths', () => {
  it('auto-allows an L1 command in full_auto without notifying the renderer', async () => {
    const h = makeService({ getMode: () => 'full_auto' });
    const outcome = await h.service.handleApprovalRequired(
      frame({ approval_id: 'a1', tool: 'shell', command: 'npm test', risk_level: 'L1' })
    );
    expect(outcome).toBe('auto_allowed');
    expect(h.respondCalls).toEqual([{ approvalId: 'a1', decision: 'allow', scope: 'auto' }]);
    expect(h.pushed).toHaveLength(0);
  });

  it('auto-denies operations the boundary service cannot verify', async () => {
    const h = makeService({
      checkPaths: async () => ({ needsAuthorization: false, unverifiable: true })
    });
    const notices: unknown[] = [];
    h.service.on('notice', (n) => notices.push(n));
    const outcome = await h.service.handleApprovalRequired(
      frame({ paths: ['link-bomb'] })
    );
    expect(outcome).toBe('auto_denied');
    expect(h.respondCalls[0]).toMatchObject({ decision: 'reject', scope: 'auto' });
    expect(notices).toHaveLength(1);
    expect(h.pushed).toHaveLength(0);
  });

  it('short-circuits identical repeats after a session-scope grant', async () => {
    const h = makeService();
    // First prompt → user answers "Allow" with session scope.
    const firstPromise = h.service.handleApprovalRequired(frame({ approval_id: 'a1' }));
    expect(h.service.pendingCount).toBe(1);
    h.service.resolveRequest([...h.service.listPending()][0].requestId, {
      decision: 'allow',
      scope: 'session'
    });
    await expect(firstPromise).resolves.toBe('allowed');

    // Second identical op never reaches the renderer.
    const second = await h.service.handleApprovalRequired(frame({ approval_id: 'a2' }));
    expect(second).toBe('allowed');
    expect(h.respondCalls).toHaveLength(2);
    expect(h.respondCalls[1]).toEqual({ approvalId: 'a2', decision: 'allow', scope: 'session' });
    expect(h.pushed).toHaveLength(1);
  });

  it('does not leak grants across different commands', async () => {
    const h = makeService();
    const p = h.service.handleApprovalRequired(
      frame({ approval_id: 'a1', command: 'npm run lint', risk_level: 'L1' })
    );
    h.service.resolveRequest([...h.service.listPending()][0].requestId, {
      decision: 'allow',
      scope: 'session'
    });
    await p;

    const second = h.service.handleApprovalRequired(
      frame({ approval_id: 'a2', command: 'rm -rf build/', risk_level: 'L2' })
    );
    // L2 still prompts even though another command was granted.
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[1].command).toBe('rm -rf build/');
    h.service.resolveRequest(h.pushed[1].requestId, { decision: 'reject', scope: 'once' });
    await expect(second).resolves.toBe('rejected');
  });
});

describe('ApprovalService — modal path', () => {
  it('prompts for L2 in every mode and completes on renderer reply', async () => {
    for (const mode of ['ask', 'auto_edit', 'full_auto'] as const) {
      const h = makeService({ getMode: () => mode });
      const outcomePromise = h.service.handleApprovalRequired(
        frame({ approval_id: `apr-${mode}` })
      );
      await Promise.resolve(); // let the handler reach the modal branch

      expect(h.pushed).toHaveLength(1);
      expect(h.pushed[0].level).toBe('L2');
      expect(h.pushed[0].command).toBe('rm -rf build/');
      expect(h.service.pendingCount).toBe(1);

      h.service.resolveRequest(h.pushed[0].requestId, { decision: 'reject', scope: 'once' });
      await expect(outcomePromise).resolves.toBe('rejected');
      expect(h.respondCalls).toEqual([
        { approvalId: `apr-${mode}`, decision: 'reject', scope: 'once' }
      ]);
      expect(h.service.pendingCount).toBe(0);
    }
  });

  it('emits resolved events with viaModal=true and returns false for unknown ids', async () => {
    const h = makeService();
    const resolved: Array<{ outcome: string; viaModal: boolean }> = [];
    h.service.on('resolved', (r) => resolved.push(r));

    const p = h.service.handleApprovalRequired(frame());
    await Promise.resolve();
    expect(h.service.resolveRequest('nope', { decision: 'allow', scope: 'once' })).toBe(false);

    h.service.resolveRequest(h.pushed[0].requestId, { decision: 'allow', scope: 'once' });
    await expect(p).resolves.toBe('allowed');
    expect(resolved).toEqual([{ approvalId: 'apr-1', outcome: 'allowed', viaModal: true }]);
  });

  it('auto-rejects a pending modal after the configured timeout', async () => {
    vi.useFakeTimers();
    try {
      const h = makeService({ timeoutMs: 1000 });
      const p = h.service.handleApprovalRequired(frame());
      await vi.advanceTimersByTimeAsync(1100);
      await expect(p).resolves.toBe('rejected');
      expect(h.respondCalls).toEqual([{ approvalId: 'apr-1', decision: 'reject', scope: 'once' }]);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('attaches to the event bus and reacts only to approval_required frames', async () => {
    const h = makeService();
    h.service.attach(h.bus);

    h.bus.emitToBus({ kind: 'event', frame: { v: 1, type: 'message_delta', content: 'x' } });
    expect(h.service.pendingCount).toBe(0);

    h.bus.emitToBus({ kind: 'event', frame: frame() });
    await new Promise((r) => setImmediate(r));
    expect(h.service.pendingCount).toBe(1);

    // Cleanup path.
    h.service.resolveRequest(h.pushed[0].requestId, { decision: 'reject', scope: 'once' });
    h.bus.emitToBus({ kind: 'violation', info: { reason: 'json_parse_error' } });
    expect(h.service.pendingCount).toBe(0);
    h.service.detach();
  });
});
