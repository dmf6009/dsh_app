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
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
