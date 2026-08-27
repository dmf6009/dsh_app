/**
 * Token-based X display ownership for the capture gate.
 *
 * Earlier iterations had a cleanup race: the launcher released the display
 * lockfile BEFORE unlinking the X11 socket. A run B that won the freed lock
 * could start its Xvfb and create the same-named socket in the window between
 * A's release and A's socket unlink — then A's late cleanup would delete B's
 * live socket. The historical "I created this socket" boolean was only proof
 * AT START TIME, not at unlink time.
 *
 * This module models a claim as an UNFORGEABLE owner token (a UUID written into
 * the lockfile) and makes cleanup a COMPARE-AND-RELEASE critical section:
 *
 *  - acquireDisplay returns a token (the claim handle). Only the run holding
 *    the current token is the owner.
 *  - cleanOwnedSocket re-reads the lockfile and unlinks the X11 socket ONLY IF
 *    the lock still carries OUR token — i.e. we still own the claim at unlink
 *    time. Because releaseOwned happens AFTER cleanOwnedSocket, no run B can
 *    win the lock (and start its Xvfb) until our socket cleanup is done.
 *  - releaseOwned is compare-and-release: it deletes the lockfile ONLY IF its
 *    current token still matches ours. A late/duplicate cleanup whose token no
 *    longer matches (a new owner took over) is a no-op — it cannot delete the
 *    new owner's lock.
 *  - Stale-lock reclamation: if a lockfile exists but its recorded pid is dead
 *    (crashed run), a new run may reclaim the display with a fresh token
 *    (acquireStale), verifying the old owner is truly gone first.
 *
 * Pure helpers are unit-tested without Xvfb; real allocation/concurrency is
 * covered by tests/xvfb-display.test.ts and tests/xvfb-display.integration.test.ts.
 */

