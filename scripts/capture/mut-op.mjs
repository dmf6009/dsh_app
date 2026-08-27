#!/usr/bin/env node
/**
 * Per-display flock-guarded critical-section dispatcher.
 *
 * Invoked as: `flock <mutPath> node mut-op.mjs <op> <num> <lockDir> [token] [barrier1] [barrier2]`
 * The caller (xvfb-display.mjs) holds the kernel flock on <mutPath> for the
 * duration of this process, so the path-based critical section runs serialized
 * against every other compliant reclaim/release/clean for this display. flock
 * auto-releases when this process exits (including crash) — so there is NO
 * stale-mutex reclaim path and NO mutex TOCTOU. Crash recovery boundary: a
 * holder that crashes mid-section releases flock on process death; the next
 * caller acquires and observes the (possibly half-mutated) lock state, which
 * the critical-section logic handles (owner-less not reclaimable; O_EXCL is the
 * publish arbiter).
 *
 * This script imports the PURE critical-section functions from xvfb-display.mjs
 * (which take NO flock themselves) and prints a JSON result on stdout:
 *   {"ok":true,"token":"..."}  | {"ok":false}  (for acquireStale)
 *   {"ok":true}                | {"ok":false}  (for releaseOwned/cleanOwnedSocket)
 *
 * Test hooks (barrier1/barrier2): a path whose existence pauses the critical
 * section AFTER the second fd verify, BEFORE the destructive op — letting the
 * adversarial test force BOTH reclaimers/releases to have passed verify before
 * either destructively mutates. Under flock, the second caller BLOCKS until the
 * first releases the mutex, so it can NEVER delete the first's live generation.
 */
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  acquireStaleCritical,
  releaseOwnedCritical,
  cleanOwnedSocketCritical
} from './xvfb-display.mjs';

const [, , op, numStr, lockDir, token, barrier1Arg, barrier2Arg] = process.argv;
const num = parseInt(numStr, 10);
const opts = lockDir ? { lockDir } : {};
const isPidAlive = undefined; // use the module default (process.kill signal 0)
// Test hooks: barriers passed as argv OR via env (DSH_RECLAIM_BARRIER1/2,
// DSH_RELEASE_BARRIER1/2, DSH_CLEANSOCK_BARRIER1/2). argv wins if provided.
const barrier1 = barrier1Arg || process.env.DSH_RECLAIM_BARRIER1 || process.env.DSH_RELEASE_BARRIER1 || process.env.DSH_CLEANSOCK_BARRIER1 || '';
const barrier2 = barrier2Arg || process.env.DSH_RECLAIM_BARRIER2 || process.env.DSH_RELEASE_BARRIER2 || process.env.DSH_CLEANSOCK_BARRIER2 || '';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

try {
  if (op === 'acquireStale') {
    const t = acquireStaleCritical(num, opts, isPidAlive, barrier1, barrier2);
    emit({ ok: t !== null, token: t ?? null });
  } else if (op === 'releaseOwned') {
    const r = releaseOwnedCritical(num, token, opts, barrier1, barrier2);
    emit({ ok: r });
  } else if (op === 'cleanOwnedSocket') {
    // cleanOwnedSocket needs socketExistedBefore + xvfbPidAlive from the caller;
    // passed as extra argv via env below. For the launcher path these are
    // computed by the caller; we pass them as JSON env DSH_CLEANSOCK_INPUT.
    const input = process.env.DSH_CLEANSOCK_INPUT
      ? JSON.parse(process.env.DSH_CLEANSOCK_INPUT)
      : { socketExistedBefore: false, xvfbPidAlive: true };
    const r = cleanOwnedSocketCritical(
      { num, token, socketExistedBefore: input.socketExistedBefore, xvfbPidAlive: input.xvfbPidAlive },
      opts,
      barrier1,
      barrier2
    );
    emit({ ok: r });
  } else {
    emit({ ok: false, error: `unknown op: ${op}` });
  }
} catch (err) {
  // Fail-closed: never print a partial success. Emit ok:false with the message.
  emit({ ok: false, error: err && err.message ? err.message : String(err) });
}
