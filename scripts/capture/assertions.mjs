/**
 * Pure, repeatable gate assertions for the DSHA-6 Diff capture harness.
 *
 * ESM so the same logic is unit-tested by vitest (`tests/capture-gate.test.ts`)
 * and used by the Electron capture main (`scripts/capture/main.cjs`). Each
 * function returns an array of failure strings (empty ⇒ pass), so the gate can
 * only be green when every real acceptance condition holds — no false-green
 * from a missing/zero-size/overlapping element.
 */

export function rectVisible(rect) {
  return !!rect && rect.visible === true && rect.w > 0 && rect.h > 0;
}

export function rectInViewport(rect, vw) {
  return !!rect && rect.x >= 0 && rect.x + rect.w <= vw;
}

export function noHScrollErrors(b) {
  return b.noPageHScroll === true
    ? []
    : [`noPageHScroll=false (page=${b.pageScrollWidth} client=${b.pageClientWidth})`];
}

export function toolbarErrors(b) {
  if (!rectVisible(b.toolbar)) return ['toolbar not visible (missing or zero-size)'];
  if (!rectInViewport(b.toolbar, b.viewport.w)) return ['toolbar outside viewport'];
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
 * Validates the action bar: EXACTLY the expected buttons exist, each has a
 * non-zero, in-viewport rect, and all pairs are non-overlapping.
 */
export function actionsBarErrors(b, expectedLabels = []) {
  const errs = [];
  const btns = b.actionBtns || [];
  if (btns.length !== expectedLabels.length) {
    errs.push(`expected ${expectedLabels.length} action buttons, got ${btns.length}`);
  }
  for (let i = 0; i < expectedLabels.length; i += 1) {
    const btn = btns[i];
    if (!btn) {
      errs.push(`missing action button ${expectedLabels[i]}`);
      continue;
    }
    if (!(btn.w > 0 && btn.h > 0)) errs.push(`action button ${expectedLabels[i]} has zero size`);
    if (!(btn.x >= 0 && btn.x + btn.w <= b.viewport.w)) {
      errs.push(`action button ${expectedLabels[i]} outside viewport`);
    }
  }
  errs.push(...overlapErrors(btns));
  return errs;
}
