/**
 * Token-based X display ownership for the capture gate.
 *
 * A claim is an UNFORGEABLE owner TOKEN (a UUID — never reused) plus the
 * owner's pid as a LIVENESS HINT (NOT identity; the OS reuses pids, so the
 * token is authoritative and the pid only decides liveness for stale reclaim).
 *
 * ── The compare-and-delete TOCTOU, finally closed with a kernel mutex ──────
 * Every prior iteration lost on one thing: a "read/verify via fd, then
 * unlinkSync(path)" sequence is a pathname TOCTOU. Two reclaimers (or two
 * same-token releases) can BOTH pass the fd verify, then the later unlinked
 * deletes the earlier winner's just-installed LIVE lock — double owner. fd
 * anchoring proves "we read X"; it does NOT make the later pathname unlink a
 * compare-and-delete. The reviewer authorized a "真正可证明互斥的协议/辅助锁".
 *
 * This module uses a per-display MUTEX via the kernel `flock(2)` advisory lock,
 * driven through the `flock` command (util-linux; Linux-only — the capture gate
 * itself is Linux/Xvfb-only). `acquireStale` / `releaseOwned` /
 * `cleanOwnedSocket` run their destructive critical section in a child process
 * holding an exclusive flock on a per-display mutex file (`<lockDir>/dsh-
 * capture-xvfb-<num>.mut`). While the holder is in the critical section, NO
 * other compliant caller can enter theirs for the same display — so the
 * verify→unlink is serialized and there is no window for a later unlink to hit
 * another's live generation. The pathname unlink is now safe BECAUSE it is
 * under the mutex (not because of a re-check).
 *
 * ── Crash recovery boundary ────────────────────────────────────────────────
 * `flock` auto-releases when the holding process exits — including a crash
 * (SIGKILL, segfault, OOM). There is NO stale-mutex reclaim path and therefore
 * NO mutex TOCTOU: a crashed holder's flock is gone the instant the kernel
 * reaps it. A next caller acquires the mutex and observes the (possibly
 * half-mutated) lock state, which the critical section handles:
 *  - acquireStaleCritical: owner-less (empty) lock → NOT reclaimable; a
 *    dead-owner lock → reclaim; the verify+unlink+O_EXCL runs serialized.
 *  - releaseOwnedCritical: open 'r', read token via fd, unlink only if ours —
 *    serialized, so no same-token double release can cross a generation.
 *  - cleanOwnedSocketCritical: same fd verify, unlink socket — serialized.
 * `acquireDisplay` (fresh publish) is NOT mutex-gated: it is a single atomic
 * O_EXCL (one winner); it does not delete anyone's file, so it needs no mutex.
 *
 * ── Publication (unchanged from the prior, correct iteration) ──────────────
 * The lock is a single FILE whose CONTENTS are the owner identity
 * (`<token>\npid=<pid>\n`). `acquireDisplay` publishes via one kernel-atomic
 * `openSync(lockPath,'wx')` (O_EXCL) + `writeSync` through the exclusive fd;
 * write failure → unlink + return null (fail-closed, no orphan). An owner-less
 * (empty) lock is NOT reclaimable stale (may be a fresh acquire mid-publication).
 *
 * Pure critical-section functions are exported (suffixed `Critical`) so they
 * can be unit-tested directly AND dispatched by the flock-guarded helper
 * `scripts/capture/mut-op.mjs`. The public `acquireStale`/`releaseOwned`/
 * `cleanOwnedSocket` wrap them under flock.
 *
 * Contract: releaseOwned/cleanOwnedSocket ALWAYS return a boolean.
 */

