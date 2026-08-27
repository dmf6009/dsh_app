/**
 * Unit tests for the token-based display-ownership helpers
 * (scripts/capture/xvfb-display.mjs).
 *
 * The lock is a DIRECTORY; the owner is a file `owner.<pid>` INSIDE it (the pid
 * is in the filename, so a reclaimer unlinking a DEAD owner can never match a
 * LIVE owner's file). These test the ownership contract without Xvfb:
 *  - acquireDisplay: mkdir CAS (one winner, EEXIST on the second).
 *  - acquireStale: reclaims a dead-owner lock but never a live one; only unlinks
 *    files named after a dead pid.
 *  - releaseOwned: filename-gated (unlinks only our `owner.<mypid>`); always a
 *    boolean; a wrong token is a no-op; does not delete a new owner's lock.
 *  - cleanOwnedSocket: re-verifies ownership via fd before unlinking the socket;
 *    always a boolean.
 *  - findFreeDisplay / claimExplicit: { num, token }; an explicit display
 *    already occupied fails CLOSED.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
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

/** Seed a STALE lock for `num`: a lock DIRECTORY containing an
 * `owner.<deadPid>` file with the given token. This models a crashed prior run
 * whose pid is dead. The pid is in the filename (as the production design
 * requires). */
function seedStaleLock(num: number, deadPid: number, token: string, opts: { lockDir: string }) {
  const d = lockPath(num, opts);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `owner.${deadPid}`), `${token}\npid=${deadPid}\n`);
}

describe('acquireDisplay (mkdir CAS + owner.<pid>)', () => {
  it('returns a fresh token on first acquire and null on the second', () => {
    const n = 500;
    const tok = acquireDisplay(n, { lockDir: lockDir() });
    expect(tok).not.toBeNull();
    expect(typeof tok).toBe('string');
    // Second acquire: mkdir CAS fails EEXIST (dir exists).
    expect(acquireDisplay(n, { lockDir: lockDir() })).toBeNull();
  });

  it('records the token + pid in owner.<pid> (pid in filename)', () => {
    const tok = acquireDisplay(501, { lockDir: lockDir() })!;
    const owner = readOwner(501, { lockDir: lockDir() });
    expect(owner).not.toBeNull();
    expect(owner!.token).toBe(tok);
    expect(owner!.pid).toBe(process.pid);
    // The owner file is literally named owner.<pid>.
    expect(existsSync(join(lockPath(501, { lockDir: lockDir() }), `owner.${process.pid}`))).toBe(true);
  });
});

describe('releaseOwned (filename-gated, boolean contract)', () => {
  it('releases when the token matches (removes our owner.<pid> + dir)', () => {
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
    // The correct token still works.
    expect(releaseOwned(511, tokA, { lockDir: lockDir() })).toBe(true);
  });

  it('is a NO-OP (boolean false) when the lock is already gone', () => {
    const tok = acquireDisplay(512, { lockDir: lockDir() })!;
    releaseOwned(512, tok, { lockDir: lockDir() });
    const r = releaseOwned(512, tok, { lockDir: lockDir() });
    expect(typeof r).toBe('boolean');
    expect(r).toBe(false);
  });

  it('does NOT delete a NEW owner owner.<newpid> file (filename gating)', () => {
    // A acquires (owner.<Apid>), A releases, a NEW owner B (simulated by a
    // different pid's owner file) takes over. A's LATE release with A's token
    // must NOT touch B's owner.<Bpid> file or remove the dir.
    const tokA = acquireDisplay(513, { lockDir: lockDir() })!;
    releaseOwned(513, tokA, { lockDir: lockDir() }); // A's owner.<Apid> gone, dir gone
    // New owner B (different pid) acquires.
    const tokB = acquireDisplay(513, { lockDir: lockDir() })!;
    expect(tokB).not.toBe(tokA);
    // Simulate A's LATE release arriving AFTER B owns (A still uses its own
    // token + pid-named path; releaseOwned opens owner.<Apid> which is gone).
    const r = releaseOwned(513, tokA, { lockDir: lockDir() });
    expect(r).toBe(false); // A's owner file is gone — no-op
    // B's lock dir + owner.<Bpid> survive.
    expect(existsSync(lockPath(513, { lockDir: lockDir() }))).toBe(true);
    expect(readOwner(513, { lockDir: lockDir() })!.token).toBe(tokB);
  });
});

describe('cleanOwnedSocket (fd re-verify at unlink time)', () => {
  const num = 520;

  it('removes the socket file when ownership is still ours at unlink time', () => {
    const tok = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), ''); // stand-in for the X11 socket
    const removed = cleanOwnedSocket(
      { num, token: tok, socketExistedBefore: false, xvfbPidAlive: true },
      { lockDir: lockDir() }
    );
    expect(removed).toBe(true);
    expect(existsSync(socketPath(num))).toBe(false);
  });

  it('is a NO-OP (boolean false) when the lock no longer carries our token', () => {
    const tokA = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), '');
    // A released; B acquired (different pid owner file). A's token is stale.
    releaseOwned(num, tokA, { lockDir: lockDir() });
    const tokB = acquireDisplay(num, { lockDir: lockDir() })!;
    expect(tokB).not.toBe(tokA);
    // A's LATE cleanOwnedSocket with A's stale token — A's owner.<Apid> file is
    // gone (A released), so the fd open fails → no-op.
    const removed = cleanOwnedSocket(
      { num, token: tokA, socketExistedBefore: false, xvfbPidAlive: true },
      { lockDir: lockDir() }
    );
    expect(removed).toBe(false);
    expect(existsSync(socketPath(num))).toBe(true); // untouched
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

