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
    h.service.resolveRequest([...h.service.listPending()][0]!.requestId, {
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
    h.service.resolveRequest([...h.service.listPending()][0]!.requestId, {
      decision: 'allow',
      scope: 'session'
    });
    await p;

    const second = h.service.handleApprovalRequired(
      frame({ approval_id: 'a2', command: 'rm -rf build/', risk_level: 'L2' })
    );
    // L2 still prompts even though another command was granted.
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[1]!.command).toBe('rm -rf build/');
    h.service.resolveRequest(h.pushed[1]!.requestId, { decision: 'reject', scope: 'once' });
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
      expect(h.pushed[0]!.level).toBe('L2');
      expect(h.pushed[0]!.command).toBe('rm -rf build/');
      expect(h.service.pendingCount).toBe(1);

      h.service.resolveRequest(h.pushed[0]!.requestId, { decision: 'reject', scope: 'once' });
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

    h.service.resolveRequest(h.pushed[0]!.requestId, { decision: 'allow', scope: 'once' });
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
    h.service.resolveRequest(h.pushed[0]!.requestId, { decision: 'reject', scope: 'once' });
    h.bus.emitToBus({ kind: 'violation', info: { reason: 'json_parse_error' } });
    expect(h.service.pendingCount).toBe(0);
    h.service.detach();
  });
});

describe('ApprovalService — grant binding (review fix 1)', () => {
  const INSIDE_OK = { needsAuthorization: false, unverifiable: false };

  it('does NOT replay a session grant across different paths (同工具同命令、不同路径)', async () => {
    const h = makeService({ checkPaths: async () => INSIDE_OK });
    // Grant a path-bound edit operation.
    const first = h.service.handleApprovalRequired(
      frame({
        approval_id: 'a1',
        tool: 'edit_file',
        command: undefined,
        risk_level: 'L1',
        paths: ['/ws/src/a.txt']
      })
    );
    await Promise.resolve();
    expect(h.pushed).toHaveLength(1);
    h.service.resolveRequest(h.pushed[0]!.requestId, { decision: 'allow', scope: 'session' });
    await expect(first).resolves.toBe('allowed');

    // Same tool, same (absent) command, DIFFERENT path → must prompt again,
    // never silently reuse the earlier grant.
    const second = h.service.handleApprovalRequired(
      frame({
        approval_id: 'a2',
        tool: 'edit_file',
        command: undefined,
        risk_level: 'L1',
        paths: ['/ws/src/b.txt']
      })
    );
    await Promise.resolve();
    expect(h.pushed).toHaveLength(2); // reached the renderer, not short-circuited
    expect(h.service.pendingCount).toBe(1);
    h.service.resolveRequest(h.pushed[1]!.requestId, { decision: 'reject', scope: 'once' });
    await expect(second).resolves.toBe('rejected');
  });

  it('re-evaluates the boundary on every cache hit — 先内后外', async () => {
    const verdicts = [INSIDE_OK, { needsAuthorization: true, unverifiable: false }];
    const h = makeService({
      checkPaths: async () => verdicts.shift() ?? INSIDE_OK
    });
    const mk = (id: string): ApprovalRequiredEventFrame =>
      frame({ approval_id: id, tool: 'shell', command: 'cat notes.md', risk_level: 'L1', paths: ['/ws/notes.md'] });

    const first = h.service.handleApprovalRequired(mk('a1'));
    await Promise.resolve();
    h.service.resolveRequest(h.pushed[0]!.requestId, { decision: 'allow', scope: 'session' });
    await expect(first).resolves.toBe('allowed');

    // IDENTICAL key hits the cache — but the fresh boundary verdict now
    // flags the target as outside the workspace, so the grant must NOT
    // bypass the check: the user is asked again.
    const second = h.service.handleApprovalRequired(mk('a2'));
    await Promise.resolve();
    expect(h.pushed).toHaveLength(2);
    expect(h.pushed[1]!.needsBoundaryAuthorization).toBe(true);
    expect(h.respondCalls.filter((c) => c.scope === 'session')).toHaveLength(1); // only the original
    h.service.resolveRequest(h.pushed[1]!.requestId, { decision: 'allow', scope: 'once' });
    await expect(second).resolves.toBe('allowed');
  });

  it('normalizes equivalent path spellings into one grant key', async () => {
    const h = makeService({ checkPaths: async () => INSIDE_OK });
    const mk = (id: string, p: string): ApprovalRequiredEventFrame =>
      frame({ approval_id: id, tool: 'edit_file', command: undefined, risk_level: 'L1', paths: [p] });

    const first = h.service.handleApprovalRequired(mk('a1', '/ws/src/a.txt'));
    await Promise.resolve();
    h.service.resolveRequest(h.pushed[0]!.requestId, { decision: 'allow', scope: 'session' });
    await expect(first).resolves.toBe('allowed');

    // Trailing slash / duplicate separators denote the SAME file → grant applies.
    const second = await h.service.handleApprovalRequired(mk('a2', '//ws/src/a.txt///'));
    expect(second).toBe('allowed');
    expect(h.pushed).toHaveLength(1); // no second prompt
    expect(h.respondCalls[1]).toEqual({ approvalId: 'a2', decision: 'allow', scope: 'session' });
  });
});

