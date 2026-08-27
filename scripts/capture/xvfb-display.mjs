/**
 * Token-based X display ownership for the capture gate.
 *
 * A claim is an UNFORGEABLE owner TOKEN (a UUID — never reused) plus the
 * owner's pid as a LIVENESS HINT (NOT as identity; the OS reuses pids, so the
 * token is the authoritative identity and the pid is only consulted to decide
 * liveness for stale reclaim). The hard problem is TOCTOU/double-success under
 * concurrent acquire and stale reclaim; this iteration finally makes the claim
 * a single atomic publication with no empty-window double-success.
 *
 * ── The atomic publication protocol ─────────────────────────────────────────
 * The lock is a single FILE at lockPath(num). Its CONTENTS are the owner
 * identity (`<token>\npid=<pid>\n`). Publication is a single kernel-atomic
 * `openSync(lockPath, 'wx')` (O_CREAT|O_EXCL): the file is created AND an
 * exclusive fd is opened in one atomic step — only one caller succeeds, all
 * others get EEXIST. The owner contents are written THROUGH that exclusive fd
 * immediately; if the write fails, the file is unlinked (via the fd's path,
 * which no other process can have O_EXCL-created at in the meantime because
 * the file exists) and the call returns null — NEVER returns a token for a
 * claim whose owner could not be published. There is no instant at which the
 * lock path holds a "claimed but owner-less" file that another caller could
 * mistake for a reclaimable stale lock: a freshly-O_EXCL'd file either soon
 * carries owner contents (a LIVE claim) or is unlinked (rolled back).
 *
 *  - acquireDisplay (fresh): O_EXCL create + write owner via fd. Linearization
 *    point = the O_EXCL success (one winner). Write failure → unlink via fd,
 *    return null (fail-closed, no orphan).
 *
 *  - acquireStale (reclaim a dead-owner lock): read the lock file's owner. A
 *    lock with NO owner (empty/unreadable) is NOT reclaimable — it may be a
 *    fresh acquire mid-publication (the O_EXCL just succeeded, owner write is
 *    pending); reclaiming it would delete a just-succeeded claim. ONLY a lock
 *    whose recorded owner pid is provably DEAD is reclaimable. Before unlinking,
 *    the reclaimer RE-VERIFIES (re-open, re-read) that the lock still carries
 *    the SAME dead owner it first read — closing the stale-judgment-staleness
 *    window where a sibling reclaimer already installed a LIVE claim: the
 *    re-check sees the live pid and refuses, never unlinking the sibling's live
 *    lock. Then unlink + O_EXCL-recreate (the O_EXCL is the linearization point
 *    — one winner). Two reclaimers of the same dead lock both unlink it, but
 *    only ONE's O_EXCL succeeds. PID REUSE: the pid is a liveness HINT; if a
 *    dead owner's pid was reused by a live process, isPidAlive returns true and
 *    we do NOT reclaim (stale-lock leak, NOT a double-owner bug). The token
 *    (never reused) is the identity; the pid never authorizes reclaim alone.
 *
 *  - releaseOwned: open the lock 'r' (fd anchors the inode), read the token
 *    THROUGH the fd. If it is not ours, return false (a late/duplicate release
 *    sees the new owner's token via the fd and bails — the fd read is anchored
 *    to the inode we opened, not "whatever is at the path now"). If ours,
 *    unlink the lock path. This is safe because a NEW owner can only appear
 *    via O_EXCL after the path is empty — and the path is empty only after OUR
 *    unlink; a concurrent reclaimer refuses while we are live (our pid is
 *    alive), so there is no path replacement during a LIVE owner's release. No
 *    tombstone, no restore-rename, no window to cover a third party's lock.
 *    Always returns a boolean.
 *
 *  - cleanOwnedSocket: same fd-anchored token re-verify, then unlink the X11
 *    socket (a DIFFERENT path). A new owner can only reclaim after our pid
 *    dies; we are live during cleanup, so no concurrent new owner installs a
 *    socket under our nose. Always returns a boolean.
 *
 * Pure helpers are unit-tested without Xvfb; real allocation/concurrency is
 * covered by tests/xvfb-display.test.ts and tests/xvfb-display.integration.test.ts.
 */

