/**
 * Unit tests for the capture-harness assertion gate (DSHA-6 UI/UE review fix).
 * These prove the gate FAILS on the real acceptance regressions the reviewer
 * flagged (zero-size toolbar, missing/zero-size buttons, overlapping pairs) —
 * not just on an injected constant-false condition.
 */

import { describe, expect, it } from 'vitest';

import {
  actionsBarErrors,
  noHScrollErrors,
  rectInViewport,
  rectVisible,
  toolbarErrors
} from '../scripts/capture/assertions.mjs';

const VW = 500;
const base = {
  viewport: { w: VW, h: 400 },
  noPageHScroll: true,
  pageScrollWidth: VW,
  pageClientWidth: VW,
  toolbar: { x: 0, y: 0, w: VW, h: 40, visible: true },
  actionBtns: [
    { text: '↑ 上一个', x: 0, y: 0, w: 80, h: 28 },
    { text: '↓ 下一个', x: 90, y: 0, w: 80, h: 28 },
    { text: '恢复此文件…', x: 180, y: 0, w: 90, h: 28 }
  ]
};

describe('rectVisible / rectInViewport', () => {
  it('requires visible + non-zero size', () => {
    expect(rectVisible({ x: 0, y: 0, w: 10, h: 10, visible: true })).toBe(true);
    expect(rectVisible(null)).toBe(false);
    expect(rectVisible({ x: 0, y: 0, w: 0, h: 10, visible: true })).toBe(false); // zero width
    expect(rectVisible({ x: 0, y: 0, w: 10, h: 0, visible: true })).toBe(false); // zero height
    expect(rectVisible({ x: 0, y: 0, w: 10, h: 10, visible: false })).toBe(false); // hidden
  });

  it('checks containment within the viewport width', () => {
    expect(rectInViewport({ x: 0, y: 0, w: 100, h: 10, visible: true }, 500)).toBe(true);
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

  it('fails when the toolbar spills outside the viewport', () => {
    expect(
      toolbarErrors({ ...base, toolbar: { x: 400, y: 0, w: 200, h: 40, visible: true } })
    ).not.toEqual([]);
  });
});

describe('actionsBarErrors (review gaps #2/#3)', () => {
  const labels = ['↑ 上一个', '↓ 下一个', '恢复此文件…'];

  it('passes with exactly 3 visible non-overlapping buttons', () => {
    expect(actionsBarErrors(base, labels)).toEqual([]);
  });

  it('fails when fewer than the expected buttons are present', () => {
    expect(actionsBarErrors({ ...base, actionBtns: base.actionBtns.slice(0, 2) }, labels)).not.toEqual([]);
    expect(actionsBarErrors({ ...base, actionBtns: [] }, labels)).not.toEqual([]);
  });

  it('fails when a button has zero size', () => {
    const btns = base.actionBtns.map((b, i) => (i === 1 ? { ...b, w: 0 } : b));
    expect(actionsBarErrors({ ...base, actionBtns: btns }, labels)).not.toEqual([]);
  });

  it('fails when any pair of buttons overlaps', () => {
    const btns = base.actionBtns.map((b, i) => (i === 2 ? { ...b, x: 100 } : b)); // overlaps the 2nd
    const errs = actionsBarErrors({ ...base, actionBtns: btns }, labels);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/overlap|↔/);
  });

  it('fails when a button is outside the viewport', () => {
    const btns = base.actionBtns.map((b, i) => (i === 2 ? { ...b, x: 480, w: 90 } : b)); // 480+90 > 500
    expect(actionsBarErrors({ ...base, actionBtns: btns }, labels)).not.toEqual([]);
  });
});
