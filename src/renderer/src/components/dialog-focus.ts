/**
 * Dialog focus management (issue DSHA-6, P1-1 UI/UE review fix).
 *
 * Pure, framework-agnostic focus-trap + initial-focus + busy-close-gating
 * helpers so the a11y contract of ConfirmDialog is unit-testable in node
 * (no DOM required — callers pass minimal structural fakes).
 */

export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface Focusable {
  focus(): void;
}

export interface DialogLike {
  querySelectorAll(selector: string): NodeListOf<Element> | readonly Focusable[];
}

/** All focusable descendants of the dialog, in document order. */
export function collectFocusables(dialog: DialogLike): Focusable[] {
  return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR) as Iterable<Focusable>);
}

/**
 * Index of the next element to focus when cycling (Tab = +1, Shift+Tab = -1)
 * with hard wrap-around so focus can never escape the dialog (focus trap).
 * Returns -1 when there is nothing to focus.
 */
export function cycleFocusIndex(count: number, currentIndex: number, shiftKey: boolean): number {
  if (count <= 0) return -1;
  if (currentIndex < 0) return shiftKey ? count - 1 : 0;
  if (shiftKey) return currentIndex <= 0 ? count - 1 : currentIndex - 1;
  return currentIndex >= count - 1 ? 0 : currentIndex + 1;
}

/**
 * Stage-1 initial focus target: the preferred (safe/cancel) element when it is
 * in the list, otherwise the first focusable — never the destructive action.
 */
export function pickInitialFocus(
  list: readonly Focusable[],
  preferred: Focusable | null
): Focusable | null {
  if (preferred != null && list.includes(preferred)) return preferred;
  return list[0] ?? null;
}

/** Busy ⇒ the dialog must not be dismissible (no Esc, no backdrop, no resubmit). */
export function ignoreCloseWhileBusy(busy: boolean): boolean {
  return busy;
}