import { openSync, closeSync, unlinkSync, existsSync, readFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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

/** True if a display appears IN USE: its X11 socket exists. Point-in-time probe;
 * allocation must still acquire the lockfile atomically. */
export function displayOccupied(num) {
  try {
    return existsSync(socketPath(num));
  } catch {
    return false;
  }
}

/** A fresh, unforgeable owner token for a new claim. */
export function newOwnerToken() {
  return randomUUID();
}

/** Read the current owner of a display's lockfile. Returns
 * `{ token, pid } | null` (null if no lockfile or unreadable). Never throws. */
export function readOwner(num, opts = {}) {
  try {
    const txt = readFileSync(lockPath(num, opts), 'utf8');
    // Lines: first line = token, "pid=<n>" line = owner pid.
    const lines = txt.split('\n');
    const token = (lines[0] || '').trim();
    let pid = null;
    for (const l of lines) {
      const m = /^pid=(\d+)$/.exec(l);
      if (m) pid = parseInt(m[1], 10);
    }
    if (!token) return null;
    return { token, pid };
  } catch {
    return null;
  }
}

/** Atomically acquire the ownership lockfile for `num` with a fresh token.
 * Returns the token (string) on success, or null if another run already holds
 * it (EEXIST). Never throws on EEXIST; rethrows other errors. */
export function acquireDisplay(num, opts = {}) {
  const p = lockPath(num, opts);
  const token = newOwnerToken();
  let fd;
  try {
    fd = openSync(p, 'wx'); // O_CREAT | O_EXCL — fails EEXIST if present
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw err;
  }
  try {
    const content = `${token}\npid=${process.pid}\n`;
    try {
      writeSync(fd, content);
    } catch { /* best effort */ }
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  return token;
}

/**
 * Reclaim a STALE lockfile whose owner pid is dead (a crashed prior run).
 * Reclaims ONLY if: the lockfile exists, its recorded pid is set and is NOT
 * alive, and we can atomically replace it with our own token. Returns the new
 * token or null. We NEVER reclaim a lock whose owner is still alive — that
 * would steal a live run's claim.
 *
 * Implementation: rename-then-write is not atomic across the existing file; we
 * instead unlink the stale lock (safe: owner is dead) then O_EXCL-create ours.
 * The unlink+create is two steps, but because the prior owner is provably
 * dead, no live run races us for THIS exact stale lock; a concurrent NEW run
 * would have lost the O_EXCL on the original and be scanning other displays.
 */
export function acquireStale(num, opts = {}, isPidAlive = defaultIsPidAlive) {
  const owner = readOwner(num, opts);
  if (!owner) return null; // no lockfile — caller should use acquireDisplay
  if (owner.pid === null) return null; // can't prove owner dead — leave it
  if (isPidAlive(owner.pid)) return null; // owner still alive — do NOT steal
  // Owner is dead: safe to reclaim.
  try {
    unlinkSync(lockPath(num, opts));
  } catch {
    return null; // someone else removed it; let caller retry acquireDisplay
  }
  return acquireDisplay(num, opts);
}

/** Default liveness check (signal 0). */
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare-and-release: delete the lockfile for `num` ONLY IF its current owner
 * token still equals `token`. If the lock was already released, or a NEW owner
 * took over (token differs), this is a NO-OP — we must not delete the new
 * owner's lock. Best-effort; never throws. Returns true if we released it.
 */
export function releaseOwned(num, token, opts = {}) {
  if (!token) return false;
  const owner = readOwner(num, opts);
  if (!owner) return false; // lock gone — nothing to release
  if (owner.token !== token) return false; // a new owner took over — NOT ours
  try {
    unlinkSync(lockPath(num, opts));
  } catch {
    return false;
  }
  return true;
}

/**
 * Decide whether this run may remove the X11 socket for `num` at START time.
 * We remove only when we PROVED we created it: the socket did NOT exist before
 * our Xvfb started (socketExistedBefore === false) AND our Xvfb pid was the one
 * that came up (xvfbPidAlive true at ownership time). This is a NECESSARY but
 * not sufficient condition — cleanOwnedSocket re-verifies ownership at unlink
 * time too.
 */
export function shouldCleanSocket({ socketExistedBefore, xvfbPidAlive }) {
  if (socketExistedBefore === true) return false; // not ours — someone else's
  if (!xvfbPidAlive) return false; // can't prove our server made it
  return true;
}

/**
 * Remove the X11 socket for `num` ONLY IF we STILL own the claim at unlink
 * time. This is the critical race fix: we re-read the lockfile and require its
 * current token to equal `token`. Because releaseOwned is called AFTER this,
 * no concurrent run B can have won the lock and started its own Xvfb on this
 * display yet (the lock still carries our token). A late/duplicate cleanup
 * whose token no longer matches the lockfile is a no-op and must not unlink
 * the socket (B may own it now).
 *
 * Precondition: shouldCleanSocket(...) was true at start time (we created it).
 * Returns true if the socket was removed by us.
 */
export function cleanOwnedSocket({ num, token, socketExistedBefore, xvfbPidAlive }, opts = {}) {
  if (!shouldCleanSocket({ socketExistedBefore, xvfbPidAlive })) return false;
  if (!token) return false;
  // Re-verify ownership at unlink time: the lock must still carry OUR token.
  const owner = readOwner(num, opts);
  if (!owner) return false; // our lock is gone — we may have already released; a
  // new owner could be mid-claim. Do NOT unlink.
  if (owner.token !== token) return false; // a new owner took over — their socket now
  try {
    const sock = socketPath(num);
    if (!existsSync(sock)) return false; // Xvfb already removed it
    unlinkSync(sock);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find and atomically claim a free display in [min, max]. Returns the claimed
 * display number and token, or null if none could be claimed. A display is a
 * candidate when its X11 socket does not exist; we then try to acquire the
 * lockfile atomically (O_EXCL). If a lockfile exists but its owner pid is dead,
 * we reclaim it (acquireStale). Returns `{ num, token }` or `null`.
 */
export function findFreeDisplay(opts = {}) {
  const min = opts.min ?? DEFAULT_MIN_DISPLAY;
  const max = opts.max ?? DEFAULT_MAX_DISPLAY;
  for (let num = min; num <= max; num += 1) {
    if (displayOccupied(num)) continue; // someone's X server is up here
    let token = acquireDisplay(num, opts);
    if (token === null) {
      // Lock held — maybe stale. Try reclaiming if the owner is dead.
      token = acquireStale(num, opts);
      if (token === null) continue; // live owner — keep scanning
    }
    return { num, token };
  }
  return null;
}

/**
 * Claim a SPECIFIC display number (from DSH_XVFB_DISPLAY). Succeeds only if the
 * display is free (no socket) AND the lockfile is acquirable (or a stale,
 * dead-owner lock is reclaimable). Returns `{ num, token }` on success, or null
 * if it is already in use (fail-closed — do NOT clobber the existing server).
 */
export function claimExplicit(num, opts = {}) {
  if (displayOccupied(num)) return null; // pre-existing/another run's server
  let token = acquireDisplay(num, opts);
  if (token === null) {
    token = acquireStale(num, opts); // reclaim a dead-owner lock if any
    if (token === null) return null;
  }
  return { num, token };
}

/** Snapshot whether this run's socket ALREADY existed before we started our
 * Xvfb. If it existed, we did NOT create it → we must never delete it. */
export function socketExistedBefore(num) {
  return displayOccupied(num);
}
