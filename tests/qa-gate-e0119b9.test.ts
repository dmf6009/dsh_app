/**
 * Independent QA gate regression (QA工程师, DSHA-5 @ e0119b9).
 *
 * NOT part of the developer suite. Written to independently verify the
 * review director's QA focus list:
 *   1. auto-ALLOW first-delivery failure → escalated renderer-visible pending;
 *      manual answer after recovery yields EXACTLY ONE resolved event.
 *   2. respond_failed notice AND modal prompt simultaneously visible for the
 *      same approvalId (failure must be user-visible).
 *   3. escalated pending + runtime persistently unreachable → timeout closes
 *      safely: no residual pending, no fabricated resolved, no grant write.
 *   4. RuntimeClient restart lifecycle re-derived independently:
 *      replacement-child exit-before-ready keeps crash semantics and stays
 *      retryable; restart-from-ready never flashes `crashed`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalRequestPayload } from '../src/shared/approval-protocol';
import type { ApprovalOutcome } from '../src/shared/approval-protocol';
import type { ApprovalRequiredEventFrame } from '../src/shared/protocol/types';
import { ApprovalService } from '../src/main/approval/approval-service';
import type {
  ApprovalServiceEvent,
  PendingRequest
} from '../src/main/approval/approval-service';
import type { DshProcessManager } from '../src/main/runtime/dsh-process-manager';
import type { RuntimeCrashInfo } from '../src/main/runtime/runtime-client';
import { RuntimeClient } from '../src/main/runtime/runtime-client';
import { makeStubManager } from './helpers';

function qaFrame(over: Partial<ApprovalRequiredEventFrame> = {}): ApprovalRequiredEventFrame {
  return {
    v: 1,
    type: 'approval_required',
    run_id: 'run-qa',
    approval_id: 'apr-qa',
    tool: 'shell',
    command: 'npm test',
    risk_level: 'L1',
    ...over
  } as ApprovalRequiredEventFrame;

}

interface QaCtx {
  service: ApprovalService;
  calls: Array<{ approvalId: string; decision: string; scope: string }>;
  pushed: ApprovalRequestPayload[];
  resolved: Array<{ approvalId: string; outcome: ApprovalOutcome; viaModal: boolean }>;
  notices: Array<{ kind: string; [k: string]: unknown }>;
  setHealthy: (v: boolean) => void;
}

/** QA harness: delivery starts BROKEN (healthy=false) and can be flipped. */
function makeQaService(
  over: Partial<ConstructorParameters<typeof ApprovalService>[0]> = {}
): QaCtx {
  const calls: QaCtx['calls'] = [];
  const pushed: ApprovalRequestPayload[] = [];
  const resolved: QaCtx['resolved'] = [];
  const notices: QaCtx['notices'] = [];
  let healthy = false;
  const service = new ApprovalService({
    respond: (input) => {
      calls.push(input);
      return healthy;
    },
    getMode: () => 'full_auto',
    notifyRenderer: (payload) => pushed.push(payload),
    ...over
  });
  service.on('resolved', (r) => resolved.push(r));
  service.on('notice', (n) => notices.push(n));
  return { service, calls, pushed, resolved, notices, setHealthy: (v) => { healthy = v; } };
}

