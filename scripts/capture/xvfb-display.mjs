/**
 * Token-based X display ownership for the capture gate.
 *
 * A claim is an UNFORGEABLE owner token (a UUID) plus the owner's pid. The hard
 * problem this module finally solves is TOCTOU under concurrent stale reclaim:
 * every prior iteration had a read-verify-then-act window that let two
 * reclaimers both "win" the same stale lock, producing two owners of one
 * display. The root cause: POSIX has no atomic "compare-and-REPLACE an existing
 * path" without `rename` (last-writer-wins, NOT a CAS) or `flock` (not in Node
 * core, no native build infra here). A "rename then re-read the path to confirm
 * success" is NOT a linearizable CAS — two callers can each rename and each
 * read back their own token and both return success.
 *
 * ── The directory + `owner.<pid>` design (true CAS, no native deps) ──────────
 * A display's lock is a DIRECTORY. The owner is a FILE INSIDE it named
 * `owner.<pid>` (the owner's pid is IN THE FILENAME). This gives a kernel-
 * arbitrated single linearization point and makes reclaim safe by construction:
 *
 *  - acquireDisplay (fresh): `mkdir(lockDir)` is `O_EXCL` — one winner, losers
 *    get EEXIST. The successful mkdir IS the linearization point; no path re-
 *    read confirms success. The winner writes `owner.<pid>` (its own pid).
 *
 *  - acquireStale (reclaim a dead-owner lock): the dir already exists (mkdir
 *    fails EEXIST), so we scan `owner.<pid>` files. The pid is IN THE FILENAME,
 *    so liveness is checked against the filename, not against mutable file
 *    contents. A reclaimer unlinks ONLY `owner.<deadpid>` files — because the
 *    pid is in the filename, a reclaimer can NEVER unlink a LIVE owner's
 *    `owner.<livepid>` file (it doesn't match the dead pid it read). If a LIVE
 *    owner file exists, reclaim is refused. After unlinking dead owner files,
 *    if the dir is empty, `rmdir` + `mkdir` CAS re-acquires. The `mkdir` CAS is
 *    the single success point; a concurrent reclaimer that also unlinked the
 *    same dead file loses the mkdir race (EEXIST) and returns null. Two
 *    reclaimers therefore CANNOT both succeed: the second's mkdir fails.
 *
 *    Crucial invariant: a reclaimer only ever removes files named after a DEAD
 *    pid. A live owner's file is named `owner.<livepid>`; no reclaimer reads
 *    that pid as dead (a live pid does not read as dead), so no reclaimer ever
 *    unlinks it. A dead pid cannot become alive, so the "owner is dead" fact
 *    proven from the filename cannot be invalidated. There is no window in
 *    which a live owner's lock is removed by a mis-targeted reclaim.
 *
 *  - releaseOwned: unlink THIS owner's `owner.<mypid>` file (filename-gated —
 *    a late/duplicate release with our pid unlinks at most our own
 *    `owner.<mypid>`, never a new owner's `owner.<newpid>`), then `rmdir` the
 *    dir (best-effort; fails ENOTEMPTY if a new owner already installed its
 *    owner file — the new owner's lock survives, no restore-rename, no
 *    tombstone window, no coverage of a third party's lock).
 *
 *  - cleanOwnedSocket: re-verify ownership by reading `owner.<mypid>` through
 *    an open fd (fd-anchored identity — even if another process replaced the
 *    file at the path, the fd anchors the inode we read), then unlink the X11
 *    socket. Because a new owner B can only reclaim after A's pid dies, and A
 *    is alive while running cleanOwnedSocket, B's reclaim sees A live and
 *    refuses — so no concurrent new owner can install a socket under A's nose
 *    during cleanup. The fd re-verify is belt-and-suspenders.
 *
 *  Contract: releaseOwned/cleanOwnedSocket ALWAYS return a boolean.
 *
 * Pure helpers are unit-tested without Xvfb; real allocation/concurrency is
 * covered by tests/xvfb-display.test.ts and tests/xvfb-display.integration.test.ts.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  existsSync,
  writeFileSync,
  openSync,
  closeSync,
  readSync,
  rmdirSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

export const DEFAULT_MIN_DISPLAY = 200;
export const DEFAULT_MAX_DISPLAY = 320; // inclusive upper bound for the scan

/** The X11 Unix socket path for a display number. */
export function socketPath(num) {
  return `/tmp/.X11-unix/X${num}`;
}

