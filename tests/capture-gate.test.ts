/**
 * Unit tests for the capture-harness assertion gate (DSHA-6 UI/UE review fix).
 * These prove the gate FAILS on the real acceptance regressions the reviewer
 * flagged — not just on an injected constant-false condition. Each fixture
 * carries a `visible` flag and uses a viewport with a real height so the
 * vertical-axis and button-visibility contract are exercised truthfully.
 */

import { describe, expect, it } from 'vitest';

import {
  actionsBarErrors,
  noHScrollErrors,
  rectInViewport,
  rectVisible,
  toolbarErrors
} from '../scripts/capture/assertions.mjs';
import type { ActionBtn, Bounds } from '../scripts/capture/assertions.d.mts';

const VW = 500;
const VH = 400;
const LABELS = ['↑ 上一个', '↓ 下一个', '恢复此文件…'];

/** A clean, valid bounds fixture: 3 visible, correctly-labelled,
 * non-overlapping buttons fully inside the viewport on both axes. */
const base: Bounds = {
  viewport: { w: VW, h: VH },
  noPageHScroll: true,
  pageScrollWidth: VW,
  pageClientWidth: VW,
  toolbar: { x: 0, y: 0, w: VW, h: 40, visible: true },
  actionBtns: [
    { text: '↑ 上一个', x: 0, y: 360, w: 80, h: 28, visible: true },
    { text: '↓ 下一个', x: 90, y: 360, w: 80, h: 28, visible: true },
    { text: '恢复此文件…', x: 180, y: 360, w: 90, h: 28, visible: true }
  ]
};

/** Helper: map over the action buttons, returning a new ActionBtn array. */
const mapBtns = (fn: (b: ActionBtn, i: number) => ActionBtn): ActionBtn[] =>
  base.actionBtns.map((b, i) => fn(b, i));

describe('rectVisible / rectInViewport', () => {
  it('requires visible + non-zero size', () => {
    expect(rectVisible({ x: 0, y: 0, w: 10, h: 10, visible: true })).toBe(true);
    expect(rectVisible(null)).toBe(false);
    expect(rectVisible({ x: 0, y: 0, w: 0, h: 10, visible: true })).toBe(false); // zero width
    expect(rectVisible({ x: 0, y: 0, w: 10, h: 0, visible: true })).toBe(false); // zero height
    expect(rectVisible({ x: 0, y: 0, w: 10, h: 10, visible: false })).toBe(false); // hidden
  });

  it('checks containment on BOTH horizontal and vertical axes', () => {
    // Fully inside.
    expect(rectInViewport({ x: 0, y: 0, w: 100, h: 10, visible: true }, 500, 400)).toBe(true);
    // Horizontal overflow only.
    expect(rectInViewport({ x: 400, y: 0, w: 200, h: 10, visible: true }, 500, 400)).toBe(false);
    // Bottom vertical overflow (the gap the reviewer flagged).
    expect(rectInViewport({ x: 0, y: 390, w: 100, h: 20, visible: true }, 500, 400)).toBe(false);
    // Top vertical overflow.
    expect(rectInViewport({ x: 0, y: -10, w: 100, h: 20, visible: true }, 500, 400)).toBe(false);
  });

  it('ignores the vertical axis only when vh is omitted (backward-compatible)', () => {
    // Horizontal-only callers (no vh) still work as before.
    expect(rectInViewport({ x: 0, y: 9999, w: 100, h: 10, visible: true }, 500)).toBe(true);
    expect(rectInViewport({ x: 400, y: 0, w: 200, h: 10, visible: true }, 500)).toBe(false);
  });
});

describe('noHScrollErrors', () => {
  it('passes only when there is no page-level horizontal scroll', () => {
    expect(noHScrollErrors(base)).toEqual([]);
    expect(noHScrollErrors({ ...base, noPageHScroll: false, pageScrollWidth: 511 })).not.toEqual([]);
  });
});

describe('toolbarErrors', () => {
  it('fails on a missing or zero-size toolbar (review gap #1)', () => {
    expect(toolbarErrors({ ...base, toolbar: null })).not.toEqual([]);
    expect(toolbarErrors({ ...base, toolbar: { x: 0, y: 0, w: 0, h: 40, visible: true } })).not.toEqual([]);
    expect(toolbarErrors({ ...base, toolbar: { x: 0, y: 0, w: 200, h: 40, visible: false } })).not.toEqual([]);
  });

  it('passes on a visible in-viewport toolbar', () => {
    expect(toolbarErrors(base)).toEqual([]);
  });

  it('fails when the toolbar spills outside the viewport horizontally', () => {
    expect(
      toolbarErrors({ ...base, toolbar: { x: 400, y: 0, w: 200, h: 40, visible: true } })
    ).not.toEqual([]);
  });

  it('fails when the toolbar spills outside the viewport vertically (top/bottom)', () => {
    // Pushed off the bottom edge.
    expect(
      toolbarErrors({ ...base, toolbar: { x: 0, y: 390, w: 200, h: 40, visible: true } })
    ).not.toEqual([]);
    // Pushed off the top edge.
    expect(
      toolbarErrors({ ...base, toolbar: { x: 0, y: -20, w: 200, h: 40, visible: true } })
    ).not.toEqual([]);
  });
});