describe('ApprovalService — send-failure semantics (review fix 3)', () => {
  interface Ctx {
    service: ApprovalService;
    calls: Array<{ approvalId: string; decision: string; scope: string }>;
    setHealthy: (v: boolean) => void;
    resolved: Array<{ approvalId: string; outcome: string; viaModal: boolean }>;
    notices: Array<{ kind: string; [k: string]: unknown }>;
  }
  function makeFailingService(over: Partial<ConstructorParameters<typeof ApprovalService>[0]> = {}): Ctx {
    const calls: Ctx['calls'] = [];
    let healthy = false;
    const ctx: Ctx = {
      calls,
      setHealthy: (v) => {
        healthy = v;
      },
      resolved: [],
      notices: [],
      service: null as unknown as ApprovalService
    };
    ctx.service = new ApprovalService({
      respond: (input) => {
        calls.push(input);
        return healthy;
      },
      getMode: () => 'ask',
      notifyRenderer: () => undefined,
      ...over
    });
    ctx.service.on('resolved', (r) => ctx.resolved.push(r));
    ctx.service.on('notice', (n) => ctx.notices.push(n as Ctx['notices'][number]));
    return ctx;
  }

  it('keeps a modal request retryable when the runtime cannot receive the answer', async () => {
    const ctx = makeFailingService();
    const p = ctx.service.handleApprovalRequired(frame({ approval_id: 'a1' }));
    await Promise.resolve();
    const requestId = ctx.service.listPending()[0]!.requestId;

    // Delivery fails: nothing consumed, nothing cached, no success reported.
    expect(ctx.service.resolveRequest(requestId, { decision: 'allow', scope: 'session' })).toBe(false);
    expect(ctx.calls).toEqual([{ approvalId: 'a1', decision: 'allow', scope: 'session' }]);
    expect(ctx.service.pendingCount).toBe(1);
    expect(ctx.resolved).toEqual([]);
    expect(ctx.notices).toContainEqual(
      expect.objectContaining({ kind: 'respond_failed', approvalId: 'a1', reason: 'runtime_unreachable' })
    );

    // Runtime recovers → the SAME request retries successfully and ONLY NOW
    // is the session grant earned.
    ctx.setHealthy(true);
    expect(ctx.service.resolveRequest(requestId, { decision: 'allow', scope: 'session' })).toBe(true);
    await expect(p).resolves.toBe('allowed');
    expect(ctx.resolved).toEqual([{ approvalId: 'a1', outcome: 'allowed', viaModal: true }]);
    const replay = await ctx.service.handleApprovalRequired(frame({ approval_id: 'a2' }));
    expect(replay).toBe('allowed'); // grant valid after confirmed delivery
    expect(ctx.service.pendingCount).toBe(0);
  });

  it('escalates an undeliverable auto-deny to a renderer-visible pending with follow-up', async () => {
    // Second-review fix: the failure closure is a REAL pending prompt —
    // renderer-visible via notifyRenderer, actionable by the user — never a
    // silently recorded auto-resolution.
    const ctx = makeFailingService({
      checkPaths: async () => ({ needsAuthorization: false, unverifiable: true })
    });
    const outcomePromise = ctx.service.handleApprovalRequired(frame({ approval_id: 'a9', paths: ['link-bomb'] }));
    await Promise.resolve();

    // Renderer-visible failure with follow-up action:
    expect(ctx.notices).toContainEqual(
      expect.objectContaining({ kind: 'respond_failed', reason: 'runtime_unreachable' })
    );
    expect(ctx.service.pendingCount).toBe(1);
    const escalated = [...ctx.service.listPending()][0]!;
    expect(escalated.approvalId).toBe('a9');
    expect(escalated.reasons[0]).toContain('未能送达运行时');
    expect(ctx.resolved).toEqual([]); // NOT recorded as auto-resolved

    // Runtime recovers → the user's manual answer closes the loop through
    // the ordinary pipeline.
    ctx.setHealthy(true);
    ctx.service.resolveRequest(escalated.requestId, { decision: 'allow', scope: 'once' });
    await expect(outcomePromise).resolves.toBe('allowed');
    expect(ctx.calls).toEqual([
      { approvalId: 'a9', decision: 'reject', scope: 'auto' }, // failed auto attempt
      { approvalId: 'a9', decision: 'allow', scope: 'once' } // manual answer delivered
    ]);
    expect(ctx.resolved).toEqual([{ approvalId: 'a9', outcome: 'allowed', viaModal: true }]);
  });

  it('escalates a failed cached-grant replay the same way (same treatment for all auto paths)', async () => {
    const INSIDE = { needsAuthorization: false, unverifiable: false };
    const ctx = makeFailingService({ checkPaths: async () => INSIDE });
    // Earn the grant while healthy.
    ctx.setHealthy(true);
    const first = ctx.service.handleApprovalRequired(frame({ approval_id: 'a1' }));
    await Promise.resolve();
    ctx.service.resolveRequest([...ctx.service.listPending()][0]!.requestId, {
      decision: 'allow',
      scope: 'session'
    });
    await expect(first).resolves.toBe('allowed');

    // Runtime dies; identical replay must NOT fake an auto-allow…
    ctx.setHealthy(false);
    const second = ctx.service.handleApprovalRequired(frame({ approval_id: 'a2' }));
    await Promise.resolve();
    expect(ctx.notices).toContainEqual(expect.objectContaining({ kind: 'respond_failed' }));
    expect(ctx.service.pendingCount).toBe(1);
    expect([...ctx.service.listPending()][0]!.approvalId).toBe('a2');

    // …but escalate to an actionable prompt whose answer really delivers.
    ctx.setHealthy(true);
    ctx.service.resolveRequest([...ctx.service.listPending()][0]!.requestId, {
      decision: 'allow',
      scope: 'session'
    });
    await expect(second).resolves.toBe('allowed');
    expect(ctx.calls[ctx.calls.length - 1]).toEqual({
      approvalId: 'a2',
      decision: 'allow',
      scope: 'session'
    });
  });

  it('drops a timed-out modal whose rejection cannot be delivered (no zombie pendings)', async () => {
    vi.useFakeTimers();
    try {
      const ctx = makeFailingService({ timeoutMs: 1000 });
      const p = ctx.service.handleApprovalRequired(frame({ approval_id: 'a1' }));
      await vi.advanceTimersByTimeAsync(1100);
      await expect(p).resolves.toBe('rejected');
      expect(ctx.service.pendingCount).toBe(0);
      expect(ctx.resolved).toEqual([]); // still no fabricated success
      expect(ctx.notices).toContainEqual(expect.objectContaining({ kind: 'respond_failed' }));
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});
