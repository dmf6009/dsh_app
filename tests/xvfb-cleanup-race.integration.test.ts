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
import { existsSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
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
  // Clean any leftover test lock FILES / sockets in our display range. The
  // lock is now a single FILE (contents = owner identity); rmSync -f removes
  // it whether it is a file or a stale dir from a prior test.
  for (const n of [770, 771, 772, 773, 774]) {
    try { rmSync(lockPath(n), { force: true }); } catch { /* ignore */ }
    try { unlinkSync(socketPath(n)); } catch { /* ignore */ }
    try { unlinkSync(`/tmp/.X${n}-lock`); } catch { /* ignore */ }
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
  //  1. Seed a dead-owner lock FILE (contents: stale-seed + pid=999999) on
  //     shared /tmp.
  //  2. Start A and B; BOTH pause at their reclaim barrier AFTER reading the
  //     owner and judging 999999 dead, BEFORE unlinking/O_EXCL-recreating.
  //  3. Release A: A unlinks the stale file, O_EXCL-creates + writes owner → A
  //     WINS (A's live pid in the file). A proceeds to boot Xvfb (A "returned
  //     success").
  //  4. NOW release B (after A has installed + returned): B unlinks the stale
  //     file (ENOENT — A did), B's O_EXCL-create FAILS EEXIST (A's live file
  //     present) → acquireStale returns null → claimExplicit returns null → B
  //     exits non-zero. B never touched A's lock.
  // Invariant: AT MOST ONE of {A, B} returned a token (A won, B lost). The
  // O_EXCL recreate is the single linearization point. This test FAILS on
  // c5b27ba (mkdir+write two-step: A mkdir'd empty dir, B rmdir+mkdir'd over
  // it, both wrote owner files) and PASSES here.
  it('two reclaimers both judged dead: A installs+returns success, then B → at most one returns token', async () => {
    const num = 771;
    const lockDir = '/tmp'; // shared production lockDir — real contention
    const barrierA = join(tmpdir(), `dsh-reclaim-A-${num}-${Date.now()}`);
    const barrierB = join(tmpdir(), `dsh-reclaim-B-${num}-${Date.now()}`);
    const cleanupBarrier = join(tmpdir(), `dsh-cleanup-${num}-${Date.now()}`);
    for (const b of [barrierA, barrierB, cleanupBarrier]) {
      try { unlinkSync(b); } catch { /* ignore */ }
    }
    // Seed a STALE lock FILE (dead-owner contents).
    const staleP = lockPath(num, { lockDir });
    try { rmSync(staleP, { force: true }); } catch { /* ignore */ }
    writeFileSync(staleP, 'stale-seed\npid=999999\n');
    // No stale socket — displayOccupied() false so claimExplicit → acquireStale.
    try { unlinkSync(socketPath(num)); } catch { /* ignore */ }
    try { unlinkSync(`/tmp/.X${num}-lock`); } catch { /* ignore */ }

    // Both A and B pause at their OWN reclaim barrier (per-process env) after
    // judging 999999 dead, before unlinking/O_EXCL-recreating.
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

    // Wait for BOTH to be paused at their reclaim barriers (dead judgment done).
    await new Promise((r) => setTimeout(r, 1000));

    // --- Release A FIRST: A unlinks the stale file, O_EXCL-create → WINS. ---
    writeFileSync(barrierA, 'go');
    // Wait for A to win (lock file carries A's token + A's live pid) and boot
    // Xvfb (A "returned success" and proceeded).
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
    // B: unlinks the stale file (ENOENT — A did), O_EXCL-create FAILS EEXIST
    // (A's live file present) → acquireStale returns null → B exits non-zero.
    writeFileSync(barrierB, 'go');
    const bExit = await waitExit(b, 30000);
    expect(bExit).not.toBe(0); // B LOST — claimExplicit returned null
    // A's lock is intact: A's token, A's pid. B did not unlink A's live file.
    const afterB = readOwner(num, { lockDir });
    expect(afterB!.token).toBe(aToken);
    expect(afterB!.pid).toBe(a.pid);
    // A's socket is still up (B did not delete it).
    expect(existsSync(sock)).toBe(true);

    // --- Release A's cleanup barrier so A self-cleans its OWN lock; no leaks. ---
    writeFileSync(cleanupBarrier, 'go');
    const aExit = await waitExit(a, 30000);
    expect(aExit).not.toBeNull();
    expect(existsSync(staleP)).toBe(false); // A released its own lock file
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
    // A is paused in cleanOwnedSocket. A is LIVE and still owns the lock (the
    // lock file carries A's token + A's live pid). B attempts the SAME display:
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

  // ── REVIEW FIX (round 4): fresh-acquire empty-window — owner-less lock not reclaimable
  // The review flagged: acquireDisplay did mkdir then writeFileSync(owner) in
  // two steps; an empty-but-O_EXCL'd lock could be mistaken for reclaimable
  // stale by another caller. The fix: the lock is a single FILE whose contents
  // ARE the owner; publication is O_EXCL create + write via the exclusive fd;
  // an owner-less (empty) file is NOT reclaimable (acquireStale reads null
  // owner → bails). We prove deterministically at the INTEGRATION level by
  // pre-staging an owner-less lock file (an empty file at lockPath, exactly the
  // post-O_EXCL-pre-write state) and launching B against the SAME display: B's
  // claimExplicit → acquireDisplay (EEXIST — the empty file) → acquireStale
  // (reads null owner → owner-less → NOT reclaimable → null) → B exits
  // non-zero. B never unlinked the empty lock. (The owner-write-failure rollback
  // and the empty-window atomicity are additionally proven at the unit level in
  // tests/xvfb-display.test.ts.) This test FAILS on c5b27ba (mkdir+write two-
  // step: an empty lock DIR was reclaimable as stale) and PASSES here.
  it('fresh acquire: an owner-less lock (O_EXCL done, owner write pending) is NOT reclaimed by B', async () => {
    const num = 773;
    try { rmSync(lockPath(num), { recursive: true, force: true }); } catch { /* ignore */ }
    try { unlinkSync(socketPath(num)); } catch { /* ignore */ }
    try { unlinkSync(`/tmp/.X${num}-lock`); } catch { /* ignore */ }

    // Pre-stage an OWNER-LESS lock: an empty file at lockPath, exactly the
    // post-O_EXCL-pre-owner-write state of acquireDisplay. (A real fresh acquire
    // would publish the owner immediately after; this forces the empty window.)
    writeFileSync(lockPath(num), '');

    // B attempts to claim the SAME display. claimExplicit → acquireDisplay
    // (EEXIST — empty file) → acquireStale (reads null owner → owner-less →
    // NOT reclaimable → null). B exits non-zero. B never unlinked the empty lock.
    const b = spawnLauncher({
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '1500',
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
    });
    started.push({ child: b, pid: b.pid });
    drain(b);
    const bExit = await waitExit(b, 20000);
    expect(bExit).not.toBe(0); // B could NOT reclaim the owner-less lock
    // The empty lock file is untouched by B (B's acquireStale refused).
    expect(existsSync(lockPath(num))).toBe(true);
    expect(readOwner(num)).toBeNull(); // still empty (owner-less)
  }, 60000);

  // ── REVIEW FIX (round 4): release leaves no window — a 3rd party's lock is not covered
  // The file-lock model has NO tombstone/restore: release is a single fd-anchored
  // unlink gated on the token read THROUGH the fd. We prove: A releases its lock;
  // a third party C acquires via O_EXCL (a fresh claim); A's LATE/duplicate
  // release (if it somehow runs again) opens C's lock, reads C's token via fd →
  // mismatch → no-op, C's lock survives. No coverage of C's lock.
  it('release leaves no window: a 3rd party C that acquires after A released is not covered by a late release', async () => {
    const num = 774;
    const cleanupBarrier = join(tmpdir(), `dsh-rel-${num}-${Date.now()}`);
    try { unlinkSync(cleanupBarrier); } catch { /* ignore */ }
    try { rmSync(lockPath(num), { recursive: true, force: true }); } catch { /* ignore */ }
    try { unlinkSync(socketPath(num)); } catch { /* ignore */ }
    try { unlinkSync(`/tmp/.X${num}-lock`); } catch { /* ignore */ }

    // A acquires normally, boots Xvfb, times out, pauses at the cleanup barrier.
    const a = spawnLauncher({
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '1200',
      DSH_CLEANUP_BARRIER: cleanupBarrier,
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
    });
    started.push({ child: a, pid: a.pid });
    drain(a);
    // Wait for A to reach the cleanup barrier (Xvfb killed).
    let aReady = false;
    for (let i = 0; i < 120 && !aReady; i += 1) {
      const ownerUp = existsSync(lockPath(num));
      const xvfbAlive = xvfbAliveOn(num);
      if (ownerUp && !xvfbAlive) aReady = true;
      else await new Promise((r) => setTimeout(r, 250));
    }
    expect(aReady).toBe(true);
    // Clean residual Xvfb socket + X lock so C's displayOccupied() is false.
    try { unlinkSync(socketPath(num)); } catch { /* ignore */ }
    try { unlinkSync(`/tmp/.X${num}-lock`); } catch { /* ignore */ }

    // Manually release A's lock (simulating A's releaseOwned completing): unlink
    // the lock file. (A is still paused at the barrier, so it won't re-release.)
    try { unlinkSync(lockPath(num)); } catch { /* ignore */ }

    // C acquires the display via a fresh O_EXCL create.
    const c = spawnLauncher({
      ...process.env,
      DSH_XVFB_DISPLAY: String(num),
      DSH_CAPTURE_TIMEOUT_MS: '30000',
      DISPLAY: '',
      ELECTRON_ENABLE_LOGGING: '0'
    });
    started.push({ child: c, pid: c.pid });
    drain(c);
    const sock = socketPath(num);
    let cWon = false;
    for (let i = 0; i < 80 && !cWon; i += 1) {
      const o = readOwner(num);
      if (o && o.pid === c.pid && existsSync(sock)) cWon = true;
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(cWon).toBe(true); // C legitimately acquired via O_EXCL
    const cOwner = readOwner(num);
    expect(cOwner!.pid).toBe(c.pid);
    const cToken = cOwner!.token;

    // Release A's cleanup barrier: A resumes. A's releaseOwned runs again (it
    // was paused before release; now it runs): opens the lock (C's file), reads
    // C's token via fd → mismatch (A's token ≠ C's) → no-op. C's lock survives.
    writeFileSync(cleanupBarrier, 'go');
    const aExit = await waitExit(a, 30000);
    expect(aExit).not.toBeNull();
    // C's lock survives A's late release.
    expect(readOwner(num)!.token).toBe(cToken);
    expect(readOwner(num)!.pid).toBe(c.pid);
    expect(existsSync(lockPath(num))).toBe(true);
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
