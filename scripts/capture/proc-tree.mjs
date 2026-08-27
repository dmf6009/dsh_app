/**
 * Cross-platform process-tree control for the capture gate.
 *
 * The prior launcher used `spawnSync('xvfb-run', ...)` with a `timeout` /
 * `killSignal`. That cannot guarantee "no orphaned processes", which the review
 * requires: Node's `spawnSync` only signals and reaps the DIRECT child — for
 * the Xvfb path the direct child is the `xvfb-run` shell, while Electron and
 * the Xvfb server are descendants. The `xvfb-run` script only traps `EXIT`
 * (not `SIGTERM`), so a timeout signal can kill the wrapper while leaving the
 * Electron tree running. This module owns process-tree termination directly.
 *
 * Strategy:
 *  - spawn children with `detached: true` so each becomes its own process-group
 *    leader (POSIX). The whole tree (leader + descendants) is then reachable
 *    via the negative group id `kill(-pgid, sig)`.
 *  - `treeKill(pid, sig)` signals the group on POSIX and `taskkill /T` on
 *    Windows, escalating SIGTERM → SIGKILL with a bounded grace window.
 *  - `runChild` spawns a detached child, applies a bounded timeout, and on
 *    timeout/error/exit runs `treeKill` so descendants are reaped — returning a
 *    result with a real `timedOut` flag (true when the wall-clock deadline
 *    fired) and the spawn error code (ETIMEDOUT shape preserved).
 *
 * Pure helpers (`isTimeoutError`, `exitCodeFor`) are unit-tested without
 * spawning; `runChild`/`treeKill` are exercised by an integration test that
 * starts a real descendant-producing fixture and asserts no orphans remain.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

/** True for a spawnSync/spawn result shape that indicates a timeout. Node sets
 * `error.code === 'ETIMEDOUT'` (spawnSync) — the `timedOut` boolean the prior
 * code read does NOT exist on spawnSync results. For `runChild` we set our own
 * `timedOut` flag when our wall-clock deadline fires. Both count. */
export function isTimeoutError(result) {
  if (result && result.timedOut === true) return true;
  const code = result && result.error ? result.error.code : null;
  return code === 'ETIMEDOUT';
}

/** Map a runChild/spawnSync result to a fail-closed exit code. Timeout, error,
 * signal, or missing status ⇒ 1 (never 0 when the gate did not run cleanly). */
export function exitCodeFor(result) {
  if (isTimeoutError(result)) return 1;
  if (result && result.error) return 1;
  if (result && result.signal) return 1;
  if (!result || typeof result.status !== 'number') return 1;
  return result.status;
}

/**
 * Enumerate ALL descendants of `pid` (recursively: children, grandchildren, …).
 *
 * Why this exists: the prior tree-kill only signalled the child's PROCESS
 * GROUP (negative pid). But a grandchild spawned with `detached: true` becomes
 * the leader of its OWN process group, so signalling the child's group does
 * NOT reach it — exactly the "orphaned Electron/Xvfb descendants" gap the
 * review flagged. To reach every descendant regardless of process-group
 * boundaries, we walk the live process tree explicitly.
 *
 * POSIX (Linux): read `/proc/<pid>/task/<pid>/children` per pid (space-sep pids)
 * and recurse. This is per-process, not per-group, so detached descendants are
 * found. Falls back to `pgrep -P <pid>` if /proc is unavailable.
 * Windows: not used (Windows tree-kill uses `taskkill /T`).
 *
 * Returns a flat array of descendant pids (EXCLUDING the root). Best-effort:
 * swallows errors (dead pid, missing /proc) and returns whatever it found.
 */
export function descendantsOf(pid, opts = {}) {
  if (!pid || pid <= 0) return [];
  if (process.platform === 'win32') return []; // Windows uses taskkill /T
  const seen = new Set();
  const out = [];
  const stack = [pid];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const kids = readChildrenSync(cur, opts);
    for (const k of kids) {
      out.push(k);
      stack.push(k);
    }
  }
  return out;
}

