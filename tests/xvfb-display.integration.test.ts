/**
 * REAL-Xvfb integration tests for conflict-free display allocation
 * (scripts/capture/xvfb-display.mjs + the launcher's Xvfb management).
 *
 * The review required proof that: two concurrent captures get DISTINCT
 * displays; an explicit display already in use fails CLOSED and leaves the
 * existing server/socket usable; and no run deletes a shared X11 socket it
 * did not create. These tests actually start Xvfb processes.
 *
 * Skips (exit 0) when the Xvfb binary or `xauth`/`mcookie` are unavailable,
 * so CI without X tooling doesn't false-fail — the pure ownership contract is
 * still covered by tests/xvfb-display.test.ts.
 *
 * Reliable cleanup: every started Xvfb is tree-killed in afterEach/finally,
 * and every claimed display lock is released, so a failure cannot leak Xvfb
 * processes or lockfiles.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import {
  claimExplicit,
  cleanOwnedSocket,
  displayOccupied,
  findFreeDisplay,
  readOwner,
  releaseOwned,
  socketPath,
  shouldCleanSocket
} from '../scripts/capture/xvfb-display.mjs';
import { isPidAliveSync, treeKill } from '../scripts/capture/proc-tree.mjs';

function hasBin(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const XVFB_AVAILABLE = process.platform === 'linux' && hasBin('Xvfb') && hasBin('mcookie');
const skipNoXvfb = XVFB_AVAILABLE ? () => false : () => true;

/** Start a real Xvfb on `displayNum` with a private Xauthority, return handles. */
function startXvfb(displayNum: number) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'dsh-xvfb-int-'));
  const authFile = join(tmpDir, 'Xauthority');
  execFileSync('touch', [authFile], { stdio: 'ignore' });
  const mcookie = execFileSync('mcookie', [], { encoding: 'utf8' }).trim();
  try {
    execFileSync('xauth', ['-f', authFile, 'add', `:${displayNum}`, '.', mcookie], { stdio: 'ignore' });
  } catch {
    /* xauth optional */
  }
  const child = spawn(
    'Xvfb',
    [`:${displayNum}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp', '-auth', authFile],
    { detached: true, stdio: 'ignore', env: { ...process.env, XAUTHORITY: authFile } }
  );
  child.unref();
  return { child, tmpDir, authFile };
}

/** Wait for Xvfb's socket to appear (bounded). */
async function waitForSocket(displayNum: number, pid: number | undefined, deadlineMs = 6000) {
  const sock = socketPath(displayNum);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (pid && !isPidAliveSync(pid)) return false;
    if (existsSync(sock)) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

/** All Xvfb processes we started, for reliable cleanup. Each carries the
 * owner TOKEN for its display so cleanup uses compare-and-release — a test
 * never deletes a socket/lock whose token it no longer holds. */
const started: Array<{
  child: { pid?: number | null } | null;
  tmpDir?: string;
  displayNum?: number;
  token?: string;
  lockDir?: string;
}> = [];

function reapHandle(h: (typeof started)[number]) {
  if (h.child && h.child.pid) {
    try {
      treeKill({ pid: h.child.pid, signal: 'SIGKILL', graceMs: 500 });
    } catch {
      /* dead */
    }
  }
  if (h.tmpDir) {
    try {
      rmSync(h.tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  // Compare-and-release cleanup using THIS test's token. cleanOwnedSocket
  // removes the socket ONLY IF our token still owns the lock; releaseOwned
  // removes the lock ONLY IF our token still matches. A foreign/overwritten
  // token is a no-op — we never touch another owner's socket/lock.
  if (h.displayNum !== undefined && h.token && h.lockDir) {
    const xvfbPidAlive = !!(h.child && h.child.pid && isPidAliveSync(h.child.pid));
    try {
      cleanOwnedSocket(
        { num: h.displayNum, token: h.token, socketExistedBefore: false, xvfbPidAlive },
        { lockDir: h.lockDir }
      );
      releaseOwned(h.displayNum, h.token, { lockDir: h.lockDir });
    } catch {
      /* best effort */
    }
  }
}

beforeEach(() => {
  started.length = 0;
});
afterEach(() => {
  for (const h of started) reapHandle(h);
});

describe('real Xvfb — conflict-free display allocation', { skip: skipNoXvfb() }, () => {
  it('two concurrent Xvfb starts get DISTINCT displays (no socket clash)', async () => {
    // Run A: allocate a display (with token) and start Xvfb on it.
    const lockDirA = mkdtempSync(join(tmpdir(), 'dsh-xvfb-A-'));
    const hA = findFreeDisplay({ min: 620, max: 660, lockDir: lockDirA });
    expect(hA).not.toBeNull();
    const a = startXvfb(hA!.num);
    started.push({ child: a.child, tmpDir: a.tmpDir, displayNum: hA!.num, token: hA!.token, lockDir: lockDirA });
    expect(await waitForSocket(hA!.num, a.child.pid)).toBe(true);

    // Run B: concurrently allocate ANOTHER display — must not pick hA.num.
    const lockDirB = mkdtempSync(join(tmpdir(), 'dsh-xvfb-B-'));
    const hB = findFreeDisplay({ min: 620, max: 660, lockDir: lockDirB });
    expect(hB).not.toBeNull();
    expect(hB!.num).not.toBe(hA!.num);
    expect(hB!.token).not.toBe(hA!.token);
    const b = startXvfb(hB!.num);
    started.push({ child: b.child, tmpDir: b.tmpDir, displayNum: hB!.num, token: hB!.token, lockDir: lockDirB });
    expect(await waitForSocket(hB!.num, b.child.pid)).toBe(true);

    // Both sockets coexist — run A's socket is NOT removed by run B.
    expect(existsSync(socketPath(hA!.num))).toBe(true);
  }, 20000);

  it('explicit DSH_XVFB_DISPLAY already in use → second claim fails CLOSED, existing socket survives', async () => {
    const lockDirA = mkdtempSync(join(tmpdir(), 'dsh-xvfb-exp-A-'));
    const num = 670;
    // Run A occupies num: lock held with A's token, socket comes up.
    const hA = claimExplicit(num, { lockDir: lockDirA });
    expect(hA).not.toBeNull();
    const a = startXvfb(num);
    started.push({ child: a.child, tmpDir: a.tmpDir, displayNum: num, token: hA!.token, lockDir: lockDirA });
    expect(await waitForSocket(num, a.child.pid)).toBe(true);

    // Run B tries the SAME explicit display → claimExplicit must return null
    // (fail-closed), NOT clobber the existing server/lock.
    const lockDirB = mkdtempSync(join(tmpdir(), 'dsh-xvfb-exp-B-'));
    expect(claimExplicit(num, { lockDir: lockDirB })).toBeNull();
    // The existing X server / socket is untouched and still up.
    expect(existsSync(socketPath(num))).toBe(true);
    // A's lock still carries A's token (B did not take over).
    expect(readOwner(num, { lockDir: lockDirA })!.token).toBe(hA!.token);
    rmSync(lockDirB, { recursive: true, force: true });
  }, 20000);

  it('cleanOwnedSocket only removes a socket THIS run still owns — never a pre-existing or taken-over one', async () => {
    // A pre-existing X server on num (run "other") — socket present + locked.
    const lockDirOther = mkdtempSync(join(tmpdir(), 'dsh-xvfb-pre-'));
    const num = 680;
    const hOther = claimExplicit(num, { lockDir: lockDirOther });
    expect(hOther).not.toBeNull();
    const other = startXvfb(num);
    started.push({ child: other.child, tmpDir: other.tmpDir, displayNum: num, token: hOther!.token, lockDir: lockDirOther });
    expect(await waitForSocket(num, other.child.pid)).toBe(true);

    // A second run sees the socket already exists → socketExistedBefore=true.
    // shouldCleanSocket forbids removal; cleanOwnedSocket with a FOREIGN token
    // (a second run's hypothetical token) must NOT delete the pre-existing socket.
    const existedBefore = displayOccupied(num); // true
    expect(shouldCleanSocket({ socketExistedBefore: existedBefore, xvfbPidAlive: true })).toBe(false);
    // Even with shouldCleanSocket precondition passing, a FOREIGN token fails
    // the lockfile compare → no unlink. Use a random foreign token:
    const foreignTok = '00000000-0000-0000-0000-000000000000';
    expect(
      cleanOwnedSocket({ num, token: foreignTok, socketExistedBefore: false, xvfbPidAlive: true }, { lockDir: lockDirOther })
    ).toBe(false);
    expect(existsSync(socketPath(num))).toBe(true);
  }, 20000);

  it('a run that owns its socket may clean it (compare-and-release); no this-run residue', async () => {
    // Run owns its display: socket absent before, our Xvfb came up.
    const lockDir = mkdtempSync(join(tmpdir(), 'dsh-xvfb-own-'));
    const h = findFreeDisplay({ min: 690, max: 710, lockDir });
    expect(h).not.toBeNull();
    const before = displayOccupied(h!.num); // false
    const a = startXvfb(h!.num);
    started.push({ child: a.child, tmpDir: a.tmpDir, displayNum: h!.num, token: h!.token, lockDir });
    expect(await waitForSocket(h!.num, a.child.pid)).toBe(true);
    // Kill our Xvfb, then compare-and-release cleanup.
    if (a.child.pid) treeKill({ pid: a.child.pid, signal: 'SIGKILL', graceMs: 500 });
    await new Promise((r) => setTimeout(r, 200));
    const xvfbPidAlive = !!(a.child.pid && isPidAliveSync(a.child.pid));
    // cleanOwnedSocket re-verifies ownership (token still ours) → removes socket.
    cleanOwnedSocket({ num: h!.num, token: h!.token, socketExistedBefore: before, xvfbPidAlive }, { lockDir });
    // releaseOwned (compare-and-release) → removes our lock.
    expect(releaseOwned(h!.num, h!.token, { lockDir })).toBe(true);
    // Stale duplicate cleanup with our now-released token is a no-op.
    expect(releaseOwned(h!.num, h!.token, { lockDir })).toBe(false);
    // No Xvfb from this run remains.
    if (a.child.pid) expect(isPidAliveSync(a.child.pid)).toBe(false);
  }, 20000);
});