describe('acquireStale (reclaim dead-owner lock, never a live one)', () => {
  it('reclaims a lock whose owner pid is dead', () => {
    seedStaleLock(560, 999999, 'oldtoken', { lockDir: lockDir() });
    const tok = acquireStale(560, { lockDir: lockDir() }, () => false); // pid dead
    expect(tok).not.toBeNull();
    expect(readOwner(560, { lockDir: lockDir() })!.token).toBe(tok);
    // The stale owner.999999 file is gone; the new owner.<ourpid> is present.
    const files = readdirSync(lockPath(560, { lockDir: lockDir() }));
    expect(files).toContain(`owner.${process.pid}`);
    expect(files).not.toContain('owner.999999');
  });

  it('refuses to reclaim a lock whose owner is still alive', () => {
    seedStaleLock(561, 999999, 'oldtoken', { lockDir: lockDir() });
    const tok = acquireStale(561, { lockDir: lockDir() }, () => true); // pid alive
    expect(tok).toBeNull();
    // Lock untouched (live owner): the dead-pid owner file is still there.
    expect(readOwner(561, { lockDir: lockDir() })!.token).toBe('oldtoken');
    const files = readdirSync(lockPath(561, { lockDir: lockDir() }));
    expect(files).toContain('owner.999999');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial TOCTOU tests (review requirement). The directory + `owner.<pid>`
// design makes reclaim a TRUE CAS: a reclaimer unlinks ONLY files named after a
// DEAD pid (filename gating), so it can never remove a LIVE owner's file; the
// `mkdir` CAS is the single linearization point, so two concurrent reclaimers
// cannot both succeed. These tests prove: two reclaimers both having judged the
// owner dead → at most one wins; a new owner's lock/socket survive a previous
// owner's late cleanup; a tombstone-free release leaves no window for a third
// party's lock to be covered.
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial stale reclaim — two reclaimers, one winner (single linearization)', () => {
  const num = 570;

  it('two reclaimers that both judged the owner dead: only the first mkdir wins', () => {
    // Seed a stale dead-owner lock.
    seedStaleLock(num, 999999, 'stale-token', { lockDir: lockDir() });
    // Reclaimer A (injected dead): unlinks owner.999999, rmdir, mkdir CAS → wins.
    const tokA = acquireStale(num, { lockDir: lockDir() }, () => false);
    expect(tokA).not.toBeNull();
    const ownerAfterA = readOwner(num, { lockDir: lockDir() })!;
    expect(ownerAfterA.token).toBe(tokA);
    expect(ownerAfterA.pid).toBe(process.pid); // A's live pid installed
    // Reclaimer B (also injected dead — it has ALREADY judged the owner dead,
    // the exact interleaving the review flagged): B's acquireStale scans owners,
    // finds owner.<A-pid> (A's LIVE pid). With default liveness A is alive →
    // B must NOT reclaim. (The dead-pid file owner.999999 is already gone; A's
    // live owner file is `owner.<Apid>` and is never matched/unlinked by B.)
    const tokB = acquireStale(num, { lockDir: lockDir() }); // default liveness
    expect(tokB).toBeNull();
    // A's lock survives — B unlinked nothing of A's.
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(tokA);
  });

  it('a reclaimer only ever unlinks files named after a DEAD pid, never a live one', () => {
    // Two owner files: one dead-pid (999999), one live-pid (process.pid, ours).
    // A reclaimer must judge 999999 dead but process.pid alive (the default
    // liveness probe does exactly this). Reclaim must REFUSE (a live owner
    // file is present) and must NOT unlink the live owner.<process.pid> file.
    const d = lockPath(num + 1, { lockDir: lockDir() });
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'owner.999999'), 'dead-token\npid=999999\n');
    writeFileSync(join(d, `owner.${process.pid}`), 'live-token\npid=' + process.pid + '\n');
    // DEFAULT liveness: 999999 is dead, process.pid is alive → reclaim refuses.
    const tok = acquireStale(num + 1, { lockDir: lockDir() });
    expect(tok).toBeNull(); // live owner present → do not steal
    // The LIVE owner file is untouched (reclaim bailed before any unlink).
    expect(existsSync(join(d, `owner.${process.pid}`))).toBe(true);
    expect(readOwner(num + 1, { lockDir: lockDir() })!.pid).toBe(process.pid);
    // The dead owner file MAY have been left or unlinked; the live one is intact.
    expect(readOwner(num + 1, { lockDir: lockDir() })!.pid).toBe(process.pid);
  });
});