/** The per-display ownership LOCK DIRECTORY path. The lock is a DIRECTORY; the
 * owner is a file `owner.<pid>` INSIDE it (pid in the filename — see module
 * header). This path is also used as the "lock exists?" probe by callers. */
export function lockPath(num, opts = {}) {
  const dir = opts.lockDir || '/tmp';
  return `${dir}/dsh-capture-xvfb-${num}.lock`;
}

/** The owner file path INSIDE the lock directory for a given owner pid. The pid
 * is in the filename so that a reclaimer unlinking a DEAD owner can never match
 * (and thus never remove) a LIVE owner's file. */
function ownerFilePath(num, ownerPid, opts = {}) {
  return `${lockPath(num, opts)}/owner.${ownerPid}`;
}

/** Scan a lock directory for owner files. Returns an array of
 * `{ file, pid, token } | null` entries (token null if unreadable). The pid is
 * parsed from the FILENAME (authoritative for liveness), the token from the
 * file contents. Never throws. */
function scanOwners(num, opts = {}) {
  const dir = lockPath(num, opts);
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const owners = [];
  for (const f of files) {
    const m = /^owner\.(\d+)$/.exec(f);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    let token = null;
    try {
      const txt = readFileSyncViaPath(`${dir}/${f}`);
      token = parseToken(txt);
    } catch {
      /* unreadable — treat as no-token, still a pid-bearing owner file */
    }
    owners.push({ file: f, pid, token, fullPath: `${dir}/${f}` });
  }
  return owners;
}

/** Read file text by path (sync). Throws on error (caller handles). */
function readFileSyncViaPath(p) {
  return readFileSync(p, 'utf8');
}

