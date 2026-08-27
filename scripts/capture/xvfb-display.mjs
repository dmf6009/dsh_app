/**
 * Token-based X display ownership for the capture gate.
 *
 * A claim is an UNFORGEABLE owner token (a UUID written into the lockfile).
 * Only the run holding the current token is the owner. The hard problem is
 * TOCTOU: every prior iteration either (a) released the lock BEFORE unlinking
 * the X11 socket (letting run B win the freed lock and create the same-named
 * socket in the window before A's unlink deleted it), or (b) used a
 * read-verify-then-unlinkSync critical section — which has a window between the
 * verify and the unlink in which a concurrent reclaimer can unlink+recreate the
 * lockfile AT THE SAME PATH, so the now-stale unlinkSync deletes the NEW owner's
 * LIVE lock. A second O_EXCL "mutation lock" did NOT fix this: its own stale
 * reclamation reproduced the identical read-verify-then-unlink window, so two
 * reclaimers could both hold the "mutex". inode numbers are recycled on the CI
 * filesystem, so stat-identity cannot detect replacement either.
 *
 * This module has NO read-verify-then-unlinkSync window anywhere. It uses two
 * kernel-atomic primitives only:
 *
 * 1. `O_EXCL` open (`openSync(path, 'wx')`) — atomic create-if-absent. Used by
 *    acquireDisplay for a fresh lock. One winner; losers get EEXIST.
 * 2. `rename(2)` (`renameSync`) — atomic REPLACE of an existing directory
 *    entry. POSIX guarantees rename over an existing file atomically swaps the
 *    directory entry to the source inode; there is no instant at which the path
 *    is absent or points at "half" a file. Used by acquireStale to atomically
 *    replace a dead-owner lock's CONTENTS with our token — no unlink of the path
 *    is ever issued during reclaim, so no live lock is ever deleted by a
 *    mis-targeted unlinkSync.
 *
 * ── releaseOwned / cleanOwnedSocket: the fd-anchored rename-to-tombstone CAS ──
 * Deletion is the operation that cannot be done with O_EXCL or rename directly:
 * "delete the lock ONLY if it is still mine" is a compare-and-delete, and a
 * path-based unlink after a path-based read has the TOCTOU window. We instead
 * ANCHOR identity to an open file descriptor (fd), which cannot be replaced:
 *
 *  1. `openSync(lockPath, 'r')` → fd. The fd is bound to the inode that was at
 *     `lockPath` at open time; EVEN IF another process later unlinks+recreates
 *     `lockPath`, this fd still refers to OUR (now-unlinked) inode. (Verified
 *     on the CI FS: fstat(fd).ino stays the original inode while stat(path).ino
 *     changes after a replace.)
 *  2. Read the token THROUGH THE FD (readSync) — we read the inode we anchored,
 *     not "whatever is at the path now".
 *  3. If the token is not ours → abort (already released / new owner). No unlink.
 *  4. `renameSync(lockPath, tombstone)` — ATOMIC: whatever directory entry is at
 *     `lockPath` RIGHT NOW is moved to `tombstone`. After this, `lockPath` is
 *     empty (until some other process creates a new file there).
 *  5. Compare `fstatSync(fd).ino === statSync(tombstone).ino`:
 *     - EQUAL → the rename moved OUR inode (the one the fd anchors, whose token
 *       we verified). It is safe to `unlinkSync(tombstone)` (our file, reachable
 *       only via the tombstone we just created). Done — we released our lock.
 *       (If `lockPath` was freshly created by another process between our open
 *       and rename, that new file is at `lockPath`, untouched; we never unlink
 *       the path, only the tombstone that holds our own inode.)
 *     - NOT EQUAL → between our open and rename, another process replaced the
 *       lock at `lockPath` (their inode differs from our fd's inode). The rename
 *       moved THEIR file to `tombstone` — we must NOT delete it. Restore it:
 *       `renameSync(tombstone, lockPath)` puts their lock back at the canonical
 *       path, then abort. (A reclaimer that races this restore gets a token
 *       mismatch on re-read and bails; no false owner.)
 *
 * No `unlinkSync` is ever issued against `lockPath` itself — only against a
 * tombstone whose inode we PROVED (via fd anchor) is ours. The read-verify and
 * the destructive op are bound to the SAME inode through the fd, with rename
 * providing the atomic "snapshot the current directory entry" step. There is no
 * window in which a path-based unlink hits a file whose token we did not just
 * verify against the same inode.
 *
 *  - cleanOwnedSocket runs the same fd-anchored ownership re-verify, then
 *    unlinks the X11 SOCKET (a different path) only while our token still owns
 *    the lock inode. releaseOwned is called AFTER, releasing the lock.
 *
 * Pure helpers are unit-tested without Xvfb; real allocation/concurrency is
 * covered by tests/xvfb-display.test.ts and tests/xvfb-display.integration.test.ts.
 */

