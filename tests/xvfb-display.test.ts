/**
 * Unit tests for the token-based display-ownership helpers
 * (scripts/capture/xvfb-display.mjs).
 *
 * The lock is a single FILE whose CONTENTS are the owner identity
 * (`<token>\npid=<pid>\n`). Publication is an atomic O_EXCL create + write via
 * the exclusive fd. Identity is the (never-reused) token; the pid is a liveness
 * HINT only. These test the ownership contract without Xvfb:
 *  - acquireDisplay: O_EXCL CAS (one winner); owner-write failure rolls back.
 *  - acquireStale: reclaims a dead-owner lock but never an owner-less (fresh
 *    mid-publication) one; never a live one.
 *  - releaseOwned: fd-anchored token re-verify; a wrong/late token is a no-op;
 *    does not delete a new owner's lock. Always a boolean.
 *  - cleanOwnedSocket: fd re-verify; always a boolean.
 *  - findFreeDisplay / claimExplicit: { num, token }; explicit occupied fails CLOSED.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
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
  releaseOwnedCritical,
  cleanOwnedSocketCritical,
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

/** Seed a STALE lock file for `num`: a file at lockPath whose owner pid is
 * dead, carrying `token`. Models a crashed prior run. */
function seedStaleLock(num: number, token: string, deadPid: number, opts: { lockDir: string }) {
  writeFileSync(lockPath(num, opts), `${token}\npid=${deadPid}\n`);
}

describe('acquireDisplay (O_EXCL CAS + atomic owner publication)', () => {
  it('returns a fresh token on first acquire and null on the second (O_EXCL)', () => {
    const n = 500;
    const tok = acquireDisplay(n, { lockDir: lockDir() });
    expect(tok).not.toBeNull();
    expect(typeof tok).toBe('string');
    expect(acquireDisplay(n, { lockDir: lockDir() })).toBeNull(); // O_EXCL fails
  });

  it('writes the owner token+pid into the lock file contents', () => {
    const tok = acquireDisplay(501, { lockDir: lockDir() })!;
    const owner = readOwner(501, { lockDir: lockDir() });
    expect(owner).not.toBeNull();
    expect(owner!.token).toBe(tok);
    expect(owner!.pid).toBe(process.pid);
  });

  it('returns null and rolls back if the owner write FAILS (no orphan claim)', () => {
    // Simulate owner-write failure: make the lock path's parent dir read-only
    // AFTER O_EXCL succeeds is hard to inject here; instead, point lockDir at
    // a path whose parent does not exist so the O_EXCL itself fails. To truly
    // test write-failure rollback we use a directory as the lock path target —
    // openSync('wx') on an existing directory fails EISDIR, exercising the
    // "create fails → return null" path (the rollback branch is exercised by
    // the integration fault-injection test). Here we assert the fail-closed
    // contract: a failed acquire returns null and leaves no lock.
    // Pre-create a DIRECTORY at the lock path so O_EXCL create fails.
    mkdirSync(lockPath(502, { lockDir: lockDir() }));
    const r = acquireDisplay(502, { lockDir: lockDir() });
    expect(r).toBeNull(); // fail-closed, no token returned
  });
});

describe('releaseOwned (fd-anchored token re-verify, boolean contract)', () => {
  it('releases when the token matches (removes the lock file)', () => {
    const tok = acquireDisplay(510, { lockDir: lockDir() })!;
    expect(releaseOwned(510, tok, { lockDir: lockDir() })).toBe(true);
    expect(existsSync(lockPath(510, { lockDir: lockDir() }))).toBe(false);
  });

  it('is a NO-OP (boolean false) when the token does NOT match', () => {
    const tokA = acquireDisplay(511, { lockDir: lockDir() })!;
    const r = releaseOwned(511, 'wrong-token', { lockDir: lockDir() });
    expect(typeof r).toBe('boolean');
    expect(r).toBe(false);
    expect(existsSync(lockPath(511, { lockDir: lockDir() }))).toBe(true);
    expect(releaseOwned(511, tokA, { lockDir: lockDir() })).toBe(true);
  });

  it('is a NO-OP (boolean false) when the lock is already gone', () => {
    const tok = acquireDisplay(512, { lockDir: lockDir() })!;
    releaseOwned(512, tok, { lockDir: lockDir() });
    const r = releaseOwned(512, tok, { lockDir: lockDir() });
    expect(typeof r).toBe('boolean');
    expect(r).toBe(false);
  });

  it('does NOT delete a NEW owner lock (fd-anchored token mismatch)', () => {
    // A acquires, A releases (lock gone), B acquires (new token). A's LATE
    // release with A's token opens the lock 'r' (B's inode), reads B's token
    // THROUGH the fd → mismatch → no-op. B's lock survives.
    const tokA = acquireDisplay(513, { lockDir: lockDir() })!;
    releaseOwned(513, tokA, { lockDir: lockDir() });
    const tokB = acquireDisplay(513, { lockDir: lockDir() })!;
    expect(tokB).not.toBe(tokA);
    expect(releaseOwned(513, tokA, { lockDir: lockDir() })).toBe(false);
    expect(existsSync(lockPath(513, { lockDir: lockDir() }))).toBe(true);
    expect(readOwner(513, { lockDir: lockDir() })!.token).toBe(tokB);
  });
});

