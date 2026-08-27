/**
 * Conflict-free X display allocation + ownership for the capture gate.
 *
 * The prior launcher used a FIXED display number (`:219`) and unconditionally
 * `rm -f`-ed `/tmp/.X11-unix/X219` on cleanup. That is a shared-resource
 * hazard: if another run (or a pre-existing X server) owns `:219`, a failed
 * start would DELETE that run's live socket. This module makes display use
 * SAFE under concurrency:
 *
 *  - Allocation is atomic: we scan for a display whose X11 socket does not
 *    exist AND whose lockfile we can create with O_EXCL (fail if it already
 *    exists). The lockfile is our ownership receipt; only the run that
 *    created it releases it.
 *  - An explicit `DSH_XVFB_DISPLAY` is honored ONLY if it is free (no socket,
 *    lock acquirable); if it is already in use the run FAILS CLOSED rather
 *    than clobbering someone else's server.
 *  - Socket cleanup is GATED ON OWNERSHIP: a socket is removed only when this
 *    run PROVED it created it — the socket did NOT exist immediately before
 *    we started our Xvfb, AND our Xvfb pid is the one that came up on it. If
 *    the socket pre-existed (someone else's server), we never touch it.
 *  - Xvfb normally removes its own socket on clean termination; residual
 *    removal is best-effort and only for sockets we own.
 *
 * Pure helpers (`socketPath`, `displayOccupied`, `acquireDisplay`,
 * `releaseDisplay`, `shouldCleanSocket`) are unit-tested without Xvfb; the
 * real allocation is exercised by tests/xvfb-display.integration.test.ts.
 */

import { openSync, closeSync, unlinkSync, existsSync, statSync, writeSync } from 'node:fs';
import process from 'node:process';

export const DEFAULT_MIN_DISPLAY = 200;
export const DEFAULT_MAX_DISPLAY = 320; // inclusive upper bound for the scan

/** The X11 Unix socket path for a display number. */
export function socketPath(num) {
  return `/tmp/.X11-unix/X${num}`;
}

/** The per-run ownership lockfile path for a display number. */
export function lockPath(num, opts = {}) {
  const dir = opts.lockDir || '/tmp';
  return `${dir}/dsh-capture-xvfb-${num}.lock`;
}

/** True if a display appears IN USE: its X11 socket exists. This is a
 * point-in-time probe; allocation must still acquire the lockfile atomically
 * to win the race against a concurrent run. */
export function displayOccupied(num) {
  try {
    return existsSync(socketPath(num));
  } catch {
    return false;
  }
}

/** Atomically acquire the ownership lockfile for `num` (O_EXCL creation).
 * Returns true on success, false if another run already holds it (EEXIST).
 * Never throws on EEXIST; rethrows other errors so callers can react. */
export function acquireDisplay(num, opts = {}) {
  const p = lockPath(num, opts);
  // 'wx' = O_WRONLY | O_CREAT | O_EXCL — fails with EEXIST if present.
  let fd;
  try {
    fd = openSync(p, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    // Record our pid for forensic visibility (best-effort write).
    const content = `pid=${process.pid}\n`;
    try {
      writeSync(fd, content);
    } catch { /* best effort */ }
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  return true;
}

/** Release (delete) the ownership lockfile for `num` — only meaningful if this
 * run created it. Best-effort; never throws. */
export function releaseDisplay(num, opts = {}) {
  try {
    unlinkSync(lockPath(num, opts));
  } catch { /* not ours or already gone */ }
}

/**
 * Find and atomically claim a free display in [min, max]. Returns the claimed
 * display number, or null if none could be claimed. A display is a candidate
 * when its X11 socket does not exist; we then try to acquire the lockfile
 * atomically. The combination (no socket + lock acquired) is the ownership
 * proof — a concurrent run that also scans will lose the O_EXCL race.
 *
 * `explicit` (a specific number from DSH_XVFB_DISPLAY) is handled by
 * `claimExplicit` — findFree is for auto-allocation only.
 */
export function findFreeDisplay(opts = {}) {
  const min = opts.min ?? DEFAULT_MIN_DISPLAY;
  const max = opts.max ?? DEFAULT_MAX_DISPLAY;
  for (let num = min; num <= max; num += 1) {
    if (displayOccupied(num)) continue; // someone's X server is up here
    if (acquireDisplay(num, opts)) return num;
    // lock held by another run that hasn't started its Xvfb yet — keep scanning
  }
  return null;
}

/**
 * Claim a SPECIFIC display number (from DSH_XVFB_DISPLAY). Succeeds only if the
 * display is free (no socket) AND the lockfile is acquirable. Returns true on
 * success, false if it is already in use (the run should then fail-closed,
 * NOT clobber the existing server). */
export function claimExplicit(num, opts = {}) {
  if (displayOccupied(num)) return false; // pre-existing/another run's server
  return acquireDisplay(num, opts);
}

/** Snapshot whether this run's socket ALREADY existed before we started our
 * Xvfb. If it existed, we did NOT create it → we must never delete it. */
export function socketExistedBefore(num) {
  return displayOccupied(num);
}

/** Decide whether this run may remove the X11 socket for `num`. We remove
 * only when we PROVED ownership: the socket did NOT exist before our Xvfb
 * started (`socketExistedBefore === false`), AND our Xvfb pid was the one that
 * came up on it (`xvfbPidAlive` true at ownership time). If the socket
 * pre-existed, we leave it untouched. */
export function shouldCleanSocket({ num, socketExistedBefore, xvfbPidAlive }) {
  if (socketExistedBefore === true) return false; // not ours — someone else's
  if (!xvfbPidAlive) return false; // can't prove our server made it
  return true; // proven ours: didn't exist before, our pid came up
}