/** Read the direct children pids of `pid`. POSIX /proc-first, pgrep fallback. */
function readChildrenSync(pid, opts = {}) {
  if (typeof opts.readChildren === 'function') {
    try { return opts.readChildren(pid); } catch { return []; }
  }
  // Linux /proc/<pid>/task/<pid>/children is a space-separated list of pids.
  if (process.platform !== 'win32') {
    try {
      const txt = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
      return txt
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch { /* /proc unavailable or pid gone */ }
  }
  // Fallback: pgrep -P <pid> (lists direct children).
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out
      .split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Kill an entire process tree rooted at `pid`. Reaches descendants EXPLICITLY
 * (via descendantsOf) so a `detached: true` grandchild that leads its own
 * process group is not orphaned — the process-group-only approach the review
 * flagged cannot reach such grandchildren. Also signals the process group as a
 * belt-and-suspenders. Windows uses `taskkill /PID <pid> /T`.
 *
 * `extraPids` are killed directly in addition to the enumerated tree — used by
 * runChild to reap descendants that were discovered while the child was alive
 * but get re-parented to init (so /proc/<dead-pid>/children can no longer find
 * them) once the direct child exits on the NORMAL path.
 *
 * Escalates: SIGTERM first (children first, root last), wait up to `graceMs`,
 * then SIGKILL for any survivor. Never throws — best-effort reaping, safe on
 * already-dead pids.
 * @param {{ pid: number|null, signal?: string, graceMs?: number, extraPids?: number[], killTreeSync?: (pid:number, sig:string)=>void, descendants?: (pid:number)=>number[], killPid?: (pid:number, sig:string)=>void }} opts
 */
export function treeKill({ pid, signal = 'SIGTERM', graceMs = 1500, extraPids = [], killTreeSync, descendants, killPid }) {
  if (!pid || pid <= 0) return;
  const k = killPid || ((p, s) => {
    try { process.kill(p, s); } catch { /* dead */ }
  });
  const getDesc = descendants || ((p) => descendantsOf(p));

  // 1. Enumerate live descendants of the (still-alive) root, PLUS any extra
  //    pids the caller snapshotted earlier (handles re-parented orphans).
  let pids = [pid, ...getDesc(pid), ...extraPids];
  // Dedupe.
  pids = [...new Set(pids)];
  // 2. Also signal the process group as belt-and-suspenders (catches any
  //    descendant /proc missed). Negative pid = the whole group on POSIX.
  if (process.platform !== 'win32') {
    try { process.kill(-pid, signal); } catch { /* group gone */ }
  }
  // 3. Signal each enumerated pid, descendants-first (leaves → root) so a
  //    parent can't respawn a child we just killed.
  for (const p of [...pids].reverse()) {
    try { k(p, signal); } catch { /* dead */ }
  }

  // 4. Grace window, then SIGKILL any survivors.
  const deadline = Date.now() + graceMs;
  const survivors = () => pids.filter((p) => isPidAliveSync(p));
  while (Date.now() < deadline && survivors().length > 0) {
    // bounded busy-wait slice
    const spin = Date.now() + 50;
    while (Date.now() < spin) { /* spin */ }
  }
  // Re-enumerate before SIGKILL (children may have spawned more during grace).
  const fresh = [...new Set([pid, ...getDesc(pid), ...extraPids])];
  for (const p of [...fresh].reverse()) {
    if (isPidAliveSync(p)) {
      try { k(p, 'SIGKILL'); } catch { /* dead */ }
    }
  }
  // Windows: rely on taskkill /T if the per-pid walk missed anything.
  if (process.platform === 'win32' && killTreeSync) {
    try { killTreeSync(pid, 'SIGKILL'); } catch { /* dead */ }
  }
}

/** Default synchronous tree kill — kept for API compatibility; the real
 * descendant walk now lives in treeKill. POSIX: signal the group as a fallback.
 * Windows: `taskkill /PID <pid> /T /F`. */
export function defaultTreeKillSync(pid, sig) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // POSIX: signal the process group (negative pid). The child was spawned
  // detached, so it leads its own group; -pid reaches descendants in that group.
  try {
    process.kill(-pid, sig);
  } catch (err) {
    try { process.kill(pid, sig); } catch { throw err; }
  }
}

/** Synchronous liveness check for a pid (and its group on POSIX). Best-effort:
 * returns false if the pid is gone or not ours to query. */
export function isPidAliveSync(pid) {
  if (!pid || pid <= 0) return false;
  if (process.platform === 'win32') {
    try {
      execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return true; // tasklist lists the row if alive
    } catch {
      return false;
    }
  }
  // Sending signal 0 tests existence without actually signaling.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a detached child (process-group leader) and run it to completion under
 * a bounded timeout. On timeout/error/exit, reap the whole tree via treeKill.
 * Resolves to `{ status, signal, error, timedOut }` mirroring spawnSync shape
 * but with a real `timedOut` flag set when our deadline fired.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, killSignal?: string, graceMs?: number, env?: NodeJS.ProcessEnv, stdio?: import('child_process').StdioOptions, cwd?: string, killTreeSync?: (pid:number,sig:string)=>void }} [opts]
 * @returns {Promise<{ status: number|null, signal: string|null, error?: Error|null, timedOut: boolean, pid: number|null }>}
 */