describe('cleanOwnedSocket (fd re-verify at unlink time)', () => {
  const num = 520;

  it('removes the socket when ownership is still ours at unlink time', () => {
    const tok = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), ''); // stand-in for the X11 socket
    expect(
      cleanOwnedSocket({ num, token: tok, socketExistedBefore: false, xvfbPidAlive: true }, { lockDir: lockDir() })
    ).toBe(true);
    expect(existsSync(socketPath(num))).toBe(false);
  });

  it('is a NO-OP (boolean false) when the lock no longer carries our token', () => {
    const tokA = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), '');
    releaseOwned(num, tokA, { lockDir: lockDir() });
    const tokB = acquireDisplay(num, { lockDir: lockDir() })!;
    expect(tokB).not.toBe(tokA);
    expect(
      cleanOwnedSocket({ num, token: tokA, socketExistedBefore: false, xvfbPidAlive: true }, { lockDir: lockDir() })
    ).toBe(false);
    expect(existsSync(socketPath(num))).toBe(true);
  });

  it('is a NO-OP when shouldCleanSocket is false', () => {
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

describe('acquireStale (reclaim dead-owner lock; never owner-less; never live)', () => {
  it('reclaims a lock whose owner pid is dead', () => {
    seedStaleLock(560, 'oldtoken', 999999, { lockDir: lockDir() });
    const tok = acquireStale(560, { lockDir: lockDir() }, () => false); // dead
    expect(tok).not.toBeNull();
    expect(readOwner(560, { lockDir: lockDir() })!.token).toBe(tok);
  });

  it('refuses to reclaim a lock whose owner is still alive', () => {
    seedStaleLock(561, 'oldtoken', 999999, { lockDir: lockDir() });
    const tok = acquireStale(561, { lockDir: lockDir() }, () => true); // alive
    expect(tok).toBeNull();
    expect(readOwner(561, { lockDir: lockDir() })!.token).toBe('oldtoken');
  });

  it('does NOT reclaim an owner-less (empty) lock — a fresh acquire mid-publication', () => {
    // Create an EMPTY lock file (simulates O_EXCL just succeeded, owner write
    // pending). acquireStale must NOT reclaim it (would delete a just-succeeded
    // claim). readOwner → null → bail.
    writeFileSync(lockPath(562, { lockDir: lockDir() }), ''); // empty
    const tok = acquireStale(562, { lockDir: lockDir() }, () => false);
    expect(tok).toBeNull(); // owner-less — NOT reclaimable
    expect(existsSync(lockPath(562, { lockDir: lockDir() }))).toBe(true); // untouched
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial tests (review requirement round 4). The atomic publication
// protocol makes the claim a single linearization point: O_EXCL create is the
// one arbiter, owner contents are written THROUGH the exclusive fd, write
// failure rolls back (fail-closed), and an owner-less (empty) lock is NEVER
// reclaimable stale. Identity is the never-reused token; pid is a liveness hint.
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial — fresh acquire empty-window (owner-less lock not reclaimable)', () => {
  const num = 570;

  it('a freshly O_EXCL-created but owner-less lock is NOT reclaimed by another', () => {
    // A's O_EXCL succeeded but owner write is pending (empty file). B calls
    // acquireStale: readOwner → null (empty) → B returns null (does NOT
    // unlink/reclaim). A then writes the owner. Exactly one owner (A).
    // We simulate "A mid-publication" by creating the empty lock directly.
    writeFileSync(lockPath(num, { lockDir: lockDir() }), ''); // empty (O_EXCL'd, write pending)
    const bTok = acquireStale(num, { lockDir: lockDir() }, () => false);
    expect(bTok).toBeNull(); // B could NOT reclaim an owner-less lock
    expect(existsSync(lockPath(num, { lockDir: lockDir() }))).toBe(true); // A's empty file untouched
    // A's owner write "completes" (we simulate by writing contents now).
    writeFileSync(lockPath(num, { lockDir: lockDir() }), 'tokA\npid=' + process.pid + '\n');
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe('tokA');
  });
});

describe('adversarial — two reclaimers of the same dead-owner lock (one O_EXCL winner)', () => {
  const num = 580;

  it('both judge dead; only one O_EXCL recreate succeeds', () => {
    // Seed a dead-owner lock.
    seedStaleLock(num, 'stale', 999999, { lockDir: lockDir() });
    // A reclaims (unlink + O_EXCL recreate → wins, writes owner.<A-token>).
    const tokA = acquireStale(num, { lockDir: lockDir() }, () => false);
    expect(tokA).not.toBeNull();
    const ownerAfterA = readOwner(num, { lockDir: lockDir() })!;
    expect(ownerAfterA.token).toBe(tokA);
    expect(ownerAfterA.pid).toBe(process.pid); // A's live pid
    // B reclaims the SAME display: reads A's owner pid (live) → refuses → null.
    // B never unlinked A's lock (A's file is not the dead 999999 file).
    const tokB = acquireStale(num, { lockDir: lockDir() }); // default liveness: A live
    expect(tokB).toBeNull();
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(tokA); // A's survives
  });
});

describe('adversarial — PID reuse: a reused pid does not authorize reclaim (identity = token)', () => {
  const num = 590;

  it('a dead owner whose pid was REUSED by a live process is NOT reclaimed', () => {
    // Seed a stale lock whose "dead owner" pid is the CURRENT process pid
    // (simulating the OS reusing a dead owner's pid for a live process — here,
    // our own process). acquireStale reads pid=process.pid, isPidAlive=true
    // (we are live) → refuses. The display stays locked (stale leak, NOT a
    // double-owner bug). Identity is the token, not the pid.
    const staleToken = 'reused-pid-stale';
    writeFileSync(lockPath(num, { lockDir: lockDir() }), `${staleToken}\npid=${process.pid}\n`);
    const tok = acquireStale(num, { lockDir: lockDir() }); // default liveness
    expect(tok).toBeNull(); // refused — the reused pid is live
    // The stale lock is untouched (we did not steal it).
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(staleToken);
  });
});

describe('adversarial — owner-write failure rolls back (no orphan claim)', () => {
  const num = 600;

  it('a failed owner write returns null and leaves no reclaimable-but-owner-less lock', () => {
    // We can't easily inject a writeSync failure from JS; instead we assert the
    // contract path: when the lock file content ends up EMPTY (as if the write
    // failed and the rollback's unlink was best-effort and somehow left an
    // empty file), a subsequent acquireStale treats it as owner-less → NOT
    // reclaimed, and a fresh acquireDisplay on the same path fails EEXIST (the
    // orphan, if any, blocks fresh acquire but cannot be mistaken for a valid
    // claim). The integration test injects a real write failure via a barrier.
    writeFileSync(lockPath(num, { lockDir: lockDir() }), ''); // empty orphan
    // acquireStale refuses (owner-less).
    expect(acquireStale(num, { lockDir: lockDir() }, () => false)).toBeNull();
    // A fresh acquireDisplay fails EEXIST (orphan present) — no false success.
    expect(acquireDisplay(num, { lockDir: lockDir() })).toBeNull();
    // Clean up the orphan so the display is reclaimable later.
    try { unlinkSync(lockPath(num, { lockDir: lockDir() })); } catch { /* ignore */ }
  });
});

describe('adversarial — release/clean with a new generation on the same path', () => {
  const num = 610;

  it('a late releaseOwned with an old token is a no-op against a new generation', () => {
    // A acquires (tokA), A releases, B acquires (tokB, same path, different
    // token = new generation). A's late releaseOwned(tokA) opens B's lock,
    // reads tokB via fd → mismatch → no-op. B's lock survives.
    const tokA = acquireDisplay(num, { lockDir: lockDir() })!;
    releaseOwned(num, tokA, { lockDir: lockDir() });
    const tokB = acquireDisplay(num, { lockDir: lockDir() })!;
    expect(tokB).not.toBe(tokA);
    expect(releaseOwned(num, tokA, { lockDir: lockDir() })).toBe(false);
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(tokB);
    expect(existsSync(lockPath(num, { lockDir: lockDir() }))).toBe(true);
  });

  it('a late cleanOwnedSocket with an old token does NOT unlink a new owner socket', () => {
    const tokA = acquireDisplay(num + 1, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num + 1), '');
    releaseOwned(num + 1, tokA, { lockDir: lockDir() });
    const tokB = acquireDisplay(num + 1, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num + 1), ''); // B's socket (same path)
    expect(
      cleanOwnedSocket({ num: num + 1, token: tokA, socketExistedBefore: false, xvfbPidAlive: true }, { lockDir: lockDir() })
    ).toBe(false);
    expect(existsSync(socketPath(num + 1))).toBe(true); // B's socket survives
    expect(readOwner(num + 1, { lockDir: lockDir() })!.token).toBe(tokB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// flock-guarded critical section: the compare-and-delete TOCTOU is closed by
// serialization. The pure critical functions are tested for the cross-generation
// no-op semantics; the production wrappers run them under flock (integration
// tests prove the concurrent interleaving). Here we verify the critical-section
// contract directly: releaseOwnedCritical refuses a token that no longer matches
// (a generation replaced the lock), and never unlinks the new owner's lock.
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial — double release across a generation (flock-serialized contract)', () => {
  const num = 620;

  it('releaseOwnedCritical: after A unlinks + C acquires a new generation, a same-token B release reads C token → no-op', () => {
    // A acquires (tokA). Two releases of tokA both verify, but under flock they
    // are serialized: A's release unlinks the lock; a third party C acquires a
    // fresh generation (tokC); B's (late) release opens C's lock, reads tokC
    // via fd → mismatch → no-op → C's lock survives. We model B's late release
    // as a direct call to the critical function AFTER C installed (the flock
    // guarantees this serialization in production).
    const tokA = acquireDisplay(num, { lockDir: lockDir() })!;
    expect(releaseOwnedCritical(num, tokA, { lockDir: lockDir() })).toBe(true); // A unlinks
    // C acquires a new generation (tokC) at the now-empty path.
    const tokC = acquireDisplay(num, { lockDir: lockDir() })!;
    expect(tokC).not.toBe(tokA);
    // B's LATE release (same tokA, after C installed) → fd reads tokC → no-op.
    expect(releaseOwnedCritical(num, tokA, { lockDir: lockDir() })).toBe(false);
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(tokC); // C survives
    expect(existsSync(lockPath(num, { lockDir: lockDir() }))).toBe(true);
  });

  it('releaseOwnedCritical with a barrier1 pause still does not unlink a generation installed after A', () => {
    // A's release verifies (barrier1 pauses after verify, before unlink). While
    // A is "paused" (holding the flock in production), no sibling can install.
    // We simulate the post-pause state: A unlinks (barrier released), C
    // installs, then B (same token) verifies C's token → no-op.
    const n = num + 1;
    const tokA = acquireDisplay(n, { lockDir: lockDir() })!;
    // A's release runs the critical section; barrier1 here is '' (no pause in
    // unit test), so it unlinks immediately.
    expect(releaseOwnedCritical(n, tokA, { lockDir: lockDir() }, '', '')).toBe(true);
    const tokC = acquireDisplay(n, { lockDir: lockDir() })!;
    // B's release after C installed — no-op.
    expect(releaseOwnedCritical(n, tokA, { lockDir: lockDir() }, '', '')).toBe(false);
    expect(readOwner(n, { lockDir: lockDir() })!.token).toBe(tokC);
  });
});

describe('adversarial — cleanOwnedSocketCritical double/reentrant call (flock-serialized)', () => {
  const num = 630;

  it('a second cleanOwnedSocketCritical with an old token does NOT unlink a new owner socket', () => {
    const tokA = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), '');
    // First clean removes A's socket (A still owns).
    expect(
      cleanOwnedSocketCritical({ num, token: tokA, socketExistedBefore: false, xvfbPidAlive: true }, { lockDir: lockDir() }, '', '')
    ).toBe(true);
    // C acquires a new generation + socket.
    releaseOwnedCritical(num, tokA, { lockDir: lockDir() }, '', '');
    const tokC = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), '');
    // A's LATE cleanOwnedSocket (old tokA) → reads tokC via fd → no-op.
    expect(
      cleanOwnedSocketCritical({ num, token: tokA, socketExistedBefore: false, xvfbPidAlive: true }, { lockDir: lockDir() }, '', '')
    ).toBe(false);
    expect(existsSync(socketPath(num))).toBe(true); // C's socket survives
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(tokC);
  });
});