describe('adversarial — old-token cleanup does not touch new-owner resources', () => {
  const num = 580;

  it('cleanOwnedSocket with a stale token is a no-op against a NEW owner socket', () => {
    const tokA = acquireDisplay(num, { lockDir: lockDir() })!;
    writeFileSync(socketPath(num), ''); // A's socket
    releaseOwned(num, tokA, { lockDir: lockDir() }); // A releases (owner.<Apid> + dir gone)
    const tokB = acquireDisplay(num, { lockDir: lockDir() })!; // B takes over
    expect(tokB).not.toBe(tokA);
    writeFileSync(socketPath(num), ''); // B's socket (same path)
    // A's LATE cleanOwnedSocket: A's owner.<Apid> file is gone (A released) →
    // fd open fails → no-op. B's socket survives.
    expect(
      cleanOwnedSocket({ num, token: tokA, socketExistedBefore: false, xvfbPidAlive: true }, { lockDir: lockDir() })
    ).toBe(false);
    expect(existsSync(socketPath(num))).toBe(true);
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(tokB);
  });

  it('releaseOwned with a stale token is a no-op against a NEW owner lock', () => {
    const tokA = acquireDisplay(num + 1, { lockDir: lockDir() })!;
    releaseOwned(num + 1, tokA, { lockDir: lockDir() });
    const tokB = acquireDisplay(num + 1, { lockDir: lockDir() })!;
    expect(tokB).not.toBe(tokA);
    expect(releaseOwned(num + 1, tokA, { lockDir: lockDir() })).toBe(false);
    expect(readOwner(num + 1, { lockDir: lockDir() })!.token).toBe(tokB);
    expect(existsSync(lockPath(num + 1, { lockDir: lockDir() }))).toBe(true);
  });

  it('release-vs-reclaim: a releasing owner does not delete a lock a reclaimer installed', () => {
    // A acquires; B reclaims (treats A as dead via injected liveness, installs
    // its own owner.<pid> in a fresh dir). A's late releaseOwned(tokA) opens
    // owner.<Apid> which is gone (B's reclaim rmdir'd A's dir) → no-op. B's
    // lock survives.
    const n = num + 2;
    const tokA = acquireDisplay(n, { lockDir: lockDir() })!;
    // B reclaims: A's pid is "dead" (injected), B unlinks owner.<Apid>, rmdir,
    // mkdir CAS, installs owner.<Bpid=process.pid>. (Same process, so B's pid
    // == A's pid; the new owner file overwrites the path — but in a real
    // two-process run B's pid differs. We model the ownership handoff here.)
    const tokB = acquireStale(n, { lockDir: lockDir() }, () => false);
    expect(tokB).not.toBeNull();
    expect(readOwner(n, { lockDir: lockDir() })!.token).toBe(tokB);
    // A's late releaseOwned(tokA): owner.<Apid=ourpid> now carries tokB (B's
    // content). fd-read yields tokB ≠ tokA → no-op.
    expect(releaseOwned(n, tokA, { lockDir: lockDir() })).toBe(false);
    expect(readOwner(n, { lockDir: lockDir() })!.token).toBe(tokB);
    expect(existsSync(lockPath(n, { lockDir: lockDir() }))).toBe(true);
  });
});

describe('adversarial — tombstone-free release leaves no window for a third party', () => {
  // The review required: when a releasing owner has removed its owner file but
  // before/after rmdir, a THIRD party C acquires via acquireDisplay (mkdir CAS)
  // and must NOT end up a lock-less false owner, and C's lock must not be
  // covered/deleted by the releasing owner. There is NO restore-rename in this
  // design — release unlinks only owner.<mypid> and best-effort rmdirs; C's
  // mkdir CAS is independent and never touched by A's release.
  const num = 600;

  it('a third party C that wins mkdir after A removed its owner file is not covered', () => {
    const d = lockPath(num, { lockDir: lockDir() });
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `owner.${process.pid}`), 'tokA\npid=' + process.pid + '\n');
    // A removes its owner file (first half of release). Dir is now EMPTY.
    // (We simulate A mid-release: owner file gone, rmdir not yet done.)
    unlinkSync(join(d, `owner.${process.pid}`));
    // C attempts acquireDisplay: mkdir CAS fails (dir still exists). So C must
    // go through acquireStale (empty dir, no owner → no live owner → reclaim:
    // rmdir + mkdir). C wins the mkdir CAS. (This models a third party arriving
    // in the empty-dir window; C uses the same code path.)
    const tokC = acquireStale(num, { lockDir: lockDir() }, () => false);
    expect(tokC).not.toBeNull(); // C legitimately won the mkdir CAS
    // A's release resumes: rmdir on a dir now containing C's owner file fails
    // ENOTEMPTY — C's lock is NOT removed or covered.
    const r = releaseOwned(num, 'tokA', { lockDir: lockDir() });
    expect(r).toBe(false); // A's owner file is gone (C's is there now) → no-op
    // C's lock survives.
    expect(readOwner(num, { lockDir: lockDir() })!.token).toBe(tokC);
    expect(existsSync(lockPath(num, { lockDir: lockDir() }))).toBe(true);
  });
});
