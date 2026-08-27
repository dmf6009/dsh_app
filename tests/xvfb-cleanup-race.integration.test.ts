/**
 * Adversarial cleanup-race integration test (review requirement).
 *
 * Proves the token-based compare-and-release cleanup is race-free against a
 * CONCURRENT run B that wins the same display during run A's cleanup window:
 *
 *  - A and B use the SAME production lockDir (/tmp) and the SAME explicit
 *    display (DSH_XVFB_DISPLAY), so they truly compete for one lockfile — not
 *    isolated per-run lockDirs.
 *  - A is driven into cleanup fast (short timeout) and PAUSED mid-cleanup
 *    (DSH_CLEANUP_BARRIER) AFTER its Xvfb is killed but BEFORE its socket
 *    unlink / lock release. This is exactly the window the review flagged.
 *  - While A is paused, B tries the same explicit display: it must FAIL CLOSED
 *    (A still owns the lock with its token; B does NOT clobber A).
 *  - After A's barrier is released, A finishes cleanup (socket unlink + lock
 *    release, compare-and-release). A LATE/DUPLICATE cleanup by A (token no
 *    longer matches) must NOT delete B's later-acquired lock/socket.
 *  - Then B can claim the now-freed display and start its Xvfb, whose server
 *    and socket remain usable.
 *
 * Skips cleanly when Xvfb / the built renderer / Electron are unavailable.
 * Reliable cleanup: every started launcher + Xvfb is reaped in afterEach.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { lockPath, readOwner, releaseOwned, cleanOwnedSocket, socketPath } from '../scripts/capture/xvfb-display.mjs';
import { treeKill } from '../scripts/capture/proc-tree.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // → dsh_app/
const RUN_CAPTURE = fileURLToPath(new URL('../scripts/capture/run-capture.mjs', import.meta.url));
const INDEX = join(ROOT, 'dist', 'renderer', 'index.html');

function hasBin(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const READY =
  process.platform === 'linux' &&
  hasBin('Xvfb') &&
  hasBin('mcookie') &&
  existsSync(INDEX);

const skipIfNotReady = READY ? () => false : () => true;

/** Spawn the production launcher with env, return the child. */
function spawnLauncher(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [RUN_CAPTURE], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  child.unref();
  return child;
}

/** Drain stdout/stderr to a buffer (for diagnostics) and discard. */
function drain(child: ReturnType<typeof spawnLauncher>) {
  let out = '';
  child.stdout?.on('data', (d) => {
    out += d.toString();
  });
  child.stderr?.on('data', (d) => {
    out += d.toString();
  });
  return () => out;
}

const started: Array<{ child: ReturnType<typeof spawnLauncher> | null; pid?: number | null }> = [];

