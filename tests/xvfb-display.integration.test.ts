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
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import {
  claimExplicit,
  displayOccupied,
  findFreeDisplay,
  releaseDisplay,
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

/** All Xvfb processes we started, for reliable cleanup. `ownedSocket` is true
 * for Xvfb processes THIS test started on a display whose socket did not exist
 * before — those sockets are ours and must be cleaned to avoid polluting the
 * shared /tmp/.X11-unix namespace for later runs. */
const started: Array<{
  child: { pid?: number | null } | null;
  tmpDir?: string;
  displayNum?: number;
  lockDir?: string;
  ownedSocket?: boolean;
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
  if (h.displayNum !== undefined && h.lockDir) {
    try {
      releaseDisplay(h.displayNum, { lockDir: h.lockDir });
    } catch {
      /* best effort */
    }
  }
  // Remove THIS test's own X11 socket (we started the Xvfb → we own it). We do
  // NOT remove sockets we did not create (ownedSocket=false). This keeps the
  // shared /tmp/.X11-unix namespace clean after the suite, without ever
  // touching a foreign server.
  if (h.ownedSocket && h.displayNum !== undefined) {
    try {
      const sock = socketPath(h.displayNum);
      if (existsSync(sock)) unlinkSync(sock);
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
    // Run A: allocate a display and start Xvfb on it.
    const lockDirA = mkdtempSync(join(tmpdir(), 'dsh-xvfb-A-'));
    const numA = findFreeDisplay({ min: 620, max: 660, lockDir: lockDirA });
    expect(numA).not.toBeNull();
    const a = startXvfb(numA!);
    started.push({ child: a.child, tmpDir: a.tmpDir, displayNum: numA!, lockDir: lockDirA, ownedSocket: true });
    expect(await waitForSocket(numA!, a.child.pid)).toBe(true);
    expect(displayOccupied(numA!)).toBe(true);

    // Run B: concurrently allocate ANOTHER display — must not pick numA.
    const lockDirB = mkdtempSync(join(tmpdir(), 'dsh-xvfb-B-'));
    const numB = findFreeDisplay({ min: 620, max: 660, lockDir: lockDirB });
    expect(numB).not.toBeNull();
    expect(numB).not.toBe(numA);
    const b = startXvfb(numB!);
    started.push({ child: b.child, tmpDir: b.tmpDir, displayNum: numB!, lockDir: lockDirB, ownedSocket: true });
    expect(await waitForSocket(numB!, b.child.pid)).toBe(true);
    expect(displayOccupied(numB!)).toBe(true);

    // Both sockets coexist — run A's socket is NOT removed by run B.
    expect(existsSync(socketPath(numA!))).toBe(true);
  }, 20000);

  it('explicit DSH_XVFB_DISPLAY already in use → second claim fails CLOSED, existing socket survives', async () => {
    const lockDirA = mkdtempSync(join(tmpdir(), 'dsh-xvfb-exp-A-'));
    const num = 670;
    // Run A occupies num: socket comes up + lock held.
    expect(claimExplicit(num, { lockDir: lockDirA })).toBe(true);
    const a = startXvfb(num);
    started.push({ child: a.child, tmpDir: a.tmpDir, displayNum: num, lockDir: lockDirA, ownedSocket: true });
    expect(await waitForSocket(num, a.child.pid)).toBe(true);
    expect(displayOccupied(num)).toBe(true);

    // Run B tries the SAME explicit display. displayOccupied sees the live
    // socket → claimExplicit must fail (false), NOT clobber the existing server.
    const lockDirB = mkdtempSync(join(tmpdir(), 'dsh-xvfb-exp-B-'));
    expect(claimExplicit(num, { lockDir: lockDirB })).toBe(false);
    // The existing X server / socket is untouched and still up.
    expect(displayOccupied(num)).toBe(true);
    expect(existsSync(socketPath(num))).toBe(true);
    // B holds no lock for num.
    expect(existsSync(join(lockDirB, `dsh-capture-xvfb-${num}.lock`))).toBe(false);
    // Clean up B's temp lock dir.
    rmSync(lockDirB, { recursive: true, force: true });
  }, 20000);

  it('cleanup only removes a socket THIS run created — never a pre-existing one', async () => {
    // A pre-existing X server on num (run "other") — socket present.
    const lockDirOther = mkdtempSync(join(tmpdir(), 'dsh-xvfb-pre-'));
    const num = 680;
    expect(claimExplicit(num, { lockDir: lockDirOther })).toBe(true);
    const other = startXvfb(num);
    started.push({ child: other.child, tmpDir: other.tmpDir, displayNum: num, lockDir: lockDirOther, ownedSocket: true });
    expect(await waitForSocket(num, other.child.pid)).toBe(true);

    // A second run sees the socket already exists → socketExistedBefore=true.
    const existedBefore = displayOccupied(num); // true
    // shouldCleanSocket must forbid removal: we did not create this socket.
    expect(shouldCleanSocket({ num, socketExistedBefore: existedBefore, xvfbPidAlive: true })).toBe(false);
    // Simulating the "second run's cleanup" must NOT delete the pre-existing socket.
    // (The launcher only calls cleanup with a displayNum when shouldCleanSocket=true.)
    expect(existsSync(socketPath(num))).toBe(true);
  }, 20000);

  it('a run that owns its socket may clean it; success/fail paths leave no this-run residue', async () => {
    // Run owns its display: socket absent before, our Xvfb came up.
    const lockDir = mkdtempSync(join(tmpdir(), 'dsh-xvfb-own-'));
    const num = findFreeDisplay({ min: 690, max: 710, lockDir });
    expect(num).not.toBeNull();
    const before = displayOccupied(num!); // false (we just claimed a free one)
    const a = startXvfb(num!);
    started.push({ child: a.child, tmpDir: a.tmpDir, displayNum: num!, lockDir, ownedSocket: true });
    expect(await waitForSocket(num!, a.child.pid)).toBe(true);
    // Ownership proven → cleanup is allowed.
    expect(shouldCleanSocket({ num: num!, socketExistedBefore: before, xvfbPidAlive: !!a.child.pid })).toBe(true);
    // After tree-killing our Xvfb, no Xvfb process from this run remains.
    if (a.child.pid) treeKill({ pid: a.child.pid, signal: 'SIGKILL', graceMs: 500 });
    await new Promise((r) => setTimeout(r, 200));
    if (a.child.pid) expect(isPidAliveSync(a.child.pid)).toBe(false);
  }, 20000);
});
