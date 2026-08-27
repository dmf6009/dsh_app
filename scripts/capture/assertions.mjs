/**
 * Pure, repeatable gate assertions for the DSHA-6 Diff capture harness.
 *
 * ESM so the same logic is unit-tested by vitest (`tests/capture-gate.test.ts`)
 * and used by the Electron capture main (`scripts/capture/main.cjs`). Each
 * function returns an array of failure strings (empty ⇒ pass), so the gate can
 * only be green when every real acceptance condition holds — no false-green
 * from a missing/zero-size/invisible/mislabelled/out-of-viewport element.
 *
 * Review-driven contract (DSHA-6 UI/UE rework):
 *  - button identity: the action bar must contain EXACTLY the expected buttons,
 *    verified by label — a wrong or reordered label fails (not just a count);
 *  - viewport bounds: containment covers BOTH horizontal (x/w) and vertical
 *    (y/h) axes against the full viewport rect;
 *  - button visibility: each button's real `visible` flag (captured from the
 *    element box) is asserted, so a `display:none`/zero-box button cannot pass
 *    even if its recorded w/h were stale.
 */

export function rectVisible(rect) {
  return !!rect && rect.visible === true && rect.w > 0 && rect.h > 0;
}

/**
 * Containment within the viewport rectangle. Checks BOTH axes so a control
 * pushed off the top (y < 0) or bottom (y + h > vh) fails — horizontal-only
 * checks let vertical overflow through as false-green.
 */
export function rectInViewport(rect, vw, vh) {
  if (!rect) return false;
  if (rect.x < 0 || rect.x + rect.w > vw) return false;
  if (vh !== undefined && (rect.y < 0 || rect.y + rect.h > vh)) return false;
  return true;
}

export function noHScrollErrors(b) {
  return b.noPageHScroll === true
    ? []
    : [`noPageHScroll=false (page=${b.pageScrollWidth} client=${b.pageClientWidth})`];
}

export function toolbarErrors(b) {
  if (!rectVisible(b.toolbar)) return ['toolbar not visible (missing or zero-size)'];
  if (!rectInViewport(b.toolbar, b.viewport.w, b.viewport.h)) {
    return ['toolbar outside viewport'];
  }
  return [];
}

export function overlapErrors(btns) {
  const out = [];
  for (let i = 0; i < btns.length; i += 1) {
    for (let j = i + 1; j < btns.length; j += 1) {
      const a = btns[i];
      const b = btns[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        out.push(`${a.text || a.x} ↔ ${b.text || b.x}`);
      }
    }
  }
  return out;
}

/**
 * Validates the action bar against an EXACT, ORDERED set of expected button
 * labels — verifying each button's real identity, not merely the count.
 *
 * For every expected label:
 *  - a button MUST exist at that position;
 *  - its `text` MUST equal the expected label (wrong/mislabelled → FAIL);
 *  - it MUST be `visible` with positive size (hidden/zero-box → FAIL);
 *  - it MUST lie entirely within the viewport on BOTH axes.
 * Finally all button pairs must be non-overlapping. Any surplus/missing button
 * also fails so a 2- or 4-button bar cannot slip through as a 3-button pass.
 */
export function actionsBarErrors(b, expectedLabels = []) {
  const errs = [];
  const btns = b.actionBtns || [];
  const vw = b.viewport.w;
  const vh = b.viewport.h;

  if (btns.length !== expectedLabels.length) {
    errs.push(`expected ${expectedLabels.length} action buttons, got ${btns.length}`);
  }

  for (let i = 0; i < expectedLabels.length; i += 1) {
    const expected = expectedLabels[i];
    const btn = btns[i];
    if (!btn) {
      errs.push(`missing action button "${expected}"`);
      continue;
    }
    // Identity: the actual label must match — a wrong/reordered button fails.
    const actual = (btn.text || '').trim();
    if (actual !== expected) {
      errs.push(`action button #${i + 1} label mismatch: expected "${expected}", got "${actual}"`);
    }
    // Visibility: a hidden/zero-box button is a false-green if unchecked.
    if (btn.visible === false) {
      errs.push(`action button "${expected}" is not visible (visible=false)`);
    }
    if (!(btn.w > 0 && btn.h > 0)) {
      errs.push(`action button "${expected}" has zero size (w=${btn.w} h=${btn.h})`);
    }
    // Containment on BOTH axes (top/bottom overflow must fail).
    if (!rectInViewport(btn, vw, vh)) {
      const where =
        btn.x < 0 || btn.x + btn.w > vw
          ? `horizontal (x=${btn.x} w=${btn.w} vw=${vw})`
          : `vertical (y=${btn.y} h=${btn.h} vh=${vh})`;
      errs.push(`action button "${expected}" outside viewport — ${where}`);
    }
  }

  errs.push(...overlapErrors(btns));
  return errs;
}