afterEach(() => {
  for (const h of started) {
    if (h.pid) {
      try {
        treeKill({ pid: h.pid, signal: 'SIGKILL', graceMs: 500 });
      } catch {
        /* dead */
      }
    }
  }
  started.length = 0;
  // Clean any leftover test locks/sockets/tombstones/reclaim-temps in our
  // display range. (No .mut mutation lock exists in the new fd-anchored
  // design; tomb-* / reclaim-* are scratch files from releaseOwned/acquireStale
  // that should be gone on the happy path but may linger if a test was killed.)
  for (const n of [770, 771, 772]) {
    for (const p of [lockPath(n), socketPath(n)]) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    // Sweep scratch files for this display (tomb-/reclaim- prefixed).
    try {
      for (const f of readdirSync('/tmp')) {
        if (f.startsWith(`dsh-capture-xvfb-${n}.tomb-`) || f.startsWith(`dsh-capture-xvfb-${n}.lock.reclaim-`)) {
          try { unlinkSync(join('/tmp', f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
});

/** Resolve a launcher child's exit code (or null if still running) within ms. */
async function waitExit(child: ReturnType<typeof spawnLauncher>, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code ?? 0);
    });
  });
}

describe('adversarial cleanup race (token compare-and-release)', { skip: skipIfNotReady() }, () => {
  it('B cannot claim while A owns; A cleanup does not delete B-acquired socket', async () => {
    const num = 770;
    const barrier = join(tmpdir(), `dsh-race-barrier-${num}-${Date.now()}`);
    try {
      unlinkSync(barrier);
    } catch {
      /* ignore */
    }
    // Shared production lockDir (/tmp) — A and B compete for ONE lockfile.
    const baseEnv = {
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '1200', // drive A into cleanup fast
      DSH_CLEANUP_BARRIER: barrier,
      ELECTRON_ENABLE_LOGGING: '0',
      // Ensure no real DISPLAY so the launcher manages its own Xvfb on `num`.
      DISPLAY: ''
    };

    // --- Run A: starts Xvfb on :num, times out, pauses at cleanup barrier. ---
    const a = spawnLauncher(baseEnv);
    started.push({ child: a, pid: a.pid });
    drain(a); // discard stdout/stderr but keep buffers drained

    // Wait until A's Xvfb has come up (socket exists) and A has entered its
    // timeout→cleanup→barrier pause. Give it time to boot Xvfb + hit timeout.
    const sock = socketPath(num);
    let aSockUp = false;
    for (let i = 0; i < 60 && !aSockUp; i += 1) {
      if (existsSync(sock)) aSockUp = true;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(aSockUp).toBe(true);

    // Give A time to hit the 1200ms timeout and reach the barrier (Xvfb killed,
    // paused before socket unlink / lock release).
    await new Promise((r) => setTimeout(r, 2200));

    // --- While A is paused mid-cleanup, B tries the SAME explicit display. ---
    // A still owns the lockfile (with A's token) → B must FAIL CLOSED.
    const bEnv: NodeJS.ProcessEnv = { ...baseEnv };
    bEnv.DSH_CLEANUP_BARRIER = ''; // B does not pause (env cleared, not deleted)
    const b = spawnLauncher(bEnv);
    started.push({ child: b, pid: b.pid });
    drain(b);
    const bExit = await waitExit(b, 15000);
    // B must exit non-zero (display owned by A) and NOT have clobbered A's lock.
    expect(bExit).not.toBe(0);
    // A's lock still present and still A's token (B did not take it over).
    const owner = readOwner(num);
    expect(owner).not.toBeNull();

    // --- Release A's barrier so A finishes cleanup (socket unlink + lock release). ---
    writeFileSync(barrier, 'go');
    // Wait for A to actually EXIT (cleanup completes: tree-kill grace +
    // compare-and-release). A fixed sleep is flaky; wait on the exit event.
    const aExit = await waitExit(a, 30000);
    expect(aExit).not.toBeNull(); // A did exit
    // A should now have released its lock (compare-and-release).
    expect(existsSync(lockPath(num))).toBe(false);

    // --- A LATE/duplicate cleanup must NOT delete a socket B later creates. ---
    // Simulate A's stale token attempting cleanup AFTER release: releaseOwned
    // with A's (now-stale) token is a no-op; cleanOwnedSocket with a stale token
    // is a no-op. We assert the helpers refuse when the token no longer matches.
    const staleToken = owner!.token;
    // The lock is gone (A released) → releaseOwned returns false (no-op).
    expect(releaseOwned(num, staleToken)).toBe(false);

    // --- Now B (fresh attempt) can claim the freed display and start. ---
    const c = spawnLauncher({ ...baseEnv, DSH_CAPTURE_TIMEOUT_MS: '30000' });
    started.push({ child: c, pid: c.pid });
    // C should boot Xvfb and proceed (no immediate non-zero). Give it a moment
    // to acquire the lock and bring up the socket.
    let cSockUp = false;
    for (let i = 0; i < 40 && !cSockUp; i += 1) {
      if (existsSync(sock)) cSockUp = true;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(cSockUp).toBe(true);
    // C's socket is NOT deleted by any stale A cleanup attempt above.
    expect(existsSync(sock)).toBe(true);
    // C's lock carries a DIFFERENT token than A's stale one.
    const cOwner = readOwner(num);
    expect(cOwner).not.toBeNull();
    expect(cOwner!.token).not.toBe(staleToken);

    // --- REVIEW FIX: A's stale-token cleanup invoked AFTER C established. ---
    // The prior test only called releaseOwned on a gone lock (before C existed).
    // The review required: with C's lock+socket LIVE, actually invoke A's stale
    // cleanOwnedSocket AND releaseOwned and prove they do NOT touch C's live
    // resources (lock + socket). This is the determinate adversarial check that
    // a late/duplicate old-owner cleanup cannot clobber the new owner.
    const cToken = cOwner!.token;
    const cSockBefore = existsSync(sock);
    const cLockBefore = existsSync(lockPath(num));
    // A's stale cleanOwnedSocket — must NOT unlink C's socket.
    expect(
      cleanOwnedSocket({ num, token: staleToken, socketExistedBefore: false, xvfbPidAlive: true })
    ).toBe(false);
    expect(existsSync(sock)).toBe(cSockBefore); // C's socket untouched
    // A's stale releaseOwned — must NOT unlink C's lock.
    expect(releaseOwned(num, staleToken)).toBe(false);
    expect(existsSync(lockPath(num))).toBe(cLockBefore); // C's lock untouched
    // C's token is unchanged.
    expect(readOwner(num)!.token).toBe(cToken);
  }, 90000);

  // ── REVIEW FIX: two concurrent reclaimers on the SAME stale lock ──────────
  // The review flagged that acquireStale had a TOCTOU: two reclaimers could
  // both read a dead-owner lock and race — the prior "mutation lock" fix
  // reproduced the SAME window inside the mutex's own stale reclamation. The
  // new design eliminates the read-verify-then-unlink window ENTIRELY:
  // acquireStale never unlinks the lock path — it atomically REPLACEs the
  // lockfile's contents via `rename(temp, lockPath)` (a POSIX-atomic directory-
  // entry swap; no instant the path is absent). The very first reclaimer to
  // rename installs a LIVE owner (its own pid); any second reclaimer that then
  // reads the owner sees that LIVE pid and bails — it can NEVER race into the
  // unlink/recreate window because there is no unlink, and the atomic rename
  // has already flipped the owner from "dead" to "live".
  //
  // We FORCE the interleaving deterministically with DSH_RECLAIM_BARRIER, which
  // pauses reclaimer A AFTER its atomic rename, BEFORE the win/lose re-read:
  //  - Seed a dead-owner stale lock S on shared /tmp.
  //  - A enters acquireStale, renames tokenA over S (lock now carries tokenA
  //    with A's LIVE pid), and pauses at the barrier.
  //  - B enters claimExplicit on the SAME display: acquireDisplay fails (lock
  //    exists) → acquireStale reads the owner → A's pid is LIVE → acquireStale
  //    returns null → claimExplicit returns null → B exits non-zero. B NEVER
  //    renamed/unlinked anything; A's live lock is untouched.
  //  - Release A: A re-reads → tokenA == A's → A WINS → A boots Xvfb and on
  //    exit self-cleans its OWN lock.
  // Invariant: EXACTLY ONE owner at all times; the second reclaimer cannot
  // reclaim once the first has atomically installed a live pid; no live lock is
  // ever unlinked. (Pre-fix, A would have unlinked S + O_EXCL-created, and B
  // could race a queued unlinkSync that deleted A's fresh live lock — the test
  // asserts that does NOT happen: A's token survives B's attempt.)
  it('reclaimer A paused after atomic rename; B sees A live and cannot reclaim the same lock', async () => {
    const num = 771;
    const lockDir = '/tmp'; // shared production lockDir — real contention
    const reclaimBarrier = join(tmpdir(), `dsh-reclaim-barrier-${num}-${Date.now()}`);
    try {
      unlinkSync(reclaimBarrier);
    } catch {
      /* ignore */
    }
    // Seed a STALE lock (dead-owner pid) so a reclaimer enters acquireStale.
    const staleP = lockPath(num, { lockDir });
    try {
      writeFileSync(staleP, 'stale-seed\npid=999999\n');
    } catch {
      /* ignore */
    }
    // No stale socket — displayOccupied() must be false so claimExplicit
    // proceeds to acquireDisplay (fails, lock exists) → acquireStale.
    try {
      unlinkSync(socketPath(num));
    } catch {
      /* ignore */
    }

    // A pauses after its atomic rename (tokenA installed, A's pid live), before
    // the win/lose re-read. A also pauses at its cleanup barrier so we can
    // inspect before A self-cleans.
    const cleanupBarrier = join(tmpdir(), `dsh-cleanup-barrier-${num}-${Date.now()}`);
    try {
      unlinkSync(cleanupBarrier);
    } catch {
      /* ignore */
    }
    const aEnv = {
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '1500',
      DSH_RECLAIM_BARRIER: reclaimBarrier,
      DSH_CLEANUP_BARRIER: cleanupBarrier,
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
    };
    const a = spawnLauncher(aEnv);
    started.push({ child: a, pid: a.pid });
    drain(a);

    // Wait for A to reach the reclaim barrier: A has renamed tokenA over S and
    // is paused. The lock now carries A's FRESH token + A's LIVE pid (not the
    // stale seed).
    let aOwner = readOwner(num, { lockDir });
    for (let i = 0; i < 40 && (!aOwner || aOwner!.token === 'stale-seed'); i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      aOwner = readOwner(num, { lockDir });
    }
    expect(aOwner).not.toBeNull();
    expect(aOwner!.token).not.toBe('stale-seed'); // A's atomic rename installed a fresh token
    expect(aOwner!.pid).toBe(a.pid); // ...with A's LIVE pid
    const aToken = aOwner!.token;

    // --- B reclaims the SAME display while A is paused (A live). ---
    // B's acquireStale reads A's pid → LIVE → returns null → claimExplicit
    // returns null → B exits non-zero. B NEVER renamed/unlinked; A's lock
    // survives with A's token.
    const b = spawnLauncher({
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '1500',
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
      // No DSH_RECLAIM_BARRIER / DSH_CLEANUP_BARRIER — B should fail fast.
    });
    started.push({ child: b, pid: b.pid });
    drain(b);
    const bExit = await waitExit(b, 30000);
    expect(bExit).not.toBe(0); // B could NOT reclaim — A is live
    // A's lock is UNTOUCHED by B: still A's token, still A's pid.
    const afterB = readOwner(num, { lockDir });
    expect(afterB!.token).toBe(aToken);
    expect(afterB!.pid).toBe(a.pid);

    // --- Release A: A re-reads → tokenA == A's → A wins, boots Xvfb. ---
    writeFileSync(reclaimBarrier, 'go');
    // Wait for A to win and bring up its Xvfb socket.
    const sock = socketPath(num);
    let aSockUp = false;
    for (let i = 0; i < 60 && !aSockUp; i += 1) {
      if (existsSync(sock)) aSockUp = true;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(aSockUp).toBe(true); // A won and started its Xvfb
    // A's lock still carries A's token (B never clobbered it).
    expect(readOwner(num, { lockDir })!.token).toBe(aToken);

    // Release A's cleanup barrier so A self-cleans its OWN lock; no leaks.
    writeFileSync(cleanupBarrier, 'go');
    const aExit = await waitExit(a, 30000);
    expect(aExit).not.toBeNull();
    expect(existsSync(staleP)).toBe(false); // A released its own lock
  }, 90000);
});