describe('QA gate — approval failure closure (auto-allow path)', () => {
  it('auto-allow first delivery fails → escalated pending + notice both visible; recovery answer yields exactly ONE resolved', async () => {
    const ctx = makeQaService();
    const outcomePromise = ctx.service.handleApprovalRequired(qaFrame({ approval_id: 'q1' }));
    await Promise.resolve();

    // Failure is user-visible: respond_failed notice AND a real modal payload
    // pushed for the SAME approvalId (notice 与 modal 同时可见).
    expect(ctx.notices).toContainEqual(
      expect.objectContaining({ kind: 'respond_failed', approvalId: 'q1', reason: 'runtime_unreachable' })
    );
    expect(ctx.service.pendingCount).toBe(1);
    const escalated: PendingRequest['payload'] = ctx.service.listPending()[0]!;
    expect(escalated.approvalId).toBe('q1');
    expect(ctx.pushed.map((p) => p.approvalId)).toContain('q1');
    expect(escalated.reasons.join('\n')).toContain('自动允许');
    expect(escalated.reasons.join('\n')).toContain('未能送达运行时');

    // Nothing was fabricated: no resolved event, no second delivery attempt yet.
    expect(ctx.resolved).toEqual([]);
    expect(ctx.calls).toEqual([{ approvalId: 'q1', decision: 'allow', scope: 'auto' }]);

    // Runtime recovers → the user's one manual answer closes the loop and
    // produces EXACTLY ONE resolved (viaModal=true), not two.
    ctx.setHealthy(true);
    expect(
      ctx.service.resolveRequest(escalated.requestId, { decision: 'allow', scope: 'once' })
    ).toBe(true);
    await expect(outcomePromise).resolves.toBe('allowed');
    expect(ctx.resolved).toEqual([{ approvalId: 'q1', outcome: 'allowed', viaModal: true }]);
    expect(ctx.service.pendingCount).toBe(0);
    expect(ctx.calls).toEqual([
      { approvalId: 'q1', decision: 'allow', scope: 'auto' }, // failed auto attempt
      { approvalId: 'q1', decision: 'allow', scope: 'once' } // manual answer delivered
    ]);
  });

  it('runtime persistently unreachable: escalated pending times out safely — no residual pending, no fabricated resolved', async () => {
    vi.useFakeTimers();
    try {
      const ctx = makeQaService({ timeoutMs: 800 });
      const outcomePromise = ctx.service.handleApprovalRequired(qaFrame({ approval_id: 'q2' }));
      await vi.advanceTimersByTimeAsync(1200);

      // Timeout safe-reject stands even though the rejection itself cannot be
      // delivered; the entry must be dropped (no zombie pending).
      await expect(outcomePromise).resolves.toBe('rejected');
      expect(ctx.service.pendingCount).toBe(0);
      expect(ctx.resolved).toEqual([]);
      // The failed auto-attempt plus the timeout's safe-reject ATTEMPT (which
      // also failed to deliver — recorded, never faked as sent).
      expect(ctx.calls).toEqual([
        { approvalId: 'q2', decision: 'allow', scope: 'auto' },
        { approvalId: 'q2', decision: 'reject', scope: 'once' }
      ]);
      // Initial escalation notice + timeout drop notice.
      const failNotices = ctx.notices.filter((n) => n.kind === 'respond_failed');
      expect(failNotices.length).toBeGreaterThanOrEqual(2);

      // No grant was cached during the failures: once healthy again, the same
      // operation goes through the ordinary matrix path (auto-allow succeeds),
      // proving no phantom session-grant replay happened.
      ctx.setHealthy(true);
      const replay = await ctx.service.handleApprovalRequired(qaFrame({ approval_id: 'q3' }));
      expect(replay).toBe('auto_allowed');
      expect(ctx.calls.at(-1)).toEqual({ approvalId: 'q3', decision: 'allow', scope: 'auto' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QA gate — RuntimeClient restart lifecycle (independent)', () => {
  const clients: Array<{ dispose: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.dispose()));
  });

  async function until(predicate: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('restart() with replacement child exiting before ready keeps crash semantics and stays retryable', async () => {
    const manager: DshProcessManager = makeStubManager({ env: { STUB_EXIT_BEFORE_READY: '1' } });
    const client = new RuntimeClient(manager, { readyTimeoutMs: 8_000 });
    clients.push({ dispose: async () => { await manager.stop().catch(() => undefined); } });
    const states: string[] = [];
    client.on('connection-state', (s) => states.push(s));

    await expect(client.start()).rejects.toThrow(/exited before becoming ready/);
    expect(client.state).toBe('crashed');

    // Replacement child really exits → genuine crash, snapshot preserved.
    await expect(client.restart()).rejects.toThrow(/exited before becoming ready/);
    await until(() => client.state === 'crashed', 8_000, 'restart lands in crashed');
    expect(client.lastStartupError).toMatch(/exited before becoming ready/);
    const crash: RuntimeCrashInfo | null = client.lastCrash;
    expect(crash).not.toBeNull();
    expect(crash?.code).toBe(7);

    // Third attempt can still be initiated — no wedge, no stopped downgrade.
    await expect(client.restart()).rejects.toThrow(/exited before becoming ready/);
    await until(() => client.state === 'crashed', 8_000, 'third attempt lands in crashed');
    expect(states.filter((s) => s === 'starting')).toHaveLength(3);
    expect(states).not.toContain('stopped');
  }, 30_000);

  it('restart() from ready returns straight to ready without a crashed flash', async () => {
    const manager = makeStubManager();
    const client = new RuntimeClient(manager);
    clients.push({ dispose: async () => { await client.stop().catch(() => undefined); } });

    await client.start();
    expect(client.state).toBe('ready');
    const states: string[] = [];
    client.on('connection-state', (s) => states.push(s));

    await client.restart();
    expect(client.state).toBe('ready');
    expect(states).not.toContain('crashed');
    expect(client.lastStartupError).toBeNull();
  }, 20_000);
});

type _ApprovalServiceEventListener = (e: ApprovalServiceEvent) => void;
