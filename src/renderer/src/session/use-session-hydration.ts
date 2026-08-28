/**
 * The Workspace page's transcript-hydration effect, extracted so the exact
 * production wiring (request epoch → hydrate → cancelled/guard decision →
 * apply + attribution → settle) is testable against the real
 * useSessionStore hook with deferred desktop promises (review round:
 * settle ownership — the busy transition ends only AFTER the caller has
 * decided to apply or drop the result).
 *
 * Contract (mirrors WorkspacePage's previous inline effect 1:1):
 *   - fires when the session becomes loaded / the active id changes;
 *   - the result is applied only when not cancelled AND the HydrationGuard
 *     epoch is still current (a mutation since the request = stale snapshot);
 *   - a null result (freshly-created session) keeps the live model, which
 *     already belongs to the active session;
 *   - `settleHydration(targetId)` runs in `.finally` — i.e. AFTER the
 *     apply/drop decision, so the busy transition (interaction lock +
 *     "切换前会话" attribution) never ends while the old transcript is still
 *     on screen without the decision having been made. Identity-safe.
 */

import { useEffect, useRef, type RefObject } from 'react';

import { INITIAL_MODEL, type ChatModel } from '../chat/model';
import type { SessionStoreValue } from './session-store';
import type { HydrationGuard } from './session-transition';

export function useSessionHydration(
  sessions: Pick<
    SessionStoreValue,
    | 'loaded'
    | 'activeId'
    | 'hydrate'
    | 'noteDisplayedFor'
    | 'settleHydration'
    | 'workspaceEpoch'
  >,
  setModel: (model: ChatModel) => void,
  guardRef: RefObject<HydrationGuard | null>
): void {
  const { loaded, activeId, hydrate, noteDisplayedFor, settleHydration, workspaceEpoch } = sessions;

  // Workspace displayed-model isolation (review round): when the workspace
  // identity is voided (workspaceEpoch bump), the ChatModel still on screen
  // belongs to the PREVIOUS workspace — clear it here. The clear goes through
  // the HydrationGuard as a NON-hydration mutation: any in-flight request
  // from the old workspace is invalidated and cannot re-apply the old
  // transcript afterwards. Without this, a failed bootstrap in the new
  // workspace would leave the old workspace's transcript interactive and
  // idle on screen.
  const lastEpochRef = useRef(workspaceEpoch);
  useEffect(() => {
    if (lastEpochRef.current === workspaceEpoch) return;
    lastEpochRef.current = workspaceEpoch;
    guardRef.current?.noteMutation();
    setModel(INITIAL_MODEL);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setModel is a stable React state setter
  }, [workspaceEpoch]);
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    // §15/AC-12 竞态防护：hydrate 结果仅在「请求发出后内存模型未被任何非
    // hydrate 变更改动」时才可应用。判定基于请求代次而非「内存是否为空」。
    const guard = guardRef.current;
    if (guard === null) return;
    const epoch = guard.request();
    const targetId = activeId;
    void hydrate()
      .then((restored) => {
        if (cancelled) return; // superseded (active id moved on) — result dropped
        if (restored !== null && guard.canApply(epoch)) {
          setModel(restored);
          // The applied snapshot now belongs to the session it was requested for.
          noteDisplayedFor(targetId);
        }
        // A null result (freshly-created session) keeps the live model, which
        // already belongs to the active session.
        if (restored === null) noteDisplayedFor(targetId);
      })
      // Settle AFTER the apply/drop decision above — the busy transition ends
      // only once the caller has finished deciding, never inside hydrate().
      // Identity-safe: a late settle cannot unlock a newer transition.
      .finally(() => settleHydration(targetId));
    return () => {
      cancelled = true;
    };
    // All deps are stable callbacks / primitives from the hook — this does
    // NOT depend on the `sessions` object itself (a fresh literal every
    // render), which would re-trigger hydration endlessly. `setModel` (a
    // React state setter) and `guardRef` (a ref) are stable by contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, activeId, hydrate, noteDisplayedFor, settleHydration]);
}