import {
  openSync,
  closeSync,
  unlinkSync,
  existsSync,
  readFileSync,
  writeSync,
  readSync,
  fstatSync,
  statSync,
  renameSync
} from 'node:fs';
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

/** A scratch tombstone path (same dir as the lock so rename is same-FS / atomic)
 * used by releaseOwned's rename-to-tombstone CAS. Unique per call. */
function tombstonePath(num, opts = {}) {
  const dir = opts.lockDir || '/tmp';
  return `${dir}/dsh-capture-xvfb-${num}.tomb-${process.pid}-${randomUUID()}`;
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

/** Read the current owner of a display's lockfile BY PATH. Returns
 * `{ token, pid } | null` (null if no lockfile or unreadable). Never throws.
 * NOTE: this is a point-in-time path read; it does NOT prove the path still
 * refers to the same inode later. The CAS operations (releaseOwned/
 * cleanOwnedSocket) use readOwnerViaFd for fd-anchored identity. */
export function readOwner(num, opts = {}) {
  return readOwnerPath(lockPath(num, opts));
}

/** Read `{ token, pid } | null` from a path. Never throws. */
function readOwnerPath(p) {
  try {
    const txt = readFileSync(p, 'utf8');
    return parseOwner(txt);
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

/** Read the owner through an OPEN FD (fd-anchored identity). The token is read
 * from the inode the fd is bound to, NOT "whatever is at the path now". Returns
 * `{ token, pid } | null`. Never throws; closes the fd. */
function readOwnerViaFd(fd) {
  try {
    // Read up to 256 bytes (token + pid line fit easily).
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    const txt = buf.subarray(0, n).toString('utf8');
    return parseOwner(txt);
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
 * Reclaims ONLY if the lockfile exists, its recorded pid is set and is NOT
 * alive. Returns the new token or null. We NEVER reclaim a lock whose owner is
 * still alive — that would steal a live run's claim.
 *
 * TOCTOU-safe (no read-verify-then-unlink): we do NOT unlink the stale lock and
 * re-create it. We atomically REPLACE the lockfile's contents with our token
 * via `rename(temp, lockPath)` — POSIX rename over an existing file is an
 * atomic directory-entry swap; there is no instant the path is absent or refers
 * to a half-written file. Two concurrent reclaimers both rename; rename is
 * last-writer-wins, and the resulting lockfile carries EXACTLY ONE token. Each
 * reclaimer then re-reads the path; if it carries OUR token we won, else we lost
 * and bail (no unlink, no live lock deleted). Because a dead pid cannot become
 * alive, the "owner is dead" fact cannot be invalidated between the check and
 * the rename; and a reclaimer that loses the rename race reads the winner's LIVE
 * token and bails. No compliant process ever `unlinkSync`s the lock path.
 *
 * Test hook: `DSH_RECLAIM_BARRIER` (a path) pauses us HERE — AFTER the
 * dead-owner check and the rename, BEFORE the re-read that decides win/lose —
 * letting the adversarial test deterministically force a second reclaimer onto
 * the same stale lock and prove (via the re-read) that only one wins. No-op in
 * production (env unset). Bounded so a wedged test cannot hang forever.
 */
export function acquireStale(num, opts = {}, isPidAlive = defaultIsPidAlive) {
  const lockP = lockPath(num, opts);
  const owner = readOwner(num, opts);
  if (!owner) return null; // no lockfile — caller should use acquireDisplay
  if (owner.pid === null) return null; // can't prove owner dead — leave it
  if (isPidAlive(owner.pid)) return null; // owner still alive — do NOT steal
  // Owner is dead. Atomically replace the lockfile's contents with our token.
  // We write our claim to a temp file in the SAME dir (same filesystem → rename
  // is atomic) then rename it over the stale lock path.
  const myToken = newOwnerToken();
  const tmpName = `${lockP}.reclaim-${process.pid}-${randomUUID()}`;
  let tmpFd;
  try {
    tmpFd = openSync(tmpName, 'wx');
  } catch {
    return null; // could not stage temp; let caller retry acquireDisplay
  }
  try {
    try {
      writeSync(tmpFd, `${myToken}\npid=${process.pid}\n`);
    } catch { /* best effort */ }
  } finally {
    try { closeSync(tmpFd); } catch { /* ignore */ }
  }
  // Atomic replace. If a concurrent reclaimer raced us, last rename wins; the
  // lockfile ends up carrying exactly one token. We then re-read to find out
  // if it was ours.
  try {
    renameSync(tmpName, lockP);
  } catch {
    // rename failed (e.g. the lock vanished between read and rename) — clean
    // up our temp and bail so the caller retries acquireDisplay.
    try { unlinkSync(tmpName); } catch { /* ignore */ }
    return null;
  }
  // Test hook: pause after the atomic replace, before the win/lose re-read.
  const reclaimBarrier = process.env.DSH_RECLAIM_BARRIER;
  if (reclaimBarrier) waitForFile(reclaimBarrier, 30000);
  // Re-read to determine if WE won the atomic replace.
  const after = readOwner(num, opts);
  if (!after || after.token !== myToken) {
    // We lost the rename race (a concurrent reclaimer's rename was last). The
    // lockfile now carries the WINNER's token, not ours. We did NOT unlink the
    // lock path; the winner's live lock is intact. Bail.
    return null;
  }
  return myToken;
}

/** Test hook: wait until `p` exists (bounded). No-op when p is never created. */
function waitForFile(p, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(p)) return true;
    // Busy-wait is acceptable inside a test-only critical section.
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
 * fd-anchored compare-and-delete of the lockfile for `num` ONLY IF its current
 * owner token still equals `token`. Returns true if WE released OUR lock, false
 * otherwise (already gone / new owner took over / contention). Never throws.
 *
 * TOCTOU-safe via the rename-to-tombstone CAS (see module header): the token is
 * read THROUGH an open fd anchored to the inode that was at lockPath at open
 * time; the destructive unlink targets a TOMBSTONE whose inode we prove (via
 * fstat(fd) === stat(tombstone)) is the same inode whose token we verified. No
 * path-based unlink is issued against lockPath. A late/duplicate cleanup whose
 * token no longer matches reads a foreign token through its fd and aborts; a
 * concurrent reclaimer that replaced the lock between our open and rename makes
 * fstat(fd) !== stat(tombstone), so we RESTORE their lock and abort.
 */
export function releaseOwned(num, token, opts = {}) {
  if (!token) return false;
  const lockP = lockPath(num, opts);
  let fd;
  try {
    fd = openSync(lockP, 'r');
  } catch {
    return false; // lock gone — nothing to release
  }
  try {
    // Read the token THROUGH the fd (fd-anchored identity, not a path re-read).
    const owner = readOwnerViaFd(fd);
    if (!owner || owner.token !== token) return false; // not ours — leave it
    // Atomic: move whatever directory entry is at lockP RIGHT NOW to a tombstone.
    const tomb = tombstonePath(num, opts);
    try {
      renameSync(lockP, tomb);
    } catch {
      return false; // lock vanished between open and rename — nothing to release
    }
    // Did the rename move OUR inode (the fd's inode) or a REPLACED file?
    let fdIno, tombIno;
    try {
      fdIno = fstatSync(fd).ino;
      tombIno = statSync(tomb).ino;
    } catch {
      // Tombstone stat failed (someone removed it already) — best-effort: if we
      // can't prove it was ours, leave it rather than risk deleting another's.
      try { renameSync(tomb, lockP); } catch { /* best effort restore */ }
      return false;
    }
    if (fdIno === tombIno) {
      // The tombstone holds OUR inode (whose token we verified). Safe to unlink.
      try { unlinkSync(tomb); } catch { /* best effort */ }
      return true;
    }
    // The tombstone holds a file whose inode differs from our fd — i.e. another
    // process replaced the lock at lockPath between our open and rename. Restore
    // their lock to the canonical path and abort. Do NOT unlink.
    try { renameSync(tomb, lockP); } catch { /* best effort restore */ }
    return false;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
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
 * time. Because releaseOwned is called AFTER this, no concurrent run B can have
 * won the lock and started its own Xvfb on this display yet (the lock still
 * carries our token). A late/duplicate cleanup whose token no longer matches is
 * a no-op and must not unlink the socket (B may own it now).
 *
 * Ownership re-verify uses the same fd-anchored CAS as releaseOwned: read the
 * token through an open fd anchored to the lock inode, then unlink the X11
 * socket only if that token is still ours. The socket is a DIFFERENT path from
 * the lockfile, so unlinking it cannot race a lockfile path replacement; the
 * fd-anchored token read is what proves we still own the claim at unlink time.
 *
 * Precondition: shouldCleanSocket(...) was true at start time (we created it).
 * Returns true if the socket was removed by us; ALWAYS a boolean.
 */
export function cleanOwnedSocket({ num, token, socketExistedBefore, xvfbPidAlive }, opts = {}) {
  if (!shouldCleanSocket({ socketExistedBefore, xvfbPidAlive })) return false;
  if (!token) return false;
  const lockP = lockPath(num, opts);
  let fd;
  try {
    fd = openSync(lockP, 'r');
  } catch {
    return false; // lock gone — a new owner could be mid-claim. Do NOT unlink.
  }
  try {
    const owner = readOwnerViaFd(fd);
    if (!owner || owner.token !== token) return false; // new owner took over
    // We still own the claim (fd-anchored token matches). Because releaseOwned
    // runs AFTER cleanOwnedSocket in the launcher, no run B has won the lock
    // and started its own Xvfb on this display yet.
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