/** Parse the owner token from owner-file text (first line). */
function parseToken(txt) {
  const token = (txt.split('\n')[0] || '').trim();
  return token || null;
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

/** A fresh, unforgeable owner token for a new claim. */
export function newOwnerToken() {
  return randomUUID();
}

/** Read the current owner of a display's lock by scanning its dir. Returns the
 * FIRST owner file found `{ token, pid } | null`. Point-in-time; the CAS
 * operations do not rely on this for success. Never throws. */
export function readOwner(num, opts = {}) {
  const owners = scanOwners(num, opts);
  for (const o of owners) {
    if (o.token !== null) return { token: o.token, pid: o.pid };
  }
  // If there are owner files but none readable, return the first pid (token null).
  if (owners.length > 0) return { token: null, pid: owners[0].pid };
  return null;
}

/** Try to mkdir a path; return true on success, false on EEXIST. Rethrows others. */
function tryMkdir(p) {
  try {
    mkdirSync(p);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Acquire the ownership lock for `num` with a fresh token (fresh install — the
 * lock dir must NOT exist). Returns the token (string) on success, or null if
 * the dir already exists (EEXIST). The `mkdir` is `O_EXCL`-equivalent: it is
 * the single kernel-arbitrated linearization point — one winner, no path re-
 * read confirms success. Never throws on EEXIST; rethrows other errors.
 */
export function acquireDisplay(num, opts = {}) {
  if (!tryMkdir(lockPath(num, opts))) return null; // EEXIST — already locked
  const token = newOwnerToken();
  // Write owner.<pid> (pid in filename). Best-effort; the dir+file is the claim.
  try {
    writeFileSync(ownerFilePath(num, process.pid, opts), `${token}\npid=${process.pid}\n`);
  } catch { /* best effort */ }
  return token;
}

/**
 * Reclaim a lock whose owner pid is dead (a crashed prior run). The lock dir
 * exists. Returns a fresh token on success, or null if a LIVE owner holds the
 * lock (we never steal a live claim) or the reclaim lost the mkdir CAS.
 *
 * TOCTOU-safe (no read-verify-then-unlink of a LIVE lock): we scan `owner.<pid>`
 * files; the pid is IN THE FILENAME. A reclaimer unlinks ONLY files named after
 * a DEAD pid. A live owner's `owner.<livepid>` file can NEVER be unlinked by a
 * reclaimer — the reclaimer read a (different) dead pid, and the filename does
 * not match. After unlinking dead-owner files, if the dir is empty, `rmdir` +
 * `mkdir` CAS re-acquire. The `mkdir` CAS is the single success point: two
 * concurrent reclaimers both unlink the same dead file, but only ONE's `mkdir`
 * succeeds (the other gets EEXIST) and returns null. There is no path re-read
 * success, no tombstone, no restore window. A dead pid cannot become alive, so
 * the dead-owner fact proven from the filename is stable.
 *
 * Test hook: DSH_RECLAIM_BARRIER (a path) pauses us AFTER scanning owners and
 * confirming the owner is dead, BEFORE unlinking — so the adversarial test can
 * force BOTH reclaimers to have completed the dead-pid judgment before either
 * installs, then prove only one wins. No-op in production (env unset). Bounded.
 */
export function acquireStale(num, opts = {}, isPidAlive = defaultIsPidAlive) {
  // If the dir doesn't exist, this isn't a reclaim — caller should use
  // acquireDisplay. (Defensive; findFreeDisplay/claimExplicit handle this.)
  if (!existsSync(lockPath(num, opts))) return null;

  const owners = scanOwners(num, opts);

  // If ANY owner file is held by a LIVE pid, do not steal. (A live owner's
  // `owner.<livepid>` file means the display is genuinely owned.)
  for (const o of owners) {
    if (isPidAlive(o.pid)) return null;
  }

  // Test hook: pause after dead-pid judgment, before unlink. Both reclaimers
  // have now confirmed "owner is dead"; the barrier lets the test serialize
  // their installs and prove only one wins.
  const reclaimBarrier = process.env.DSH_RECLAIM_BARRIER;
  if (reclaimBarrier) waitForFile(reclaimBarrier, 30000);

  // Unlink ONLY dead-owner files (filename = dead pid; safe). A live owner's
  // file is `owner.<livepid>` and is never matched here. If a live owner
  // appeared between the scan and here, its file is NOT in `owners` and is NOT
  // unlinked — we then refuse below (dir not empty → mkdir fails).
  for (const o of owners) {
    try {
      unlinkSync(o.fullPath);
    } catch { /* already removed by a concurrent reclaimer — fine */ }
  }

  // If the dir is now empty, rmdir + mkdir CAS re-acquire. If a LIVE owner
  // installed a file in the meantime, rmdir fails (ENOTEMPTY) and we bail.
  try {
    rmdirSync(lockPath(num, opts));
  } catch {
    // Dir not empty (a live owner took over) or already gone. If a live owner
    // holds it, do NOT steal. If gone, caller retries acquireDisplay.
    return null;
  }
  // mkdir CAS — the single linearization point. Only one reclaimer succeeds.
  if (!tryMkdir(lockPath(num, opts))) {
    // A concurrent reclaimer (or fresh acquirer) won the mkdir. We lost. Bail.
    return null;
  }
  const token = newOwnerToken();
  try {
    writeFileSync(ownerFilePath(num, process.pid, opts), `${token}\npid=${process.pid}\n`);
  } catch { /* best effort */ }
  return token;
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
 * Release THIS run's ownership of `num` (only if we still hold it). Unlinks our
 * own `owner.<mypid>` file (filename-gated: a late/duplicate release unlinks at
 * most our own file, NEVER a new owner's `owner.<newpid>`), then `rmdir`s the
 * dir (best-effort; fails ENOTEMPTY if a new owner installed its file — the new
 * owner's lock survives). Returns true iff we removed our owner file.
 *
 * The `token` arg is accepted for API compatibility; the filename-gated unlink
 * is the real safety (a wrong-token release with our pid still only removes our
 * own `owner.<mypid>`). No fd read-verify-then-unlink, no tombstone, no restore
 * window that could cover a third party's lock. Always returns a boolean.
 */
export function releaseOwned(num, token, opts = {}) {
  if (!token) return false;
  const ownerFile = ownerFilePath(num, process.pid, opts);
  let removed = false;
  try {
    // fd-anchored re-verify: open OUR owner file; if the token at our inode is
    // still ours, unlink our file. If our file was replaced (impossible for a
    // same-pid file — only our pid names this path) we'd see a foreign token
    // and bail. This is belt-and-suspenders on top of the filename gating.
    const fd = openSync(ownerFile, 'r');
    try {
      const buf = Buffer.alloc(128);
      const n = readSync(fd, buf, 0, 128, 0);
      const tok = parseToken(buf.subarray(0, n).toString('utf8'));
      if (tok !== token) return false; // not ours (shouldn't happen for owner.<mypid>)
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    unlinkSync(ownerFile);
    removed = true;
  } catch {
    // Our owner file is gone (already released, or we never owned). A new
    // owner's `owner.<newpid>` file is a DIFFERENT path and was never touched.
    return false;
  }
  // Best-effort rmdir. If a new owner installed `owner.<newpid>` in the
  // meantime, rmdir fails ENOTEMPTY — the new owner's lock survives. Never
  // restore-rename (no tombstone window, no coverage of a third party's lock).
  try {
    rmdirSync(lockPath(num, opts));
  } catch { /* not empty (new owner) or already gone — fine */ }
  return removed;
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
 * time. Ownership is re-verified by reading OUR `owner.<mypid>` file through an
 * open fd (fd-anchored identity). Because a new owner B can only reclaim after
 * A's pid dies (acquireStale refuses while A is live), and A is alive while
 * running cleanOwnedSocket, no concurrent new owner can install a socket under
 * A's nose during cleanup. The fd re-verify is belt-and-suspenders.
 *
 * Precondition: shouldCleanSocket(...) was true at start time (we created it).
 * Returns true if the socket was removed by us; ALWAYS a boolean.
 */
export function cleanOwnedSocket({ num, token, socketExistedBefore, xvfbPidAlive }, opts = {}) {
  if (!shouldCleanSocket({ socketExistedBefore, xvfbPidAlive })) return false;
  if (!token) return false;
  // Re-verify ownership at unlink time via OUR owner file (fd-anchored).
  const ownerFile = ownerFilePath(num, process.pid, opts);
  let fd;
  try {
    fd = openSync(ownerFile, 'r');
  } catch {
    return false; // our owner file gone — we don't own it anymore. Do NOT unlink.
  }
  try {
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, 128, 0);
    const tok = parseToken(buf.subarray(0, n).toString('utf8'));
    if (tok !== token) return false; // not our token — new owner may have this pid? no.
    // Test hook: DSH_CLEANSOCK_BARRIER (a path) pauses us AFTER the fd ownership
    // re-verify, BEFORE the socket unlink. Lets the adversarial test pause A
    // here and have B attempt to take over — proving B cannot (A is live, so
    // acquireStale refuses), so A's socket-unlink cannot race a B-installed
    // socket. No-op in production (env unset). Bounded.
    const cleansockBarrier = process.env.DSH_CLEANSOCK_BARRIER;
    if (cleansockBarrier) waitForFile(cleansockBarrier, 30000);
    // We still own the claim (our owner file carries our token). Unlink the
    // X11 socket — a DIFFERENT path from the lockfile, so it cannot race a
    // lockfile path replacement.
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
 * lock dir atomically (mkdir CAS). If a lock dir exists but its owner pid is
 * dead, we reclaim it (acquireStale). Returns `{ num, token }` or `null`.
 */
export function findFreeDisplay(opts = {}) {
  const min = opts.min ?? DEFAULT_MIN_DISPLAY;
  const max = opts.max ?? DEFAULT_MAX_DISPLAY;
  for (let num = min; num <= max; num += 1) {
    if (displayOccupied(num)) continue; // someone's X server is up here
    let token = acquireDisplay(num, opts);
    if (token === null) {
      // Lock dir exists — maybe stale. Try reclaiming if the owner is dead.
      token = acquireStale(num, opts);
      if (token === null) continue; // live owner — keep scanning
    }
    return { num, token };
  }
  return null;
}

/**
 * Claim a SPECIFIC display number (from DSH_XVFB_DISPLAY). Succeeds only if the
 * display is free (no socket) AND the lock dir is acquirable (or a stale,
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
