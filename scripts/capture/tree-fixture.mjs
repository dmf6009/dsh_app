/**
 * Integration-test fixture for the process-tree kill behaviour (proc-tree.mjs).
 *
 * Spawns a two-level descendant tree that resists SIGTERM so only a SIGKILL
 * escalation can reap it, then idles. Used by tests/launcher-integration.test.ts
 * to prove that runChild's bounded timeout leaves NO orphan processes behind on
 * the timeout path — the review's hard requirement.
 *
 * Tree:
 *   runChild spawns THIS process (child, detached group leader)
 *     └─ this process spawns node again (grandchild)
 *         └─ grandchild spawns node again (great-grandchild)
 * All levels ignore SIGTERM and print their pid so the test can verify each
 * vanished after the tree-kill. Each level writes its pid to a tmp file the
 * test passes via env, so the test can confirm death independently of pgrep.
 *
 * NOT used by the capture gate itself — test-only.
 *
 * Usage: node scripts/capture/tree-fixture.mjs <depth>
 * Env: DSH_FX_PIDS_FILE=<path> — each level appends its pid (newline-sep).
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

// Ignore SIGTERM at every level so a naive kill (signal the leader only, no
// escalation) leaves descendants running — exactly the regression the review
// flagged. The proc-tree module must SIGKILL-escalate to reap these.
process.on('SIGTERM', () => {
  /* ignore — force the escalation path */
});

const depth = parseInt(process.argv[2] ?? '0', 10);
// exit-after-spawn mode: spawn a detached, SIGTERM-ignoring idle grandchild and
// then have THIS process exit immediately. Tests the "normal exit with an
// orphaned descendant" path: runChild must reap the orphan even though the
// direct child already exited cleanly (status 0).
const exitAfterSpawn = process.argv.includes('--exit-after-spawn');
const pidsFile = process.env.DSH_FX_PIDS_FILE;

if (pidsFile) {
  try {
    appendFileSync(pidsFile, `${process.pid}\n`);
  } catch { /* best effort */ }
}

if (depth > 0) {
  // Spawn a grandchild that recurses one level shallower. Detached so it can
  // survive if THIS process dies (simulating the real Electron-worker tree).
  const child = spawn(process.execPath, [process.argv[1] ?? '', String(depth - 1)], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  });
  child.unref();
}

if (exitAfterSpawn) {
  // Give the detached descendant a brief moment to start and record its pid,
  // AND let the orchestrating runChild sweep descendants at least once before
  // we exit, then exit 0 immediately, leaving the descendant orphaned. The
  // orchestrating runChild must still tree-kill it. (Without this pause the
  // child could exit before the grandchild wrote its pid / before the
  // descendant snapshot was taken, making the reaping non-deterministic.)
  setTimeout(() => process.exit(0), 300);
}

// Idle so the timeout path actually fires. Bounded so a buggy test doesn't
// hang forever; the tree-kill is expected to reap this before the timer.
// NOTE: do NOT unref this timer — an unref'd only-timer lets the process exit
// immediately, defeating the "idle until timeout/killed" contract.
const idleMs = 30000;
setTimeout(() => {
  /* exit cleanly if never killed */
  process.exit(0);
}, idleMs);
