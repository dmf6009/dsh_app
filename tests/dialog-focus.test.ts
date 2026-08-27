/**
 * Dialog focus-management tests (DSHA-6 P1-1 UI/UE review fix): focus trap
 * cycling, stage-1 initial focus selection, and busy-close gating — verified
 * in node with structural fakes (no DOM/React required).
 */

import { describe, expect, it } from 'vitest';

import {
  FOCUSABLE_SELECTOR,
  collectFocusables,
  cycleFocusIndex,
  ignoreCloseWhileBusy,
  pickInitialFocus,
  type Focusable,
  type DialogLike
} from '../src/renderer/src/components/dialog-focus';

function makeFocusable(label: string): Focusable & { label: string } {
  const f = { label, focus: () => undefined };
  return f;
}

describe('cycleFocusIndex (focus trap)', () => {
  it('advances forward and wraps from last to first', () => {
    expect(cycleFocusIndex(3, 0, false)).toBe(1);
    expect(cycleFocusIndex(3, 1, false)).toBe(2);
    expect(cycleFocusIndex(3, 2, false)).toBe(0); // wrap
  });

  it('wraps backward from first to last (Shift+Tab)', () => {
    expect(cycleFocusIndex(3, 2, true)).toBe(1);
    expect(cycleFocusIndex(3, 0, true)).toBe(2); // wrap
  });

  it('single-element dialogs stay on the one element in both directions', () => {
    expect(cycleFocusIndex(1, 0, false)).toBe(0);
    expect(cycleFocusIndex(1, 0, true)).toBe(0);
  });

  it('no focusable elements yields -1 (nothing to trap)', () => {
    expect(cycleFocusIndex(0, 0, false)).toBe(-1);
    expect(cycleFocusIndex(0, -1, true)).toBe(-1);
  });

  it('unfocused state (current=-1) lands on first for Tab, last for Shift+Tab', () => {
    expect(cycleFocusIndex(3, -1, false)).toBe(0);
    expect(cycleFocusIndex(3, -1, true)).toBe(2);
  });
});

describe('pickInitialFocus (stage 1 safe action)', () => {
  const a = makeFocusable('a');
  const b = makeFocusable('b');
  const cancel = makeFocusable('cancel');

  it('prefers the safe/cancel element when present', () => {
    expect(pickInitialFocus([a, b, cancel], cancel)).toBe(cancel);
  });

  it('falls back to the first focusable (never a later destructive one)', () => {
    expect(pickInitialFocus([a, b], null)).toBe(a);
  });

  it('returns null when there is nothing to focus', () => {
    expect(pickInitialFocus([], null)).toBeNull();
  });
});

describe('ignoreCloseWhileBusy', () => {
  it('blocks Esc/backdrop dismissal exactly while busy', () => {
    expect(ignoreCloseWhileBusy(true)).toBe(true);
    expect(ignoreCloseWhileBusy(false)).toBe(false);
  });
});

describe('collectFocusables', () => {
  it('queries the dialog with the focusable selector and returns elements in order', () => {
    const a = makeFocusable('a');
    const b = makeFocusable('b');
    let seenSelector = '';
    const dialog: DialogLike = {
      querySelectorAll(selector) {
        seenSelector = selector;
        return [a, b];
      }
    };
    expect(collectFocusables(dialog)).toEqual([a, b]);
    expect(seenSelector).toBe(FOCUSABLE_SELECTOR);
  });

  it('focusable selector excludes disabled buttons', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
});
