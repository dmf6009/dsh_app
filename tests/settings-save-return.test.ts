/**
 * Settings save-and-return contract (DSHA-4-PM-1, §37 "Settings 顶栏全局入口,
 * 保存后返回原页面").
 *
 * Two layers are covered here, both without a DOM:
 *   1. `providerSaveOutcome` — the decision the Settings page makes from a save
 *      result: return-and-confirm, or stay put with the inline error.
 *   2. `appReducer` — that decision applied to route state, asserting the user
 *      lands back on whichever page they opened Settings from.
 *
 * The renderer has no jsdom/@testing-library stack in this project, so the
 * navigation contract is pinned at the reducer + pure-function level rather than
 * by adding a DOM test dependency for one assertion.
 */

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_SAVED_FLASH,
  providerSaveOutcome,
  type OperationResult
} from '../src/shared/settings';
import {
  appReducer,
  initialAppState,
  type AppState,
  type Route
} from '../src/renderer/src/store/app-store';

/** State as it is right after the user opens Settings from `from`. */
function inSettingsFrom(from: Route): AppState {
  const onPage = appReducer(initialAppState, { type: 'navigate', route: from });
  const opened = appReducer(onPage, { type: 'open-settings' });
  expect(opened.route).toBe('settings');
  expect(opened.returnRoute).toBe(from);
  return opened;
}

/** Apply the outcome of a save result the way SettingsPage.save() does. */
function applySave(state: AppState, result: OperationResult): AppState {
  const outcome = providerSaveOutcome(result);
  return outcome.close ? appReducer(state, { type: 'close-settings', flash: outcome.flash }) : state;
}

const ORIGIN_ROUTES: readonly Route[] = ['home', 'workspace', 'diff'];

describe('providerSaveOutcome', () => {
  it('returns to the originating page with a confirmation on success', () => {
    const outcome = providerSaveOutcome({ ok: true });
    expect(outcome.close).toBe(true);
    if (!outcome.close) throw new Error('expected a closing outcome');
    expect(outcome.flash).toBe(PROVIDER_SAVED_FLASH);
    // The confirmation must be perceivable text, not an empty placeholder.
    expect(outcome.flash.trim().length).toBeGreaterThan(0);
  });

  it('stays in Settings and surfaces the inline error on failure', () => {
    const outcome = providerSaveOutcome({ ok: false, error: 'Base URL 无效' });
    expect(outcome.close).toBe(false);
    if (outcome.close) throw new Error('expected a non-closing outcome');
    expect(outcome.message).toEqual({ ok: false, text: 'Base URL 无效' });
  });

  it('falls back to a generic message when a failure carries no error text', () => {
    const outcome = providerSaveOutcome({ ok: false });
    expect(outcome.close).toBe(false);
    if (outcome.close) throw new Error('expected a non-closing outcome');
    expect(outcome.message.text).toBe('保存失败');
  });
});

describe('provider save returns to the originating page', () => {
  for (const from of ORIGIN_ROUTES) {
    it(`returns to ${from} after a successful save`, () => {
      const inSettings = inSettingsFrom(from);
      const afterSave = applySave(inSettings, { ok: true });

      expect(afterSave.route).toBe(from);
      // The confirmation rides along so it survives leaving Settings.
      expect(afterSave.flash).toBe(PROVIDER_SAVED_FLASH);
      // returnRoute is untouched, so reopening Settings still comes back here.
      expect(afterSave.returnRoute).toBe(from);
    });

    it(`stays in Settings when the save fails from ${from}`, () => {
      const inSettings = inSettingsFrom(from);
      const afterSave = applySave(inSettings, { ok: false, error: '写入凭据文件失败' });

      expect(afterSave.route).toBe('settings');
      expect(afterSave.returnRoute).toBe(from);
      // No confirmation on failure — the page shows the inline error instead.
      expect(afterSave.flash).toBeNull();
    });
  }

  it('keeps the confirmation out of Settings itself', () => {
    // Guards the render condition in App.tsx: a flash is only for the page
    // Settings returned to, never shown while Settings is open.
    const afterSave = applySave(inSettingsFrom('workspace'), { ok: true });
    expect(afterSave.route).not.toBe('settings');

    const reopened = appReducer(afterSave, { type: 'open-settings' });
    expect(reopened.route).toBe('settings');
    expect(reopened.flash).toBeNull();
  });
});

describe('flash lifecycle', () => {
  it('is dismissible', () => {
    const afterSave = applySave(inSettingsFrom('home'), { ok: true });
    expect(afterSave.flash).toBe(PROVIDER_SAVED_FLASH);

    const dismissed = appReducer(afterSave, { type: 'dismiss-flash' });
    expect(dismissed.flash).toBeNull();
    // Dismissing only clears the message; it does not navigate.
    expect(dismissed.route).toBe('home');
  });

  it('does not linger across navigation', () => {
    const afterSave = applySave(inSettingsFrom('diff'), { ok: true });
    const navigated = appReducer(afterSave, { type: 'navigate', route: 'home' });
    expect(navigated.flash).toBeNull();
  });
});

describe('existing Settings navigation is unchanged', () => {
  it('manual 返回 / gear close still returns without a confirmation', () => {
    for (const from of ORIGIN_ROUTES) {
      const closed = appReducer(inSettingsFrom(from), { type: 'close-settings' });
      expect(closed.route).toBe(from);
      // Manual close is not a save — it must not fabricate a success message.
      expect(closed.flash).toBeNull();
    }
  });

  it('clears a stale confirmation when Settings is closed manually', () => {
    const afterSave = applySave(inSettingsFrom('home'), { ok: true });
    const reopened = appReducer(afterSave, { type: 'open-settings' });
    const closed = appReducer(reopened, { type: 'close-settings' });
    expect(closed.route).toBe('home');
    expect(closed.flash).toBeNull();
  });

  it('opening Settings while already there is still a no-op', () => {
    const inSettings = inSettingsFrom('workspace');
    expect(appReducer(inSettings, { type: 'open-settings' })).toBe(inSettings);
  });

  it('preserves unrelated state across the save-and-return round trip', () => {
    // keep-alive contract: returning from Settings must not reset workspace,
    // recent projects, connection or command line.
    const base: AppState = {
      ...initialAppState,
      route: 'workspace',
      workspaceRoot: '/ws/project',
      commandLine: 'dsh --json',
      connection: 'ready'
    };
    const opened = appReducer(base, { type: 'open-settings' });
    const returned = applySave(opened, { ok: true });

    expect(returned.route).toBe('workspace');
    expect(returned.workspaceRoot).toBe('/ws/project');
    expect(returned.commandLine).toBe('dsh --json');
    expect(returned.connection).toBe('ready');
  });
});
