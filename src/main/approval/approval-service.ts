/**
 * Approval Service — application wiring for the approval flow (DSHA-5).
 *
 * Pipeline for each `approval_required` event:
 *
 *   runtime frame
 *     → session-grant cache (「Allow」 covers identical operations)
 *     → boundary service verdict over all target paths (P1-A)
 *     → pure rule matrix (`evaluateApproval`)
 *         · allow      → approval_response{allow, scope:'auto'}
 *         · deny       → approval_response{reject, scope:'auto'} + notice
 *         · ask        → push modal payload to renderer, await reply
 *
 * The service never trusts the runtime's claimed risk level as a downgrade,
 * and it never shows a modal for operations the matrix already settles.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type {
  ApprovalOutcome,
  ApprovalReply,
  ApprovalRequestPayload
} from '../../shared/approval-protocol';
import type { ApprovalRequiredEventFrame, RuntimeEventFrame } from '../../shared/protocol/types';
import type { PermissionMode } from '../../shared/settings';
import { evaluateApproval, type BoundaryVerdict } from './approval-engine';

export interface ApprovalServiceDeps {
  /** Send the decision to the runtime (RuntimeClient.respondApproval). */
  respond: (input: {
    approvalId: string;
    decision: 'allow' | 'reject';
    scope: 'once' | 'session' | 'auto';
  }) => boolean;
  /** Current permission mode from the settings store. */
  getMode: () => PermissionMode;
  /** Aggregate boundary verdict over target paths; null when unavailable. */
  checkPaths?: (paths: readonly string[]) => Promise<BoundaryVerdict>;
  /** Push a prompt to the renderer (webContents.send). */
  notifyRenderer: (payload: ApprovalRequestPayload) => void;
  /** Optional auto-reject timeout for pending modals (tests); default none. */
  timeoutMs?: number;
}

export interface PendingRequest {
  payload: ApprovalRequestPayload;
  grantKey: string;
  /** Completes when the modal is answered (or auto-rejected on timeout). */
  settle: (outcome: 'allowed' | 'rejected') => void;
  timer?: NodeJS.Timeout;
}

/** Typed notification payloads (see `emitNotice` / `notify*` helpers). */
export type ApprovalServiceEvent =
  | { event: 'request-created'; payload: ApprovalRequestPayload }
  | { event: 'resolved'; result: { approvalId: string; outcome: ApprovalOutcome; viaModal: boolean } }
  | { event: 'notice'; notice: { kind: 'auto_denied'; reasons: string[] } };

function grantKeyOf(tool: string | undefined, command: string | undefined): string {
  return `${tool ?? ''}\u0000${command ?? ''}`;
}

export class ApprovalService extends EventEmitter {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessionGrants = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: ApprovalServiceDeps) {
    super();
  }

  /** Start listening on the bus. Returns when detached. */
  attach(source: { subscribe(listener: (message: unknown) => void): () => void }): void {
    if (this.unsubscribe) return;
    this.unsubscribe = source.subscribe((raw) => {
      const message = raw as { kind?: string; frame?: RuntimeEventFrame };
      if (message?.kind === 'event' && message.frame?.type === 'approval_required') {
        void this.handleApprovalRequired(message.frame as ApprovalRequiredEventFrame);
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  listPending(): ApprovalRequestPayload[] {
    return [...this.pending.values()].map((p) => p.payload);
  }

  /** Renderer answered a modal (Allow / Allow Once / Reject). */
  resolveRequest(requestId: string, reply: Omit<ApprovalReply, 'requestId'>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);

    const decision = reply.decision === 'allow' ? 'allow' : 'reject';
    const scope = reply.scope === 'session' ? 'session' : 'once';
    const outcome: ApprovalOutcome = decision === 'allow' ? 'allowed' : 'rejected';
    if (decision === 'allow' && scope === 'session') {
      this.sessionGrants.add(entry.grantKey);
    }
    this.deps.respond({
      approvalId: entry.payload.approvalId,
      decision,
      scope
    });
    this.emit('resolved', {
      approvalId: entry.payload.approvalId,
      outcome,
      viaModal: true
    });
    entry.settle(outcome === 'allowed' ? 'allowed' : 'rejected');
    return true;
  }

  /** Process one approval_required frame end-to-end. */
  async handleApprovalRequired(frame: ApprovalRequiredEventFrame): Promise<ApprovalOutcome> {
    const approvalId =
      typeof frame.approval_id === 'string' && frame.approval_id.length > 0
        ? frame.approval_id
        : `desktop-approval-${randomUUID()}`;
    const op = {
      tool: frame.tool,
      command: frame.command,
      paths: frame.paths,
      claimedLevel: frame.risk_level
    };
    const grantKey = grantKeyOf(frame.tool, frame.command);

    // 1. Session grants short-circuit identical repeat operations.
    if (this.sessionGrants.has(grantKey)) {
      this.deps.respond({ approvalId, decision: 'allow', scope: 'session' });
      this.emitResolved(approvalId, 'allowed', false);
      return 'allowed';
    }

    // 2. Boundary verdict from the P1-A workspace service.
    let boundary: BoundaryVerdict | undefined;
    const paths = frame.paths ?? [];
    if (this.deps.checkPaths && paths.length > 0) {
      try {
        boundary = await this.deps.checkPaths(paths);
      } catch {
        boundary = { needsAuthorization: false, unverifiable: true };
      }
    }

    // 3. Pure rule matrix.
    const evaluation = evaluateApproval(this.deps.getMode(), op, boundary);

    if (evaluation.decision === 'deny') {
      this.deps.respond({ approvalId, decision: 'reject', scope: 'auto' });
      this.emit('notice', { kind: 'auto_denied', reasons: evaluation.reasons });
      this.emitResolved(approvalId, 'auto_denied', false);
      return 'auto_denied';
    }
    if (evaluation.decision === 'allow') {
      this.deps.respond({ approvalId, decision: 'allow', scope: 'auto' });
      this.emitResolved(approvalId, 'auto_allowed', false);
      return 'auto_allowed';
    }

    // 4. Modal path: the promise settles when the renderer answers.
    const requestId = randomUUID();
    const outsidePaths = boundary?.needsAuthorization === true ? paths.slice() : [];
    const payload: ApprovalRequestPayload = {
      requestId,
      approvalId,
      runId: typeof frame.run_id === 'string' ? frame.run_id : undefined,
      tool: frame.tool,
      command: frame.command,
      summary: frame.summary,
      level: evaluation.level,
      category: evaluation.category,
      needsBoundaryAuthorization: evaluation.needsBoundaryAuthorization,
      outsidePaths,
      reasons: evaluation.reasons
    };
    return await new Promise<ApprovalOutcome>((settle) => {
      const entry: PendingRequest = {
        payload,
        grantKey,
        settle
      };
      this.pending.set(requestId, entry);

      if (this.deps.timeoutMs !== undefined) {
        const timer = setTimeout(() => {
          // A timed-out modal behaves like closing it: reject.
          this.resolveRequest(requestId, { decision: 'reject', scope: 'once' });
        }, this.deps.timeoutMs);
        timer.unref?.();
        entry.timer = timer;
      }

      this.emit('request-created', payload);
      this.deps.notifyRenderer(payload);
    });
  }

  private emitResolved(approvalId: string, outcome: ApprovalOutcome, viaModal: boolean): void {
    this.emit('resolved', { approvalId, outcome, viaModal });
  }
}