import {
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
  writeSync,
  readSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const DEFAULT_MIN_DISPLAY = 200;
export const DEFAULT_MAX_DISPLAY = 320; // inclusive upper bound for the scan

const MUT_OP = fileURLToPath(new URL('mut-op.mjs', import.meta.url));

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

/** The per-display MUTEX file path (kernel flock target). Pre-created once. */
export function mutPath(num, opts = {}) {
  const dir = opts.lockDir || '/tmp';
  return `${dir}/dsh-capture-xvfb-${num}.mut`;
}

/** Ensure the mutex file exists (created once; flock opens it to lock). */
function ensureMut(num, opts = {}) {
  try {
    const fd = openSync(mutPath(num, opts), 'a'); // O_CREAT|O_WRONLY|O_APPEND
    try { closeSync(fd); } catch { /* ignore */ }
  } catch { /* best effort */ }
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
 * `{ token, pid } | null` — null if no lock file or it is empty/unreadable.
 * Point-in-time path read; the CAS operations read through an fd (fd-anchored).
 * Never throws. */
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
 * install — the lock file must NOT exist). NOT mutex-gated: it is a single
 * atomic O_EXCL (one winner, no file deleted), so it needs no serialization.
 * The O_EXCL is the linearization point; owner contents are written through the
 * exclusive fd; write failure → unlink + return null (fail-closed, no orphan).
 * Never throws on EEXIST; rethrows unexpected errors.
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

/** Default liveness check (signal 0). */
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

/**
 * CRITICAL SECTION for reclaiming a dead-owner lock. NOT mutex-gated — the
 * caller (acquireStale, via mut-op.mjs under flock) MUST hold the per-display
 * mutex. Pure path operation:
 *   - open the lock, read owner via fd. owner-less (empty) → NOT reclaimable.
 *   - owner pid dead (liveness hint; pid is a HINT, token is identity) → proceed.
 *   - RE-VERIFY (re-open, re-read) it is STILL the same dead owner.
 *   - [barrier1] test hook pauses AFTER the verify, BEFORE unlink.
 *   - unlink + O_EXCL-recreate + write owner. [barrier2] pauses after recreate.
 * Returns the new token or null. Because this runs under flock, a second
 * reclaimer BLOCKS until the first releases; it can never unlink the first's
 * just-installed live lock. The verify+unlink is serialized, not a TOCTOU.
 */
export function acquireStaleCritical(num, opts = {}, isPidAlive = defaultIsPidAlive, barrier1, barrier2) {
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
  if (isPidAlive(owner.pid)) return null; // owner still alive (or pid reused) — do NOT steal
  // RE-VERIFY: re-open and re-read; the lock must STILL carry the SAME dead owner.
  let reFd;
  try {
    reFd = openSync(p, 'r');
  } catch {
    return null; // lock gone between reads — bail
  }
  let reOwner;
  try {
    reOwner = readOwnerViaFd(reFd);
  } finally {
    try { closeSync(reFd); } catch { /* ignore */ }
  }
  if (!reOwner || reOwner.token !== owner.token || reOwner.pid !== owner.pid) {
    return null; // changed under us — bail (a sibling reclaimed)
  }
  if (reOwner.pid !== null && isPidAlive(reOwner.pid)) {
    return null; // owner now live — bail
  }
  // Test hook: pause AFTER verify, BEFORE unlink. Under flock, a second
  // reclaimer is BLOCKED on the mutex here — it cannot enter to unlink.
  if (barrier1) waitForFile(barrier1, 30000);
  try {
    unlinkSync(p);
  } catch {
    return null; // someone removed it; let caller retry acquireDisplay
  }
  // O_EXCL recreate — the publish linearization point. One winner.
  const token = acquireDisplay(num, opts);
  // Test hook: pause AFTER recreate (winner's lock installed). Under flock the
  // second caller still cannot enter until we release the mutex.
  if (barrier2) waitForFile(barrier2, 30000);
  return token;
}

/**
 * CRITICAL SECTION for releasing THIS run's ownership. NOT mutex-gated — the
 * caller (releaseOwned, via mut-op.mjs under flock) MUST hold the mutex.
 * Open the lock 'r', read the token THROUGH the fd; if not ours → false; if
 * ours → unlink. Serialized under flock, so two same-token releases cannot
 * cross a generation: the second blocks until the first's unlink completes and
 * the path is empty; if a third party acquires in between, the second's fd read
 * sees the new token (mismatch) → no-op. [barrier1] pauses after verify, before
 * unlink. Returns a boolean.
 */
export function releaseOwnedCritical(num, token, opts = {}, barrier1, barrier2) {
  if (!token) return false;
  const p = lockPath(num, opts);
  let fd;
  try {
    fd = openSync(p, 'r');
  } catch {
    return false; // lock gone — nothing to release
  }
  let ours = false;
  try {
    const owner = readOwnerViaFd(fd);
    if (!owner || owner.token !== token) return false; // not ours
    ours = true;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  // Test hook: pause AFTER verify, BEFORE unlink. Under flock, a second release
  // or a new acquirer is BLOCKED — it cannot replace the lock here.
  if (barrier1) waitForFile(barrier1, 30000);
  try {
    unlinkSync(p);
  } catch {
    return false;
  }
  if (barrier2) waitForFile(barrier2, 30000);
  return true;
}

/**
 * Decide whether this run may remove the X11 socket for `num` at START time.
 * We remove only when we PROVED we created it (socket did NOT pre-exist AND
 * our Xvfb came up). Necessary; cleanOwnedSocketCritical re-verifies at unlink.
 */
export function shouldCleanSocket({ socketExistedBefore, xvfbPidAlive }) {
  if (socketExistedBefore === true) return false;
  if (!xvfbPidAlive) return false;
  return true;
}

/**
 * CRITICAL SECTION for removing the X11 socket. NOT mutex-gated — caller
 * (cleanOwnedSocket, via mut-op.mjs under flock) MUST hold the mutex.
 * fd-anchored token re-verify, then unlink the socket (a different path).
 * Serialized under flock. [barrier1] pauses after verify, before unlink.
 * Returns a boolean.
 */
export function cleanOwnedSocketCritical({ num, token, socketExistedBefore, xvfbPidAlive }, opts = {}, barrier1, barrier2) {
  if (!shouldCleanSocket({ socketExistedBefore, xvfbPidAlive })) return false;
  if (!token) return false;
  const p = lockPath(num, opts);
  let fd;
  try {
    fd = openSync(p, 'r');
  } catch {
    return false; // lock gone — do NOT unlink the socket
  }
  try {
    const owner = readOwnerViaFd(fd);
    if (!owner || owner.token !== token) return false; // new owner took over
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
  if (barrier1) waitForFile(barrier1, 30000);
  try {
    const sock = socketPath(num);
    if (!existsSync(sock)) return false; // Xvfb already removed it
    unlinkSync(sock);
    if (barrier2) waitForFile(barrier2, 30000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim a lock whose owner pid is dead. Runs the critical section under a
 * per-display kernel flock (via mut-op.mjs) so two reclaimers CANNOT both pass
 * verify then cross-unlink each other's live lock. Returns the new token or
 * null. `isPidAlive` is honored ONLY when the caller is in-process (the
 * production path uses the default probe via mut-op.mjs; a custom probe closure
 * cannot cross a child-process boundary). Unit tests that inject a custom
 * probe call acquireStaleCritical DIRECTLY (single-caller, no concurrency, so
 * the verify+unlink is safe by absence of a sibling).
 */
export function acquireStale(num, opts = {}, isPidAlive = defaultIsPidAlive) {
  if (isPidAlive !== defaultIsPidAlive) {
    // Custom probe: caller is a single-caller test; run the pure critical
    // section directly (no concurrent sibling exists in that test shape).
    return acquireStaleCritical(num, opts, isPidAlive);
  }
  ensureMut(num, opts);
  const result = runUnderFlock(num, opts, 'acquireStale', [String(num), opts.lockDir || '']);
  if (!result || result.ok !== true) return null;
  return result.token ?? null;
}

/**
 * Release THIS run's ownership. Runs the critical section under the per-display
 * flock so two same-token releases cannot cross a generation. Always returns a
 * boolean. `barrier1`/`barrier2` (test hooks) are honored via env when set.
 */
export function releaseOwned(num, token, opts = {}) {
  if (!token) return false;
  ensureMut(num, opts);
  const barrier1 = process.env.DSH_RELEASE_BARRIER1 || '';
  const barrier2 = process.env.DSH_RELEASE_BARRIER2 || '';
  const result = runUnderFlock(num, opts, 'releaseOwned', [String(num), opts.lockDir || '', token, barrier1, barrier2]);
  return !!(result && result.ok === true);
}

/**
 * Remove the X11 socket for `num` ONLY IF we still own the claim. Runs the
 * critical section under the per-display flock. `socketExistedBefore` and
 * `xvfbPidAlive` are passed via env (DSH_CLEANSOCK_INPUT JSON). Always boolean.
 */
export function cleanOwnedSocket({ num, token, socketExistedBefore, xvfbPidAlive }, opts = {}) {
  if (!shouldCleanSocket({ socketExistedBefore, xvfbPidAlive })) return false;
  if (!token) return false;
  ensureMut(num, opts);
  const barrier1 = process.env.DSH_CLEANSOCK_BARRIER1 || '';
  const barrier2 = process.env.DSH_CLEANSOCK_BARRIER2 || '';
  const env = {
    ...process.env,
    DSH_CLEANSOCK_INPUT: JSON.stringify({ socketExistedBefore, xvfbPidAlive })
  };
  const result = runUnderFlock(num, opts, 'cleanOwnedSocket', [String(num), opts.lockDir || '', token, barrier1, barrier2], env);
  return !!(result && result.ok === true);
}

/**
 * Run a critical-section op under the per-display flock by invoking
 * `flock <mutPath> node mut-op.mjs <op> <args...>`. flock holds the kernel
 * exclusive lock for the whole child process, serializing against every other
 * compliant caller for this display. Returns the parsed JSON result or null.
 */
function runUnderFlock(num, opts, op, args, extraEnv) {
  const mut = mutPath(num, opts);
  const env = extraEnv ? { ...extraEnv } : { ...process.env };
  try {
    const stdout = execFileSync('flock', [mut, process.execPath, MUT_OP, op, ...args], {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Find and atomically claim a free display in [min, max]. Returns the claimed
 * display number and token, or null. A display is a candidate when its X11
 * socket does not exist; we acquire the lock (O_EXCL) or reclaim a dead-owner
 * lock (acquireStale, flock-guarded). Returns `{ num, token }` or `null`.
 */
export function findFreeDisplay(opts = {}) {
  const min = opts.min ?? DEFAULT_MIN_DISPLAY;
  const max = opts.max ?? DEFAULT_MAX_DISPLAY;
  for (let num = min; num <= max; num += 1) {
    if (displayOccupied(num)) continue; // someone's X server is up here
    let token = acquireDisplay(num, opts);
    if (token === null) {
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