import {
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
  writeSync,
  readSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

export const DEFAULT_MIN_DISPLAY = 200;
export const DEFAULT_MAX_DISPLAY = 320; // inclusive upper bound for the scan

/** The X11 Unix socket path for a display number. */
export function socketPath(num) {
  return `/tmp/.X11-unix/X${num}`;
}

/** The per-display ownership LOCK FILE path. The lock is a single file whose
 * contents are the owner identity (`<token>\npid=<pid>\n`). */
export function lockPath(num, opts = {}) {
  const dir = opts.lockDir || '/tmp';
  return `${dir}/dsh-capture-xvfb-${num}.lock`;
}

/** True if a display appears IN USE: its X11 socket exists. Point-in-time probe;
 * allocation must still acquire the lock atomically. */
export function displayOccupied(num) {
  try {
    return existsSync(socketPath(num));
  } catch {
    return false;
  }
}

/** A fresh, unforgeable owner token for a new claim. UUID — never reused. */
export function newOwnerToken() {
  return randomUUID();
}

/** Read the current owner of a display's lock file BY PATH. Returns
 * `{ token, pid } | null` — null if no lock file, or the file is empty/
 * unreadable (a fresh acquire mid-publication whose owner write is pending).
 * Point-in-time path read; the CAS operations use readOwnerViaFd for fd-anchored
 * identity. Never throws. */
export function readOwner(num, opts = {}) {
  let fd;
  try {
    fd = openSync(lockPath(num, opts), 'r');
  } catch {
    return null; // no lock file
  }
  try {
    return readOwnerViaFd(fd);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Read the owner THROUGH an open fd (fd-anchored identity). The token+pid are
 * read from the inode the fd is bound to, NOT "whatever is at the path now".
 * Returns `{ token, pid } | null` (null if empty/unreadable). Never throws. */
function readOwnerViaFd(fd) {
  try {
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    if (n === 0) return null; // empty file — fresh acquire mid-publication
    return parseOwner(buf.subarray(0, n).toString('utf8'));
  } catch {
    return null;
  }
}

/** Parse owner `{ token, pid } | null` from lockfile text. */
function parseOwner(txt) {
  const lines = txt.split('\n');
  const token = (lines[0] || '').trim();
  let pid = null;
  for (const l of lines) {
    const m = /^pid=(\d+)$/.exec(l);
    if (m) pid = parseInt(m[1], 10);
  }
  if (!token) return null;
  return { token, pid };
}

/**
 * Atomically acquire the ownership lock for `num` with a fresh token (fresh
 * install — the lock file must NOT exist). The O_EXCL create is the single
 * linearization point: one winner (returns the token), losers get EEXIST
 * (return null). The owner contents are written THROUGH the exclusive fd; if
 * the write fails, the file is unlinked (rolled back) and the call returns
 * null — NEVER returns a token for a claim whose owner could not be published.
 * Never throws on EEXIST; rethrows unexpected errors.
 *
 * The owner contents are written THROUGH the exclusive fd; if the write fails,
 * the file is unlinked (rolled back) and the call returns null — NEVER returns
 * a token for a claim whose owner could not be published. Never throws on
 * EEXIST; rethrows unexpected errors.
 */
export function acquireDisplay(num, opts = {}) {
  const p = lockPath(num, opts);
  const token = newOwnerToken();
  let fd;
  try {
    fd = openSync(p, 'wx'); // O_CREAT | O_EXCL — atomic; one winner
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw err;
  }
  try {
    writeSync(fd, `${token}\npid=${process.pid}\n`);
  } catch {
    // Owner publication FAILED. Roll back the just-created file so no orphan
    // "claimed but owner-less" lock remains, and fail-closed (return null).
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(p); } catch { /* best effort */ }
    return null;
  }
  try { closeSync(fd); } catch { /* ignore */ }
  return token;
}

/**
 * Reclaim a lock whose owner pid is dead (a crashed prior run). The lock file
 * exists. Returns a fresh token on success, or null if a LIVE owner holds the
 * lock, OR if the lock has NO owner (empty/unreadable — a fresh acquire mid-
 * publication; reclaiming it would delete a just-succeeded claim).
 *
 * TOCTOU/double-success-safe: reclaim is ONLY attempted for a lock whose owner
 * pid is provably DEAD. The unlink + O_EXCL-recreate has its linearization
 * point at the O_EXCL: two reclaimers of the same dead lock both unlink it, but
 * only ONE's O_EXCL succeeds (the other gets EEXIST → null). A fresh acquirer
 * that wins the O_EXCL after our unlink also makes our O_EXCL fail. There is no
 * window for double-success because the O_EXCL is the single arbiter and an
 * owner-less (empty) lock is NEVER treated as reclaimable.
 *
 * PID REUSE: the pid is a liveness HINT only. If a dead owner's pid was reused
 * by a live process, isPidAlive returns true and we do NOT reclaim (stale-lock
 * leak, not double-owner). The token (never reused) is identity; the pid never
 * authorizes reclaim alone.
 *
 * Test hook: DSH_RECLAIM_BARRIER pauses AFTER the dead-owner judgment, BEFORE
 * the unlink — letting the adversarial test force both reclaimers to have
 * judged dead before either installs.
 */
export function acquireStale(num, opts = {}, isPidAlive = defaultIsPidAlive) {
  const p = lockPath(num, opts);
  let fd;
  try {
    fd = openSync(p, 'r');
  } catch {
    return null; // no lock file — caller should use acquireDisplay
  }
  let owner;
  try {
    owner = readOwnerViaFd(fd);
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  if (!owner) return null; // owner-less (empty) lock — NOT reclaimable (fresh acquire mid-publication)
  if (owner.pid === null) return null; // can't prove owner dead — leave it
  if (isPidAlive(owner.pid)) return null; // owner still alive (or pid reused by a live proc) — do NOT steal
  // Owner is dead. Test hook: pause after the dead judgment, before unlink.
  const reclaimBarrier = process.env.DSH_RECLAIM_BARRIER;
  if (reclaimBarrier) waitForFile(reclaimBarrier, 30000);
  // RE-VERIFY before unlinking: another reclaimer may have already reclaimed
  // (installed a LIVE owner) between our first read and now. Re-open the lock
  // and re-read the owner; if it is now LIVE (or owner-less/changed), do NOT
  // unlink — bail. This closes the stale-judgment-staleness window: a reclaimer
  // that judged "dead" before a sibling installed a live claim re-checks and
  // refuses, never unlinking the sibling's live lock. (The re-check→unlink gap
  // is itself a window, but a LIVE owner's lock cannot be unlinked here because
  // a live owner blocks reclaim on the re-check; and a fresh acquirer cannot
  // O_EXCL while our stale file still occupies the path — it can only install
  // AFTER our unlink, by which point our O_EXCL is the arbiter.)
  let reFd;
  try {
    reFd = openSync(p, 'r');
  } catch {
    return null; // lock gone between reads — let caller retry acquireDisplay
  }
  let reOwner;
  try {
    reOwner = readOwnerViaFd(reFd);
  } finally {
    try { closeSync(reFd); } catch { /* ignore */ }
  }
  if (!reOwner || reOwner.token !== owner.token || reOwner.pid !== owner.pid) {
    // The lock changed under us (another reclaimer installed a live claim, or
    // the file was replaced). Do NOT unlink — bail.
    return null;
  }
  if (reOwner.pid !== null && isPidAlive(reOwner.pid)) {
    // Owner is now live (a sibling reclaimed). Do NOT steal. Bail.
    return null;
  }
  // Unlink the dead-owner lock (re-verified still the same dead owner).
  try {
    unlinkSync(p);
  } catch {
    return null; // someone else removed it; let caller retry acquireDisplay
  }
  // O_EXCL recreate — the single linearization point. One winner.
  return acquireDisplay(num, opts);
}

/** Test hook: wait until `p` exists (bounded). No-op when p is never created. */
function waitForFile(p, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(p)) return true;
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin 20ms */ }
  }
  return false;
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
 * Release THIS run's ownership of `num` (only if we still hold it). Open the
 * lock 'r' (fd anchors the inode), read the token THROUGH the fd. If it is not
 * ours, return false (a late/duplicate release sees the new owner's token via
 * the fd and bails — the fd read is anchored to the inode we opened, not
 * "whatever is at the path now"). If ours, unlink the lock path.
 *
 * Safe under concurrency: a NEW owner can only appear via O_EXCL after the path
 * is empty — and the path is empty only after OUR unlink. A concurrent
 * reclaimer refuses while we are live (our pid is alive), so there is no path
 * replacement during a LIVE owner's release. No tombstone, no restore-rename,
 * no window to cover a third party's lock. Always returns a boolean.
 */
export function releaseOwned(num, token, opts = {}) {
  if (!token) return false;
  const p = lockPath(num, opts);
  let fd;
  try {
    fd = openSync(p, 'r');
  } catch {
    return false; // lock gone — nothing to release
  }
  try {
    const owner = readOwnerViaFd(fd);
    if (!owner || owner.token !== token) return false; // not ours (new owner took over)
    try {
      unlinkSync(p);
    } catch {
      return false;
    }
    return true;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Decide whether this run may remove the X11 socket for `num` at START time.
 * We remove only when we PROVED we created it: the socket did NOT exist before
 * our Xvfb started (socketExistedBefore === false) AND our Xvfb pid was the one
 * that came up (xvfbPidAlive true at ownership time). Necessary but not
 * sufficient — cleanOwnedSocket re-verifies ownership at unlink time too.
 */
export function shouldCleanSocket({ socketExistedBefore, xvfbPidAlive }) {
  if (socketExistedBefore === true) return false; // not ours — someone else's
  if (!xvfbPidAlive) return false; // can't prove our server made it
  return true;
}

/**
 * Remove the X11 socket for `num` ONLY IF we STILL own the claim at unlink
 * time. fd-anchored token re-verify (open the lock 'r', read the token THROUGH
 * the fd). Because a new owner B can only reclaim after A's pid dies, and A is
 * live while running cleanOwnedSocket, no concurrent new owner can install a
 * socket under A's nose during cleanup. The socket is a DIFFERENT path from the
 * lock, so unlinking it cannot race a lockfile path replacement.
 *
 * Precondition: shouldCleanSocket(...) was true at start time (we created it).
 * Returns true if the socket was removed by us; ALWAYS a boolean.
 */
export function cleanOwnedSocket({ num, token, socketExistedBefore, xvfbPidAlive }, opts = {}) {
  if (!shouldCleanSocket({ socketExistedBefore, xvfbPidAlive })) return false;
  if (!token) return false;
  const p = lockPath(num, opts);
  let fd;
  try {
    fd = openSync(p, 'r');
  } catch {
    return false; // lock gone — a new owner could be mid-claim. Do NOT unlink.
  }
  try {
    const owner = readOwnerViaFd(fd);
    if (!owner || owner.token !== token) return false; // new owner took over — their socket now
    try {
      const sock = socketPath(num);
      if (!existsSync(sock)) return false; // Xvfb already removed it
      unlinkSync(sock);
      return true;
    } catch {
      return false;
    }
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Find and atomically claim a free display in [min, max]. Returns the claimed
 * display number and token, or null if none could be claimed. A display is a
 * candidate when its X11 socket does not exist; we then try to acquire the
 * lock atomically (O_EXCL). If a lock exists but its owner pid is dead, we
 * reclaim it (acquireStale). Returns `{ num, token }` or `null`.
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
 * display is free (no socket) AND the lock is acquirable (or a stale,
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