export function runChild(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 0;
    const killSignal = opts.killSignal ?? 'SIGTERM';
    const graceMs = opts.graceMs ?? 1500;
    let timer = null;
    let poller = null;
    let settled = false;
    // Snapshot of descendant pids seen while the child was alive. We re-scan
    // the live child's descendants periodically so that, when the child exits
    // on the NORMAL path (not timeout), we can still kill descendants that get
    // re-parented to init (where /proc/<dead-pid>/children no longer finds
    // them). This is the key fix for the review's "orphaned Electron/Xvfb"
    // gap on the non-timeout exit path.
    const seenDescendants = new Set();
    const result = { status: null, signal: null, error: null, timedOut: false, pid: null };

    let child;
    try {
      child = spawn(cmd, args, {
        detached: true,
        stdio: opts.stdio ?? 'inherit',
        env: opts.env,
        cwd: opts.cwd
      });
    } catch (err) {
      resolve({ ...result, error: err });
      return;
    }
    result.pid = child.pid ?? null;

    // Poll descendants frequently while the child is alive, so the snapshot is
    // current at exit/timeout time. A short interval (50ms) is required so a
    // fast-exiting child (e.g. --exit-after-spawn) is still swept at least
    // once before it exits and its descendants get re-parented to init (where
    // /proc/<dead-pid>/children can no longer find them). NOT unref'd — the
    // snapshot must actually run.
    const pollDescendants = () => {
      if (result.pid && isPidAliveSync(result.pid)) {
        for (const d of descendantsOf(result.pid)) seenDescendants.add(d);
      }
    };
    pollDescendants();
    poller = setInterval(pollDescendants, 50);

    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (poller) { clearInterval(poller); poller = null; }
      result.timedOut = !!timedOut;
      // One last descendant sweep before reaping (catches the freshest tree).
      pollDescendants();
      // Always reap the tree — covers timeout AND normal/abnormal exit, so no
      // descendants are orphaned on any path. Pass the snapshotted descendants
      // as extraPids so re-parented orphans are still reached.
      if (result.pid) {
        treeKill({
          pid: result.pid,
          signal: killSignal,
          graceMs,
          extraPids: [...seenDescendants],
          killTreeSync: opts.killTreeSync
        });
      }
      // Detached children are NOT auto-reaped by Node; unref so we don't hold
      // the loop, and let treeKill's SIGKILL reap any zombie.
      try { child.unref(); } catch { /* ignore */ }
      resolve(result);
    };

    child.on('error', (err) => { result.error = err; finish(false); });
    child.on('exit', (code, signal) => {
      result.status = code;
      result.signal = signal;
      finish(false);
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        // Deadline fired: child still running. Mark timeout, then tree-kill.
        result.timedOut = true;
        result.error = result.error || Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', signal: killSignal });
        finish(true);
      }, timeoutMs);
      // Don't keep the event loop alive solely for the timer.
      timer.unref?.();
    }
  });
}
