#!/usr/bin/env node
/**
 * Per-display flock-guarded critical-section dispatcher.
 *
 * Invoked as: `flock <mutPath> node mut-op.mjs <op> <num> <lockDir> [token] [b0] [b1] [b2]`
 * The caller (xvfb-display.mjs) holds the kernel flock on <mutPath> for the
 * duration of this process, so the path-based critical section runs serialized
 * against every other compliant reclaim/release/clean for this display. flock
 * auto-releases when this process exits (including crash) — so there is NO
 * stale-mutex reclaim path and NO mutex TOCTOU. Crash recovery boundary: a
 * holder that crashes mid-section releases flock on process death; the next
 * caller acquires and observes the (possibly half-mutated) lock state, which
 * the critical-section logic handles (owner-less not reclaimable; O_EXCL is the
 * publish arbiter; fd-token re-verify refuses a foreign token).
 *
 * This script imports the PURE critical-section functions from xvfb-display.mjs
 * (which take NO flock themselves) and prints a JSON result on stdout:
 *   {"ok":true,"token":"..."}  | {"ok":false}  (for acquireStale)
 *   {"ok":true}                | {"ok":false}  (for releaseOwned/cleanOwnedSocket)
 *
 * Test hooks (barriers b0/b1/b2): paths whose existence pauses the critical
 * section. b0 = AFTER acquiring flock, BEFORE opening the lock; b1 = AFTER the
 * fd verify, BEFORE the destructive op; b2 = AFTER the destructive op. Under
 * flock, a second caller BLOCKS until the first releases the mutex, so it can
 * NEVER complete verify (let alone destructively mutate) while the first holds
 * the flock. Barriers passed as argv OR via env (DSH_RECLAIM_BARRIER0/1/2,
 * DSH_RELEASE_BARRIER0/1/2, DSH_CLEANSOCK_BARRIER0/1/2); argv wins if provided.
 */
import process from 'node:process';

import {
  acquireStaleCritical,
  releaseOwnedCritical,
  cleanOwnedSocketCritical
} from './xvfb-display.mjs';

const [, , op, numStr, lockDir, token, b0Arg, b1Arg, b2Arg] = process.argv;
const num = parseInt(numStr, 10);
const opts = lockDir ? { lockDir } : {};
const isPidAlive = undefined; // use the module default (process.kill signal 0)
// Resolve barriers: argv first, then env (per-op namespaces).
const envPrefix =
  op === 'acquireStale' ? 'DSH_RECLAIM_BARRIER'
    : op === 'releaseOwned' ? 'DSH_RELEASE_BARRIER'
      : op === 'cleanOwnedSocket' ? 'DSH_CLEANSOCK_BARRIER'
        : 'DSH_BARRIER';
const b0 = b0Arg || process.env[`${envPrefix}0`] || '';
const b1 = b1Arg || process.env[`${envPrefix}1`] || '';
const b2 = b2Arg || process.env[`${envPrefix}2`] || '';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

try {
  if (op === 'acquireStale') {
    const t = acquireStaleCritical(num, opts, isPidAlive, b0, b1, b2);
    emit({ ok: t !== null, token: t ?? null });
  } else if (op === 'releaseOwned') {
    const r = releaseOwnedCritical(num, token, opts, b0, b1, b2);
    emit({ ok: r });
  } else if (op === 'cleanOwnedSocket') {
    const input = process.env.DSH_CLEANSOCK_INPUT
      ? JSON.parse(process.env.DSH_CLEANSOCK_INPUT)
      : { socketExistedBefore: false, xvfbPidAlive: true };
    const r = cleanOwnedSocketCritical(
      { num, token, socketExistedBefore: input.socketExistedBefore, xvfbPidAlive: input.xvfbPidAlive },
      opts,
      b0,
      b1,
      b2
    );
    emit({ ok: r });
  } else {
    emit({ ok: false, error: `unknown op: ${op}` });
  }
} catch (err) {
  // Fail-closed: never print a partial success. Emit ok:false with the message.
  emit({ ok: false, error: err && err.message ? err.message : String(err) });
}
