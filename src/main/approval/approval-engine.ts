/**
 * Approval engine — thin re-export shim.
 *
 * The rule matrix itself is pure and lives in `src/shared/approval-rules.ts`
 * so the renderer can reuse the exact same classification for Tool Call
 * badges (§9) without reaching into main-process code. Keep this path stable:
 * the approval service and its tests import from here.
 */

export * from '../../shared/approval-rules';
