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
import { normalize as normalizeOsPath } from 'node:path';
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
  | { event: 'notice'; notice: { kind: 'auto_denied'; reasons: string[] } }
  | {
      event: 'notice';
      notice: { kind: 'respond_failed'; approvalId: string; reason: string };
    };

/**
 * Normalize one operation target for grant-key binding: OS-normalize, unify
 * separators, strip trailing slashes. Case is preserved (POSIX is
 * case-sensitive); the runtime boundary service remains the authority.
 */
function normalizeTarget(p: string): string {
  const unified = p.replace(/\\/g, '/');
  // posix.normalize preserves a leading `//`; collapse duplicate separators
  // so equivalent spellings share one grant key.
  const n = normalizeOsPath(unified).replace(/\/{2,}/g, '/');
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

/**
 * Review fix 1: a session-grant key binds the tool AND the normalized
 * operation targets (command / paths). A "本次会话均允许" earned for one path
 * can therefore never be replayed for a different path — least of all one
 * outside the workspace.
 */
function grantKeyOf(frame: ApprovalRequiredEventFrame): string {
  const paths = Array.isArray(frame.paths) ? frame.paths.map(normalizeTarget).sort() : [];
  return JSON.stringify([frame.tool ?? '', typeof frame.command === 'string' ? frame.command : '', paths]);
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

  /** Renderer answered a modal (Allow / Allow Once / Reject).
   *
   * Review fix 3: the runtime delivery result is authoritative. When
   * `respond()` reports failure (runtime unwritable), the request is NOT
   * consumed, NO session grant is cached, and NO success is reported — a
   * `respond_failed` notice is emitted instead and the modal stays open so
   * the user can retry. */
  resolveRequest(requestId: string, reply: Omit<ApprovalReply, 'requestId'>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    const decision = reply.decision === 'allow' ? 'allow' : 'reject';
    const scope = reply.scope === 'session' ? 'session' : 'once';
    const outcome: ApprovalOutcome = decision === 'allow' ? 'allowed' : 'rejected';

    const sent = this.deps.respond({
      approvalId: entry.payload.approvalId,
      decision,
      scope
    });
    if (!sent) {
      this.emit('notice', {
        kind: 'respond_failed',
        approvalId: entry.payload.approvalId,
        reason: 'runtime_unreachable'
      });
      return false;
    }

    this.pending.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (decision === 'allow' && scope === 'session') {
      this.sessionGrants.add(entry.grantKey);
    }
    this.emit('resolved', {
      approvalId: entry.payload.approvalId,
      outcome,
      viaModal: true
    });
    entry.settle(outcome === 'allowed' ? 'allowed' : 'rejected');
    return true;
  }

  /** True while a pending request exists (IPC error classification). */
  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
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
    const grantKey = grantKeyOf(frame);

    // 1. Boundary verdict from the P1-A workspace service. Computed BEFORE
    // any grant replay: a cached session grant must never bypass a fresh
    // out-of-workspace / unverifiable determination.
    let boundary: BoundaryVerdict | undefined;
    const paths = frame.paths ?? [];
    if (this.deps.checkPaths && paths.length > 0) {
      try {
        boundary = await this.deps.checkPaths(paths);
      } catch {
        boundary = { needsAuthorization: false, unverifiable: true };
      }
    }

    // 2. Session grants short-circuit identical repeat operations — same
    // tool, same command, SAME normalized targets — and only while the
    // fresh boundary verdict still confirms in-workspace, verifiable
    // targets ("先内后外": a grant earned inside never covers outside).
    if (this.sessionGrants.has(grantKey)) {
      const stillCovered =
        boundary?.needsAuthorization !== true && boundary?.unverifiable !== true;
      if (stillCovered) {
        return this.autoRespond(approvalId, 'allow', 'session', 'allowed');
      }
      // Grant exists but the target is no longer provably safe → fall
      // through to the full matrix and ask again.
    }

    // 3. Pure rule matrix.
    const evaluation = evaluateApproval(this.deps.getMode(), op, boundary);

    if (evaluation.decision === 'deny') {
      return this.autoRespond(approvalId, 'reject', 'auto', 'auto_denied', evaluation.reasons);
    }
    if (evaluation.decision === 'allow') {
      return this.autoRespond(approvalId, 'allow', 'auto', 'auto_allowed');
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
          // A timed-out modal behaves like closing it: reject. If even the
          // rejection cannot be delivered (runtime unwritable), drop the
          // entry so it cannot leak forever — the safe default stands and
          // no grant is cached either way.
          const sent = this.resolveRequest(requestId, { decision: 'reject', scope: 'once' });
          if (!sent) {
            const dropped = this.pending.get(requestId);
            if (dropped && this.pending.delete(requestId)) {
              if (dropped.timer) clearTimeout(dropped.timer);
              this.emit('notice', {
                kind: 'respond_failed',
                approvalId: dropped.payload.approvalId,
                reason: 'runtime_unreachable'
              });
              dropped.settle('rejected');
            }
          }
        }, this.deps.timeoutMs);
        timer.unref?.();
        entry.timer = timer;
      }

      this.emit('request-created', payload);
      this.deps.notifyRenderer(payload);
    });
  }

  /**
   * Deliver an automatic decision (matrix allow/deny, cached session grant)
   * to the runtime. Review fix 3: when delivery fails, NO success is
   * reported — no `resolved` event, nothing settles — and a retryable
   * `respond_failed` notice is emitted. The matrix outcome is still
   * returned so callers can log/decide, with delivery state carried by the
   * notice.
   */
  private autoRespond(
    approvalId: string,
    decision: 'allow' | 'reject',
    scope: 'once' | 'session' | 'auto',
    outcome: ApprovalOutcome,
    reasons?: string[]
  ): ApprovalOutcome {
    const sent = this.deps.respond({ approvalId, decision, scope });
    if (!sent) {
      this.emit('notice', {
        kind: 'respond_failed',
        approvalId,
        reason: 'runtime_unreachable'
      });
      return outcome;
    }
    if (reasons) this.emit('notice', { kind: 'auto_denied', reasons });
    this.emitResolved(approvalId, outcome, false);
    return outcome;
  }

  private emitResolved(approvalId: string, outcome: ApprovalOutcome, viaModal: boolean): void {
    this.emit('resolved', { approvalId, outcome, viaModal });
  }
}
