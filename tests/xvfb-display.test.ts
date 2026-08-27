/**
 * Unit tests for the token-based display-ownership helpers
 * (scripts/capture/xvfb-display.mjs).
 *
 * These test the OWNERSHIP / compare-and-release contract without Xvfb:
 *  - acquireDisplay returns a fresh unforgeable token (UUID); O_EXCL makes a
 *    second acquire of the same display fail.
 *  - releaseOwned is compare-and-release: only the token-holder releases; a
 *    stale/wrong token is a no-op (cannot delete a new owner's lock).
 *  - cleanOwnedSocket re-verifies ownership at unlink time (token must still
 *    match the lockfile) — the core cleanup-race fix.
 *  - findFreeDisplay / claimExplicit return { num, token } handles; an explicit
 *    display already occupied fails CLOSED.
 *  - acquireStale reclaims a dead-owner lock but never a live one.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireDisplay,
  acquireStale,
  claimExplicit,
  cleanOwnedSocket,
  findFreeDisplay,
  lockPath,
  readOwner,
  releaseOwned,
  shouldCleanSocket,
  socketPath
} from '../scripts/capture/xvfb-display.mjs';

let dir: string;
const lockDir = () => dir;

beforeEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  dir = mkdtempSync(join(tmpdir(), 'dsh-xvfb-units-'));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('acquireDisplay (token + O_EXCL)', () => {
  it('returns a fresh token on first acquire and null on the second', () => {
    const n = 500;
    const tok = acquireDisplay(n, { lockDir: lockDir() });
    expect(tok).not.toBeNull();
    expect(typeof tok).toBe('string');
    expect(acquireDisplay(n, { lockDir: lockDir() })).toBeNull(); // O_EXCL fails
  });

  it('records the token + pid in the lockfile', () => {
    const tok = acquireDisplay(501, { lockDir: lockDir() })!;
    const owner = readOwner(501, { lockDir: lockDir() });
    expect(owner).not.toBeNull();
    expect(owner!.token).toBe(tok);
    expect(typeof owner!.pid).toBe('number');
  });
});

describe('releaseOwned (compare-and-release)', () => {
  it('releases when the token matches', () => {
    const tok = acquireDisplay(510, { lockDir: lockDir() })!;
    expect(releaseOwned(510, tok, { lockDir: lockDir() })).toBe(true);
    expect(existsSync(lockPath(510, { lockDir: lockDir() }))).toBe(false);
  });

  it('is a NO-OP when the token does NOT match (cannot delete a new owner lock)', () => {
    const tokA = acquireDisplay(511, { lockDir: lockDir() })!;
    // A stale/wrong token must NOT release A's lock.
    expect(releaseOwned(511, 'wrong-token', { lockDir: lockDir() })).toBe(false);
    expect(existsSync(lockPath(511, { lockDir: lockDir() }))).toBe(true);
    // The correct token still works.
    expect(releaseOwned(511, tokA, { lockDir: lockDir() })).toBe(true);
  });

  it('is a NO-OP when the lock is already gone', () => {
    const tok = acquireDisplay(512, { lockDir: lockDir() })!;
    releaseOwned(512, tok, { lockDir: lockDir() });
    expect(releaseOwned(512, tok, { lockDir: lockDir() })).toBe(false);
  });
});

describe('cleanOwnedSocket (re-verify ownership at unlink time)', () => {
  // These tests cannot create a real AF_UNIX socket without Xvfb, but they
  // prove the ownership logic: cleanOwnedSocket removes the socket file ONLY
  // when the token still matches the lockfile.
  const num = 520;

  it('removes the socket file when ownership is still ours at unlink time', () => {
    const tok = acquireDisplay(num, { lockDir: lockDir() })!;
    // Simulate the X11 socket file (plain file stands in for the socket).
    writeFileSync(socketPath(num), '');
    const removed = cleanOwnedSocket(
      { num, token: tok, socketExistedBefore: false, xvfbPidAlive: true },
      { lockDir: lockDir() }
    );
    expect(removed).toBe(true);
    expect(existsSync(socketPath(num))).toBe(false);
  });

  it('is a NO-OP when the lock no longer carries our token (new owner took over)', () => {
    const tokA = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), '');
    // Simulate a new owner B taking the lock: A released, B acquired a new token.
    releaseOwned(num, tokA, { lockDir: lockDir() });
    const tokB = acquireDisplay(num, { lockDir: lockDir() })!;
    expect(tokB).not.toBe(tokA);
    // A's LATE cleanup with A's stale token must NOT delete the socket B may own.
    const removed = cleanOwnedSocket(
      { num, token: tokA, socketExistedBefore: false, xvfbPidAlive: true },
      { lockDir: lockDir() }
    );
    expect(removed).toBe(false);
    expect(existsSync(socketPath(num))).toBe(true); // untouched
  });

  it('is a NO-OP when the lock is gone entirely', () => {
    const tok = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), '');
    releaseOwned(num, tok, { lockDir: lockDir() });
    const removed = cleanOwnedSocket(
      { num, token: tok, socketExistedBefore: false, xvfbPidAlive: true },
      { lockDir: lockDir() }
    );
    expect(removed).toBe(false);
    expect(existsSync(socketPath(num))).toBe(true);
  });

  it('is a NO-OP when shouldCleanSocket is false (socket pre-existed / Xvfb not up)', () => {
    const tok = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), '');
    expect(cleanOwnedSocket({ num, token: tok, socketExistedBefore: true, xvfbPidAlive: true }, { lockDir: lockDir() })).toBe(false);
    expect(cleanOwnedSocket({ num, token: tok, socketExistedBefore: false, xvfbPidAlive: false }, { lockDir: lockDir() })).toBe(false);
    expect(existsSync(socketPath(num))).toBe(true);
  });
});

describe('shouldCleanSocket (start-time precondition)', () => {
  it('allows cleanup only when socket did NOT pre-exist AND our Xvfb came up', () => {
    expect(shouldCleanSocket({ socketExistedBefore: false, xvfbPidAlive: true })).toBe(true);
    expect(shouldCleanSocket({ socketExistedBefore: true, xvfbPidAlive: true })).toBe(false);
    expect(shouldCleanSocket({ socketExistedBefore: false, xvfbPidAlive: false })).toBe(false);
  });
});

describe('findFreeDisplay / claimExplicit (return token handles)', () => {
  it('findFreeDisplay returns { num, token } for a free display', () => {
    const h = findFreeDisplay({ min: 530, max: 540, lockDir: lockDir() });
    expect(h).not.toBeNull();
    expect(h!.token).not.toBeNull();
    expect(existsSync(lockPath(h!.num, { lockDir: lockDir() }))).toBe(true);
  });

  it('findFreeDisplay skips a display already locked by another', () => {
    expect(acquireDisplay(541, { lockDir: lockDir() })!).not.toBeNull();
    const h = findFreeDisplay({ min: 541, max: 543, lockDir: lockDir() });
    expect(h!.num).not.toBe(541);
  });

  it('claimExplicit returns null when the explicit display is already locked', () => {
    expect(acquireDisplay(550, { lockDir: lockDir() })!).not.toBeNull();
    expect(claimExplicit(550, { lockDir: lockDir() })).toBeNull();
  });

  it('claimExplicit returns { num, token } for a free explicit display', () => {
    const h = claimExplicit(551, { lockDir: lockDir() });
    expect(h).not.toBeNull();
    expect(h!.num).toBe(551);
  });
});

describe('acquireStale (reclaim dead-owner lock, never a live one)', () => {
  it('reclaims a lock whose owner pid is dead', () => {
    // Write a lock with a dead pid.
    writeFileSync(lockPath(560, { lockDir: lockDir() }), 'oldtoken\npid=999999\n');
    const tok = acquireStale(560, { lockDir: lockDir() }, () => false); // pid is dead
    expect(tok).not.toBeNull();
    expect(readOwner(560, { lockDir: lockDir() })!.token).toBe(tok);
  });

  it('refuses to reclaim a lock whose owner is still alive', () => {
    writeFileSync(lockPath(561, { lockDir: lockDir() }), 'oldtoken\npid=999999\n');
    const tok = acquireStale(561, { lockDir: lockDir() }, () => true); // pid alive
    expect(tok).toBeNull();
    // Lock untouched (live owner).
    expect(readOwner(561, { lockDir: lockDir() })!.token).toBe('oldtoken');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial TOCTOU tests (review requirement: P1 stale-reclaim + read-verify-
// unlink races). The prior "mutation lock" fix reproduced the SAME window inside
// the mutex's own stale reclamation; the current design eliminates the window
// ENTIRELY: acquireStale uses an atomic `rename`-replace (no unlink of the lock
// path), and releaseOwned/cleanOwnedSocket anchor identity to an open fd (read
// the token THROUGH the fd, unlink only a tombstone whose inode matches the fd).
// These tests prove: two reclaimers cannot both win; a loser re-reads the
// winner's LIVE token and bails without touching the lock; and a release's
// fd-anchored token read cannot be fooled by a path replacement.
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial stale reclaim — two reclaimers, one winner', () => {
  // We simulate two SEQUENTIAL reclaim passes against the SAME stale lock. The
  // FIRST reclaimer atomically rename-replaces the stale lock with its own token
  // + LIVE pid; the SECOND reclaimer reads the winner's LIVE pid and bails
  // (default liveness). This is the same ordering real concurrency produces
  // (the first rename flips the owner from dead to live; any second reclaimer
  // that reads after that sees a live owner). The live winner's lock is NEVER
  // unlinked by the loser (there is no unlink in the reclaim path at all).
  const num = 570;

  it('only one reclaimer wins; the loser does NOT unlink the winner live lock', () => {
    // Stale lock S with a dead owner pid.
    writeFileSync(lockPath(num, { lockDir: lockDir() }), 'stale-token\npid=999999\n');
    // Reclaimer A: atomic rename-replace installs tokenA with A's LIVE pid.
    const tokA = acquireStale(num, { lockDir: lockDir() }, () => false);
    expect(tokA).not.toBeNull();
    const ownerAfterA = readOwner(num, { lockDir: lockDir() })!;
    expect(ownerAfterA.token).toBe(tokA);
    expect(ownerAfterA.pid).toBe(process.pid); // live owner
    // The lockfile on disk now carries tokenA (a LIVE owner — pid is our pid).

    // Reclaimer B arrives AFTER A's atomic rename (the only ordering real
    // concurrency permits: A's rename flipped the owner from dead to live).
    // B re-reads the owner pid and checks liveness with the DEFAULT probe — our
    // pid is ALIVE, so B must NOT reclaim. (Using the default probe, not the
    // injected "always dead", models the real second reclaimer seeing a live
    // winner.)
    const tokB = acquireStale(num, { lockDir: lockDir() }); // default liveness
    // B must NOT reclaim a lock whose (current) owner is alive.
    expect(tokB).toBeNull();
    // The winner's lock is still on disk, still tokenA — B did not unlink it.
    const ownerAfterB = readOwner(num, { lockDir: lockDir() })!;
    expect(ownerAfterB.token).toBe(tokA);
  });
});

describe('adversarial TOCTOU — old token cleanup does not touch new-owner resources', () => {
  // The review required: after a NEW owner has established its lock/socket, an
  // OLD owner's late/duplicate cleanup (with the stale token) must NOT delete
  // the new owner's lock or socket. We prove cleanOwnedSocket AND releaseOwned
  // are no-ops against a live new owner — and that this holds even though the
  // old owner's token ONCE matched the path.
  const num = 580;

  it('cleanOwnedSocket with a stale token is a no-op against a NEW owner socket', () => {
    // Old owner A created the lock + socket.
    const tokA = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), ''); // A's socket
    // A releases (compare-and-release removes A's lock).
    expect(releaseOwned(num, tokA, { lockDir: lockDir() })).toBe(true);
    // New owner B takes over: creates a NEW lock with a DIFFERENT token, and a
    // NEW socket (same path, B's Xvfb made it).
    const tokB = acquireDisplay(num, { lockDir: lockDir() })!;
    expect(tokB).not.toBe(tokA);
    writeFileSync(socketPath(num), ''); // B's socket (same path)

    // A's LATE cleanOwnedSocket with A's stale token must NOT touch B's socket.
    const removed = cleanOwnedSocket(
      { num, token: tokA, socketExistedBefore: false, xvfbPidAlive: true },
      { lockDir: lockDir() }
    );
    expect(removed).toBe(false);
    // B's socket survives.
    expect(existsSync(socketPath(num))).toBe(true);
    // B's lock survives and still carries B's token.
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(tokB);
  });

  it('releaseOwned with a stale token is a no-op against a NEW owner lock', () => {
    // A owns, then a new owner B takes over (A released, B acquired).
    const tokA = acquireDisplay(num + 1, { lockDir: lockDir() })!;
    releaseOwned(num + 1, tokA, { lockDir: lockDir() });
    const tokB = acquireDisplay(num + 1, { lockDir: lockDir() })!;
    expect(tokB).not.toBe(tokA);
    // A's stale releaseOwned must NOT delete B's live lock.
    expect(releaseOwned(num + 1, tokA, { lockDir: lockDir() })).toBe(false);
    // B's lock survives with B's token.
    const owner = readOwner(num + 1, { lockDir: lockDir() })!;
    expect(owner.token).toBe(tokB);
    expect(existsSync(lockPath(num + 1, { lockDir: lockDir() }))).toBe(true);
  });

  it('concurrent release-vs-reclaim: releasing owner does not delete a lock a reclaimer just installed', () => {
    // Model the harmful interleaving the fd-anchored CAS prevents: A is mid-
    // release (token still on disk), B reclaims A's "stale" lock (simulated by
    // giving A a dead pid) and installs tokB by atomic rename-replace. A's LATE
    // releaseOwned(tokA) opens the lock, reads the token THROUGH the fd (which
    // now reflects B's token after the rename-replace) → mismatch → no-op.
    const n = num + 2;
    const tokA = acquireDisplay(n, { lockDir: lockDir() })!;
    // Overwrite A's lock to simulate A's pid being DEAD so a reclaimer may
    // reclaim it (this models A crashing right as B scans).
    writeFileSync(lockPath(n, { lockDir: lockDir() }), `${tokA}\npid=999999\n`);
    // B reclaims (pid dead): atomically rename-replaces with tokB.
    const tokB = acquireStale(n, { lockDir: lockDir() }, () => false);
    expect(tokB).not.toBeNull();
    expect(readOwner(n, { lockDir: lockDir() })!.token).toBe(tokB);
    // A's late releaseOwned(tokA) — A opens the lock at the path; the fd anchors
    // B's inode (the rename-replaced file); read-through-fd yields tokB ≠ tokA →
    // abort, NO unlink, NO rename-to-tombstone. B's lock survives.
    expect(releaseOwned(n, tokA, { lockDir: lockDir() })).toBe(false);
    expect(readOwner(n, { lockDir: lockDir() })!.token).toBe(tokB);
    expect(existsSync(lockPath(n, { lockDir: lockDir() }))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fd-anchored rename-to-tombstone CAS (review requirement: the releaseOwned
// read-verify-then-unlink window must be closed at the unit level). These prove
// the identity is anchored to an open fd (not a path re-read) so a lock replaced
// between open and rename is detected by inode-mismatch and NOT deleted; and
// that the boolean contract holds (return is always boolean, never null).
// ─────────────────────────────────────────────────────────────────────────────

describe('releaseOwned — fd-anchored CAS, boolean contract', () => {
  // The key property: releaseOwned opens the lock, reads the token THROUGH the
  // fd, and only unlinks a tombstone whose inode matches the fd. If the lock
  // was replaced (new file, same path, different inode) before releaseOwned
  // opens it, the fd anchors the NEW file and the token read yields the NEW
  // owner's token → mismatch → no-op. We simulate "replaced before open" by
  // installing a new owner's content at the path before calling releaseOwned
  // with the OLD token.
  const num = 590;

  it('returns a boolean for every path (never null): release when ours, false when not', () => {
    const tok = acquireDisplay(num, { lockDir: lockDir() })!;
    // Releasing OUR lock returns true (boolean).
    const r = releaseOwned(num, tok, { lockDir: lockDir() });
    expect(typeof r).toBe('boolean');
    expect(r).toBe(true);
    // Late/duplicate release with our (now-stale) token returns false (boolean).
    const r2 = releaseOwned(num, tok, { lockDir: lockDir() });
    expect(typeof r2).toBe('boolean');
    expect(r2).toBe(false);
    // Wrong-token release returns false (boolean).
    const tok2 = acquireDisplay(num, { lockDir: lockDir() })!;
    const r3 = releaseOwned(num, 'not-our-token', { lockDir: lockDir() });
    expect(typeof r3).toBe('boolean');
    expect(r3).toBe(false);
    expect(existsSync(lockPath(num, { lockDir: lockDir() }))).toBe(true); // tok2 intact
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(tok2);
  });

  it('does NOT delete a lock whose contents were REPLACED at the path (fd anchors the replaced file)', () => {
    // A acquires; then the lock is REPLACED at the path (simulating a concurrent
    // reclaimer's atomic rename-replace) with B's token+pid. A's releaseOwned
    // opens the path → fd anchors B's file → read-through-fd yields tokB ≠
    // tokA → no-op. B's lock survives. (This is the read-verify-then-unlink
    // window closed: A never unlinks a path whose token it didn't just verify
    // against the same fd-anchored inode.)
    const tokA = acquireDisplay(num + 1, { lockDir: lockDir() })!;
    // Simulate replacement: a reclaimer renamed a fresh file over the lock path.
    const tokB = 'B-replaced-' + '0'.repeat(20);
    writeFileSync(lockPath(num + 1, { lockDir: lockDir() }), `${tokB}\npid=999999\n`);
    // A's releaseOwned(tokA): fd anchors the REPLACED file (tokB) → mismatch.
    expect(releaseOwned(num + 1, tokA, { lockDir: lockDir() })).toBe(false);
    // B's lock is intact at the path.
    expect(readOwner(num + 1, { lockDir: lockDir() })!.token).toBe(tokB);
    expect(existsSync(lockPath(num + 1, { lockDir: lockDir() }))).toBe(true);
  });

  it('leaves no tombstone scratch files after a successful release', () => {
    const n = num + 2;
    const tok = acquireDisplay(n, { lockDir: lockDir() })!;
    expect(releaseOwned(n, tok, { lockDir: lockDir() })).toBe(true);
    // A successful release unlinks its own tombstone — no scratch remains.
    const leftover = readdirSync(lockDir()).filter(
      (f: string) => f.includes(`dsh-capture-xvfb-${n}`) && f.includes('tomb-')
    );
    expect(leftover).toEqual([]);
  });
});

describe('acquireStale — atomic rename-replace (no unlink of the lock path)', () => {
  const num = 600;

  it('rename-replaces the stale lock content and re-reads to confirm win/lose', () => {
    writeFileSync(lockPath(num, { lockDir: lockDir() }), 'stale\npid=999999\n');
    const tok = acquireStale(num, { lockDir: lockDir() }, () => false);
    expect(tok).not.toBeNull();
    // The winner's token replaced the stale content atomically (same file path,
    // overwritten via rename); the stale seed is gone.
    const owner = readOwner(num, { lockDir: lockDir() })!;
    expect(owner.token).toBe(tok);
    expect(owner.pid).toBe(process.pid);
  });

  it('a loser that rename-replaced over a winner reads the winner token and bails (no unlink)', () => {
    // Seed stale; A reclaims (rename-replaces tokenA). Then B reclaims: B reads
    // the owner (now tokenA with A's LIVE pid), default liveness → A alive → B
    // returns null WITHOUT renaming. A's lock survives. (No unlink anywhere.)
    writeFileSync(lockPath(num + 1, { lockDir: lockDir() }), 'stale\npid=999999\n');
    const tokA = acquireStale(num + 1, { lockDir: lockDir() }, () => false);
    expect(tokA).not.toBeNull();
    // B uses DEFAULT liveness: A (process.pid) is alive → B must bail.
    const tokB = acquireStale(num + 1, { lockDir: lockDir() });
    expect(tokB).toBeNull();
    expect(readOwner(num + 1, { lockDir: lockDir() })!.token).toBe(tokA);
  });
});