describe('actionsBarErrors — identity, visibility, viewport, overlap', () => {
  it('passes with exactly 3 visible, correctly-labelled, non-overlapping buttons', () => {
    expect(actionsBarErrors(base, LABELS)).toEqual([]);
  });

  // --- count / existence -------------------------------------------------
  it('fails when fewer than the expected buttons are present', () => {
    expect(actionsBarErrors({ ...base, actionBtns: base.actionBtns.slice(0, 2) }, LABELS)).not.toEqual([]);
    expect(actionsBarErrors({ ...base, actionBtns: [] }, LABELS)).not.toEqual([]);
  });

  it('fails when more than the expected buttons are present', () => {
    const extra = [...base.actionBtns, { text: '多余', x: 280, y: 360, w: 50, h: 28, visible: true }];
    expect(actionsBarErrors({ ...base, actionBtns: extra }, LABELS)).not.toEqual([]);
  });

  // --- identity / label (review gap: must verify identity, not just count) -
  it('fails when a button has the wrong label', () => {
    const btns = mapBtns((b, i) => (i === 1 ? { ...b, text: '错误标签' } : b));
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/label mismatch/);
  });

  it('fails when the correct labels are present but reordered', () => {
    const btns: ActionBtn[] = [base.actionBtns[2], base.actionBtns[0], base.actionBtns[1]].filter(
      (b): b is ActionBtn => !!b
    );
    expect(actionsBarErrors({ ...base, actionBtns: btns }, LABELS)).not.toEqual([]);
  });

  it('fails when all three labels are wrong despite the right count', () => {
    const btns = [
      { text: 'WRONG-A', x: 0, y: 360, w: 80, h: 28, visible: true },
      { text: 'WRONG-B', x: 90, y: 360, w: 80, h: 28, visible: true },
      { text: 'WRONG-C', x: 180, y: 360, w: 90, h: 28, visible: true }
    ];
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBe(3); // every label mismatches
    expect(errs.join(' ')).toMatch(/label mismatch/);
  });

  // --- visibility (review gap: must assert real visible, not stale w/h) ----
  it('fails when a button is invisible (visible=false) even with positive size', () => {
    const btns = mapBtns((b, i) => (i === 0 ? { ...b, visible: false } : b));
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/not visible/);
  });

  it('fails when a button has zero size', () => {
    const btns = mapBtns((b, i) => (i === 1 ? { ...b, w: 0, h: 0, visible: false } : b));
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/zero size|not visible/);
  });

  // --- viewport bounds: BOTH axes ---------------------------------------
  it('fails when a button overflows the BOTTOM of the viewport (vertical)', () => {
    const btns = mapBtns((b) => ({ ...b, y: 390, h: 28 })); // 390 + 28 > 400
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/outside viewport.*vertical/);
  });

  it('fails when a button overflows the TOP of the viewport (negative y)', () => {
    const btns = mapBtns((b) => ({ ...b, y: -10, h: 28 }));
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/outside viewport.*vertical/);
  });

  it('fails when a button overflows the RIGHT edge of the viewport (horizontal)', () => {
    const btns = mapBtns((b, i) => (i === 2 ? { ...b, x: 480, w: 90 } : b)); // 480+90 > 500
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/outside viewport.*horizontal/);
  });

  // --- overlap ----------------------------------------------------------
  it('fails when any pair of buttons overlaps', () => {
    const btns = mapBtns((b, i) => (i === 2 ? { ...b, x: 100 } : b)); // overlaps the 2nd
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/overlap|↔/);
  });
});

describe('actionsBarErrors — strict visible === true (no missing-field green)', () => {
  // The reviewer flagged that `visible` absent/undefined/null must FAIL, not
  // only `visible === false`. The capture contract is a strict boolean `true`;
  // a JSON/capture field drop must surface as a gate failure, not a pass.

  it('fails when the `visible` field is OMITTED entirely (positive box present)', () => {
    // Cast: these intentionally lack the `visible` field to model a captured
    // JSON record that dropped it — the TS type is satisfied via the boundary
    // cast, but the runtime value is the point of the test.
    const btns = [
      { text: '↑ 上一个', x: 0, y: 360, w: 80, h: 28 },
      { text: '↓ 下一个', x: 90, y: 360, w: 80, h: 28 },
      { text: '恢复此文件…', x: 180, y: 360, w: 90, h: 28 }
    ] as unknown as ActionBtn[];
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBe(3); // every button missing visible
    expect(errs.join(' ')).toMatch(/not visible.*undefined/);
  });

  it('fails when `visible` is null', () => {
    const btns = [
      { ...base.actionBtns[0]!, visible: null as unknown as boolean },
      ...base.actionBtns.slice(1)
    ] as unknown as ActionBtn[];
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/not visible.*null/);
  });

  it('fails when `visible` is undefined (explicit)', () => {
    const btns = [
      { ...base.actionBtns[0]!, visible: undefined as unknown as boolean },
      ...base.actionBtns.slice(1)
    ] as unknown as ActionBtn[];
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/not visible.*undefined/);
  });

  it('fails when `visible` is the string "true" (loose type, not strict boolean)', () => {
    const btns = [
      ...base.actionBtns.slice(0, 2),
      { ...base.actionBtns[2]!, visible: 'true' as unknown as boolean }
    ] as unknown as ActionBtn[];
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/not visible/);
  });

  it('still passes when all three buttons are strictly visible === true', () => {
    // Sanity: the strict contract does not false-NEGATIVE the clean fixture.
    expect(actionsBarErrors(base, LABELS)).toEqual([]);
  });

  // The capture side (BOUNDS_JS) computes `visible` from rect + computed
  // style (display/visibility/opacity). A visibility:hidden element keeps a
  // positive box but must be captured as not visible; this test pins the
  // contract that the captured boolean reflects computed style, not box alone.
  // (The DOM integration of that computation is exercised by the capture run;
  // here we assert the predicate treats any non-true value as fail, which is
  // the property the capture side's computed-style branch relies on.)
  it('treats a positive-box button with visible=false as not visible', () => {
    const btns = mapBtns((b, i) => (i === 0 ? { ...b, visible: false } : b));
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, LABELS);
    expect(errs.join(' ')).toMatch(/not visible.*false/);
  });
});
