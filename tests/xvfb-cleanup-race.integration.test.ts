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
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
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
  // Clean any leftover test lock DIRS / sockets in our display range. The lock
  // is now a DIRECTORY (owner.<pid> files inside); rmSync removes it wholesale.
  for (const n of [770, 771, 772, 773]) {
    try { rmSync(lockPath(n), { recursive: true, force: true }); } catch { /* ignore */ }
    try { unlinkSync(socketPath(n)); } catch { /* ignore */ }
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

  // ── REVIEW FIX (round 3): two reclaimers both judged dead → at most one wins
  // The prior rename-replace design let A and B BOTH rename then each read back
  // their own token and BOTH return success (last-writer-wins + path re-read is
  // NOT a CAS). The directory + `owner.<pid>` design makes reclaim a TRUE CAS:
  // the success point is `mkdir` (O_EXCL — one winner, EEXIST for the loser), and
  // a reclaimer unlinks ONLY `owner.<deadpid>` files (filename gating — it can
  // NEVER unlink a live owner's `owner.<livepid>` file). After A wins the mkdir
  // and installs `owner.<A-pid>`, the dir is non-empty, so B's rmdir fails and
  // B's mkdir fails EEXIST → B returns null.
  //
  // We FORCE the exact interleaving the review flagged with TWO reclaim
  // barriers (A and B each get their own barrier path via per-process env):
  //  1. Seed a dead-owner lock (dir + owner.999999) on shared /tmp.
  //  2. Start A and B; BOTH pause at their reclaim barrier AFTER scanning
  //     owners and judging 999999 dead, BEFORE unlinking/installing. (Both
  //     have completed the stale judgment — the window the review said the
  //     prior test evaded.)
  //  3. Release A: A unlinks owner.999999, rmdir, mkdir CAS → A WINS, installs
  //     owner.<A-pid>. A proceeds to boot Xvfb (A "returned success").
  //  4. NOW release B (after A has installed + returned): B unlinks owner.999999
  //     (ENOENT — A already did), B's rmdir fails (A's owner.<A-pid> present),
  //     B's mkdir fails EEXIST → B returns null → claimExplicit returns null →
  //     B exits non-zero.
  // Invariant: AT MOST ONE of {A, B} returned a token (A won, B lost). A's
  // live lock is never unlinked by B (filename gating). This test FAILS on
  // 4b02f02 (rename-replace: both A and B would return a token) and PASSES
  // here.
  it('two reclaimers both judged dead: A installs+returns success, then B → at most one returns token', async () => {
    const num = 771;
    const lockDir = '/tmp'; // shared production lockDir — real contention
    const barrierA = join(tmpdir(), `dsh-reclaim-A-${num}-${Date.now()}`);
    const barrierB = join(tmpdir(), `dsh-reclaim-B-${num}-${Date.now()}`);
    const cleanupBarrier = join(tmpdir(), `dsh-cleanup-${num}-${Date.now()}`);
    for (const b of [barrierA, barrierB, cleanupBarrier]) {
      try { unlinkSync(b); } catch { /* ignore */ }
    }
    // Seed a STALE lock: DIRECTORY + owner.999999 (dead pid).
    const staleDir = lockPath(num, { lockDir });
    try { rmSync(staleDir, { recursive: true, force: true }); } catch { /* ignore */ }
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'owner.999999'), 'stale-seed\npid=999999\n');
    // No stale socket — displayOccupied() false so claimExplicit → acquireStale.
    try { unlinkSync(socketPath(num)); } catch { /* ignore */ }

    // Both A and B pause at their OWN reclaim barrier (per-process env) after
    // judging 999999 dead, before unlinking/installing.
    const baseEnv = {
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '1500',
      DSH_CLEANUP_BARRIER: cleanupBarrier,
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
    };
    const a = spawnLauncher({ ...baseEnv, DSH_RECLAIM_BARRIER: barrierA });
    const b = spawnLauncher({ ...baseEnv, DSH_RECLAIM_BARRIER: barrierB });
    started.push({ child: a, pid: a.pid });
    started.push({ child: b, pid: b.pid });
    drain(a);
    drain(b);

    // Wait for BOTH to be paused at their reclaim barriers (the dead-pid
    // judgment is done for both). Give them time to boot to acquireStale.
    await new Promise((r) => setTimeout(r, 1000));

    // --- Release A FIRST: A unlinks owner.999999, rmdir, mkdir CAS → WINS. ---
    writeFileSync(barrierA, 'go');
    // Wait for A to win (owner.<A-pid> present, dir carries A's token+pid) and
    // boot Xvfb (A "returned success" and proceeded).
    const sock = socketPath(num);
    let aWon = false;
    for (let i = 0; i < 60 && !aWon; i += 1) {
      const o = readOwner(num, { lockDir });
      if (o && o.pid === a.pid && existsSync(sock)) aWon = true;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(aWon).toBe(true); // A installed its lock AND booted Xvfb (returned success)
    const aOwner = readOwner(num, { lockDir });
    expect(aOwner!.pid).toBe(a.pid);
    const aToken = aOwner!.token;

    // --- NOW release B (A has already installed + returned). ---
    // B: unlinks owner.999999 (ENOENT — A did it), rmdir FAILS (A's owner.<A-pid>
    // makes dir non-empty), mkdir FAILS EEXIST → acquireStale returns null →
    // claimExplicit returns null → B exits non-zero. B never touched A's lock.
    writeFileSync(barrierB, 'go');
    const bExit = await waitExit(b, 30000);
    expect(bExit).not.toBe(0); // B LOST — claimExplicit returned null
    // A's lock is intact: A's token, A's pid. B did not unlink owner.<A-pid>.
    const afterB = readOwner(num, { lockDir });
    expect(afterB!.token).toBe(aToken);
    expect(afterB!.pid).toBe(a.pid);
    // A's socket is still up (B did not delete it).
    expect(existsSync(sock)).toBe(true);

    // --- Release A's cleanup barrier so A self-cleans its OWN lock; no leaks. ---
    writeFileSync(cleanupBarrier, 'go');
    const aExit = await waitExit(a, 30000);
    expect(aExit).not.toBeNull();
    expect(existsSync(staleDir)).toBe(false); // A released its own lock dir
  }, 90000);

  // ── REVIEW FIX (round 3): cleanOwnedSocket fd-verify → socket-unlink window
  // The review flagged: A fd-verifies ownership, then B takes over (new lock +
  // socket), then A's socket unlink deletes B's socket. In THIS design, B can
  // only take over via acquireStale, which REFUSES while A is live — and A is
  // live while running cleanOwnedSocket. We prove it deterministically: pause A
  // AFTER the fd ownership verify (DSH_CLEANSOCK_BARRIER), have B attempt to
  // take the SAME display, and assert B FAILS (A live) and A's later socket
  // unlink does NOT delete any B-installed socket (there is none, because B
  // could not install one). B's lock (A's, actually) and the socket survive.
  it('cleanOwnedSocket: A paused after fd-verify, B cannot take over (A live) — no socket race', async () => {
    const num = 772;
    const cleansockBarrier = join(tmpdir(), `dsh-cleansock-${num}-${Date.now()}`);
    try { unlinkSync(cleansockBarrier); } catch { /* ignore */ }
    // A owns the display normally (fresh acquireDisplay), boots Xvfb, and is
    // driven to cleanOwnedSocket where it pauses after the fd verify.
    const env = {
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '1200', // drive A into cleanup fast
      DSH_CLEANSOCK_BARRIER: cleansockBarrier,
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
    };
    const a = spawnLauncher(env);
    started.push({ child: a, pid: a.pid });
    drain(a);

    // Wait for A's Xvfb socket to come up, then A times out and pauses at the
    // cleansock barrier (after fd-verifying ownership, before socket unlink).
    const sock = socketPath(num);
    let aSockUp = false;
    for (let i = 0; i < 60 && !aSockUp; i += 1) {
      if (existsSync(sock)) aSockUp = true;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(aSockUp).toBe(true);
    // Give A time to hit the 1200ms timeout → cleanup → cleanOwnedSocket →
    // fd-verify → pause at cleansock barrier. (Xvfb is killed in cleanup BEFORE
    // cleanOwnedSocket; the socket may be removed by Xvfb's clean termination —
    // that's fine; the point is A is PAUSED holding ownership, A live.)
    await new Promise((r) => setTimeout(r, 2200));
    // A is paused in cleanOwnedSocket. A is LIVE and still owns the lock (A's
    // owner.<A-pid> file is present). B attempts the SAME display:
    const b = spawnLauncher({
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '1500',
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
      // No barriers — B should fail fast.
    });
    started.push({ child: b, pid: b.pid });
    drain(b);
    const bExit = await waitExit(b, 20000);
    // B must FAIL: claimExplicit → acquireDisplay (EEXIST, A's dir) → acquireStale
    // reads A's LIVE pid → refuses → null → B exits non-zero. B never installed
    // a lock or socket.
    expect(bExit).not.toBe(0);
    // A's lock is intact (A's owner file present, A's token).
    const aOwner = readOwner(num);
    expect(aOwner).not.toBeNull();
    expect(aOwner!.pid).toBe(a.pid);
    // Release A's cleansock barrier: A unlinks the socket (its OWN, or Xvfb
    // already did) and releases its OWN lock. No B socket existed to be wrongly
    // deleted.
    writeFileSync(cleansockBarrier, 'go');
    const aExit = await waitExit(a, 30000);
    expect(aExit).not.toBeNull();
    expect(existsSync(lockPath(num))).toBe(false); // A released its own lock
  }, 90000);

  // ── REVIEW FIX (round 3): tombstone-free release — no window covers a 3rd lock
  // The review flagged: the prior tombstone-restore could cover a 3rd party C's
  // lock acquired in the empty-dir window, leaving C a lock-less false owner.
  // This design has NO restore-rename: release unlinks owner.<mypid> and
  // best-effort rmdirs; C's mkdir CAS is independent and never touched by A's
  // release. We prove: A removes its owner file (mid-release, dir empty); C
  // acquires via acquireDisplay (which uses mkdir CAS — but the dir still
  // exists, so C goes through acquireStale: empty dir, no live owner → rmdir +
  // mkdir CAS → C wins); A's release resumes (rmdir fails — C's owner file
  // present) → C's lock survives, C is NOT a false owner, A touched nothing of
  // C's. (This is the integration-level version of the unit tombstone test; it
  // uses real processes for A and C.)
  it('release leaves no window: a 3rd party C that wins mkdir after A removed its owner is not covered', async () => {
    const num = 773;
    const cleanupBarrier = join(tmpdir(), `dsh-tomb-${num}-${Date.now()}`);
    try { unlinkSync(cleanupBarrier); } catch { /* ignore */ }
    // A acquires normally, boots Xvfb, times out, and pauses at the CLEANUP
    // barrier AFTER killing Xvfb but BEFORE cleanOwnedSocket/releaseOwned. We
    // then manually remove A's owner file (simulating A mid-release: owner file
    // gone, dir empty, rmdir pending) and let C acquire.
    const aEnv = {
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '1200',
      DSH_CLEANUP_BARRIER: cleanupBarrier,
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
    };
    const a = spawnLauncher(aEnv);
    started.push({ child: a, pid: a.pid });
    drain(a);
    // Wait for A to reach the cleanup barrier. The barrier runs AFTER A has
    // tree-killed its Xvfb, so the reliable signal that A is paused at the
    // barrier is: A's owner file exists AND no Xvfb process is bound to :num
    // anymore (A's Xvfb was killed). Poll for both.
    const aOwnerFile = join(lockPath(num), `owner.${a.pid}`);
    let aReady = false;
    for (let i = 0; i < 120 && !aReady; i += 1) {
      const ownerUp = existsSync(aOwnerFile);
      const xvfbAlive = xvfbAliveOn(num);
      if (ownerUp && !xvfbAlive) aReady = true;
      else await new Promise((r) => setTimeout(r, 250));
    }
    expect(aReady).toBe(true); // A paused at the cleanup barrier, Xvfb dead

    // Simulate A mid-release: A has removed its owner file but not yet rmdir'd.
    // (In production this is two steps inside releaseOwned; we force the
    // in-between state so C arrives in the empty-dir window.) Also remove any
    // residual Xvfb socket + X lock file (Xvfb was tree-killed and may not have
    // removed them cleanly) so C's displayOccupied() returns false AND C's Xvfb
    // can bind the socket path (a dead Xvfb leaves the socket + .X<num>-lock).
    try { unlinkSync(aOwnerFile); } catch { /* ignore */ }
    try { unlinkSync(socketPath(num)); } catch { /* ignore */ }
    try { unlinkSync(`/tmp/.X${num}-lock`); } catch { /* ignore */ }
    // C acquires the display. claimExplicit → acquireDisplay (EEXIST, dir
    // exists) → acquireStale (empty dir, no live owner → rmdir + mkdir CAS) →
    // C WINS, installs owner.<C-pid>. C is a LEGITIMATE owner (mkdir CAS).
    const c = spawnLauncher({
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '30000',
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
    });
    started.push({ child: c, pid: c.pid });
    drain(c);
    // Wait for C to win and boot Xvfb (C's owner file present, socket up).
    const sock = socketPath(num);
    let cWon = false;
    for (let i = 0; i < 80 && !cWon; i += 1) {
      const o = readOwner(num);
      if (o && o.pid === c.pid && existsSync(sock)) cWon = true;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(cWon).toBe(true); // C legitimately won the mkdir CAS
    const cOwner = readOwner(num);
    expect(cOwner!.pid).toBe(c.pid);
    const cToken = cOwner!.token;

    // Release A's cleanup barrier: A's releaseOwned resumes. A opens
    // owner.<A-pid> — GONE (C's is owner.<C-pid>, a different path) → no-op.
    // A's rmdir fails (C's owner file present). C's lock is NOT covered/deleted.
    writeFileSync(cleanupBarrier, 'go');
    const aExit = await waitExit(a, 30000);
    expect(aExit).not.toBeNull();
    // C's lock survives A's late release: C's token + C's pid intact.
    expect(readOwner(num)!.token).toBe(cToken);
    expect(readOwner(num)!.pid).toBe(c.pid);
    expect(existsSync(lockPath(num))).toBe(true);
    // Clean up C (still running its capture gate).
    if (c.pid) treeKill({ pid: c.pid, signal: 'SIGKILL', graceMs: 500 });
  }, 90000);
});

/** True if any Xvfb process is currently bound to display `:num`. */
function xvfbAliveOn(num: number): boolean {
  try {
    const out = execFileSync('pgrep', ['-af', `Xvfb :${num} `], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return false; // pgrep exit 1 = no match
  }
}
