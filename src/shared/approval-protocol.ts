/**
 * Approval flow — types shared between main (engine/service), preload
 * (bridge) and renderer (modal). Kept free of Node imports so the renderer
 * bundle can use them directly.
 */

import type { RiskLevel } from './protocol/types';

/** Coarse action categories used by the matrix tests and the UI badge. */
export type ActionCategory = 'read' | 'edit' | 'shell' | 'network' | 'git' | 'system';

export const ACTION_CATEGORIES: readonly ActionCategory[] = [
  'read',
  'edit',
  'shell',
  'network',
  'git',
  'system'
];

/** One approval prompt pushed to the renderer over IPC (`approval:request`). */
export interface ApprovalRequestPayload {
  /** Desktop-side id for this modal instance (reply channel key). */
  requestId: string;
  /** Runtime-side id echoed back in the approval_response command. */
  approvalId: string;
  runId?: string;
  tool?: string;
  /** Full command line, shown monospace and never truncated. */
  command?: string;
  summary?: string;
  level: RiskLevel | string;
  category: ActionCategory;
  needsBoundaryAuthorization: boolean;
  /** Paths that fall outside the workspace boundary (when applicable). */
  outsidePaths: string[];
  reasons: string[];
}

/** Renderer → main answer (`approval:respond`). */
export interface ApprovalReply {
  requestId: string;
  decision: 'allow' | 'reject';
  scope: 'once' | 'session';
}

export type ApprovalOutcome = 'allowed' | 'rejected' | 'auto_allowed' | 'auto_denied';
