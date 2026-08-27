/**
 * Unit tests for the capture-gate launcher's pure decision logic
 * (scripts/capture/launcher.mjs). These prove the gate command is FAIL-CLOSED:
 * a missing Electron binary, missing build artifact, or missing xvfb must
 * produce a non-zero exit (never a green-looking SKIP), and a timeout / signal
 * / spawn error from the Electron child must propagate as non-zero. No fs or
 * spawn is touched — the helpers are pure so this runs in plain node.
 */

import { describe, expect, it } from 'vitest';

import { preflightErrors, spawnPlan, exitCode, DEFAULT_TIMEOUT_MS } from '../scripts/capture/launcher.mjs';

describe('preflightErrors (fail-closed on missing run deps)', () => {
  const ok = {
    electronPath: '/bin/electron',
    electronExists: true,
    indexExists: true,
    xvfbNeeded: false,
    xvfbAvailable: true
  };

  it('passes when every dependency is present', () => {
    expect(preflightErrors(ok)).toEqual([]);
  });

  it('FAILS when the Electron binary path is missing (require(electron) unresolved)', () => {
    const errs = preflightErrors({ ...ok, electronPath: null });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/Electron binary path is missing/);
  });

  it('FAILS when the Electron binary is not on disk (postinstall blocked)', () => {
    const errs = preflightErrors({ ...ok, electronPath: '/bin/electron', electronExists: false });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/Electron binary not found on disk/);
  });

  it('FAILS when the built renderer entry is missing (no build artifact)', () => {
    const errs = preflightErrors({ ...ok, indexExists: false });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/dist\/renderer\/index.html is missing/);
  });

  it('FAILS when xvfb is needed but unavailable (display-less Linux)', () => {
    const errs = preflightErrors({ ...ok, xvfbNeeded: true, xvfbAvailable: false });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toMatch(/xvfb-run is not available/);
  });

  it('reports MULTIPLE missing dependencies at once (not just the first)', () => {
    const errs = preflightErrors({
      electronPath: null,
      electronExists: false,
      indexExists: false,
      xvfbNeeded: false,
      xvfbAvailable: true
    });
    // electron path missing + index missing (electronExists is moot when path is null)
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT require xvfb when DISPLAY is set (xvfbNeeded false)', () => {
    expect(preflightErrors({ ...ok, xvfbNeeded: false, xvfbAvailable: false })).toEqual([]);
  });
});

describe('spawnPlan', () => {
  it('uses xvfb-run on Linux without a DISPLAY', () => {
    const p = spawnPlan({ platform: 'linux', hasDisplay: false });
    expect(p.useXvfb).toBe(true);
    expect(p.extraElectronArgs).toEqual(['--no-sandbox', '--disable-dev-shm-usage']);
  });

  it('launches Electron directly on Linux when DISPLAY is set', () => {
    const p = spawnPlan({ platform: 'linux', hasDisplay: true });
    expect(p.useXvfb).toBe(false);
  });

  it('launches Electron directly on macOS', () => {
    const p = spawnPlan({ platform: 'darwin', hasDisplay: true });
    expect(p.useXvfb).toBe(false);
  });

  it('honors DSH_ELECTRON_ARGS override on Linux (no default --no-sandbox)', () => {
    const p = spawnPlan({ platform: 'linux', hasDisplay: false, electronArgsEnv: '--no-sandbox --foo' });
    expect(p.useXvfb).toBe(true);
    expect(p.extraElectronArgs).toEqual(['--no-sandbox', '--foo']);
  });

  it('splits DSH_ELECTRON_ARGS by whitespace and drops empties', () => {
    const p = spawnPlan({ platform: 'linux', hasDisplay: true, electronArgsEnv: '  --a   --b  ' });
    expect(p.extraElectronArgs).toEqual(['--a', '--b']);
  });
});

describe('exitCode (fail-closed propagation)', () => {
  it('returns the child status on a clean run', () => {
    expect(exitCode({ status: 0, signal: null, error: null, timedOut: false })).toBe(0);
    expect(exitCode({ status: 1, signal: null, error: null, timedOut: false })).toBe(1);
    expect(exitCode({ status: 42, signal: null, error: null, timedOut: false })).toBe(42);
  });

  it('returns 1 on timeout (wedged child must not fake green)', () => {
    expect(exitCode({ status: null, signal: 'SIGTERM', error: null, timedOut: true })).toBe(1);
    // Even if status somehow arrived alongside a timeout, timeout wins.
    expect(exitCode({ status: 0, signal: null, error: null, timedOut: true })).toBe(1);
  });

  it('returns 1 on the REAL spawnSync timeout shape (error.code ETIMEDOUT, NO timedOut field)', () => {
    // The review established that spawnSync sets error.code === 'ETIMEDOUT'
    // and signal === 'SIGTERM', and does NOT set a `timedOut` field (it is
    // undefined). The gate must detect this shape, not the phantom field.
    const realSpawnSyncTimeout = {
      status: null,
      signal: 'SIGTERM',
      error: { code: 'ETIMEDOUT', message: 'Command timed out' },
      timedOut: undefined as boolean | undefined
    };
    expect(exitCode(realSpawnSyncTimeout)).toBe(1);
    expect(realSpawnSyncTimeout.timedOut).toBeUndefined();
  });

  it('returns 1 on a kill signal (SIGTERM/SIGKILL)', () => {
    expect(exitCode({ status: null, signal: 'SIGTERM', error: null, timedOut: false })).toBe(1);
    expect(exitCode({ status: null, signal: 'SIGKILL', error: null, timedOut: false })).toBe(1);
  });

  it('returns 1 on a spawn error (e.g. ERR_FILE_NOT_FOUND crash, no status)', () => {
    expect(exitCode({ status: null, signal: null, error: { message: 'boom' }, timedOut: false })).toBe(1);
  });

  it('returns 1 when status is not a number (child did not exit cleanly)', () => {
    expect(exitCode({ status: null, signal: null, error: null, timedOut: false })).toBe(1);
  });
});

describe('DEFAULT_TIMEOUT_MS', () => {
  it('is a positive, finite number (bounds the gate run)', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_TIMEOUT_MS)).toBe(true);
  });
});
