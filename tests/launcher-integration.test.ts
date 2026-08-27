/**
 * Integration tests for the capture-gate process-tree kill (proc-tree.mjs).
 *
 * These ACTUALLY spawn a descendant-producing fixture (`scripts/capture/tree-fixture.mjs`)
 * — unlike tests/launcher.test.ts which tests only pure functions. The review
 * required proof that a bounded-timeout failure leaves NO orphan processes.
 *
 * The fixture spawns a child that spawns a grandchild that spawns a
 * great-grandchild, and every level IGNORES SIGTERM — so a naive "kill the
 * leader only" regression would leave descendants running. runChild must
 * SIGKILL-escalate across the whole process group to reap them. The test
 * records each level's pid to a file and asserts every one is gone afterward,
 * on both the timeout path and the direct (non-Xvfb) path.
 *
 * Cleanup is reliable even on failure: the fixture's idle timer bounds its
 * lifetime (30s) as a backstop, and the test also tree-kills any stragglers in
 * an afterEach. No Electron binary is required (node-only fixture).
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChild, treeKill, isPidAliveSync, isTimeoutError, exitCodeFor } from '../scripts/capture/proc-tree.mjs';
import type { ProcResult } from '../scripts/capture/proc-tree.d.mts';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../scripts/capture/tree-fixture.mjs', import.meta.url));
const NODE = process.execPath;

/** Pids recorded by the fixture (child + grandchild + great-grandchild). */
function readPids(file: string): number[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/** Tree-kill every pid recorded by the fixture, as a reliable cleanup backstop. */
function reapAll(file: string) {
  for (const pid of readPids(file)) {
    try {
      treeKill({ pid, signal: 'SIGKILL', graceMs: 200 });
    } catch {
      /* dead */
    }
  }
}

describe('proc-tree — runChild bounded timeout reaps the whole tree', () => {
  let dir: string;
  let pidsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-proctree-'));
    pidsFile = join(dir, 'pids');
    writeFileSync(pidsFile, '');
  });

  afterEach(() => {
    reapAll(pidsFile); // reliable cleanup even on assertion failure
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('times out, exits non-zero, and leaves NO orphan processes (SIGTERM-ignoring descendants)', async () => {
    // depth 2 ⇒ child + grandchild + great-grandchild (3 descendants), all
    // ignoring SIGTERM. A short timeout fires while they idle.
    const result = await runChild(
      NODE,
      [FIXTURE, '2'],
      {
        timeoutMs: 700,
        killSignal: 'SIGTERM',
        graceMs: 2000,
        env: { ...process.env, DSH_FX_PIDS_FILE: pidsFile },
        stdio: 'ignore'
      }
    );

    // Fail-closed exit code and timeout detection (real shape, not a phantom
    // timedOut field): runChild sets timedOut=true + error.code ETIMEDOUT.
    expect(isTimeoutError(result)).toBe(true);
    expect(exitCodeFor(result)).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.error?.code).toBe('ETIMEDOUT');

    const pids = readPids(pidsFile);
    expect(pids.length).toBe(3); // child + grandchild + great-grandchild recorded

    // Give the SIGKILL escalation (graceMs) a moment to complete reaping.
    await new Promise((r) => setTimeout(r, 400));

    // THE REVIEW REQUIREMENT: every descendant is gone — no orphans.
    for (const pid of pids) {
      expect(isPidAliveSync(pid)).toBe(false);
    }
  }, 15000);

  it('reaps orphaned descendants even when the direct child exits 0 (normal path)', async () => {
    // The child exits 0 immediately (--exit-after-spawn) AFTER spawning a
    // detached, SIGTERM-ignoring grandchild. runChild must still tree-kill
    // the orphaned grandchild on the NORMAL exit path — proving the reaper
    // is not gated on timeout.
    const result = await runChild(
      NODE,
      [FIXTURE, '1', '--exit-after-spawn'],
      {
        timeoutMs: 30000, // won't fire — child exits 0 fast
        killSignal: 'SIGTERM',
        graceMs: 2000,
        env: { ...process.env, DSH_FX_PIDS_FILE: pidsFile },
        stdio: 'ignore'
      }
    );
    // Normal clean exit → status 0. (The grandchild is orphaned but still
    // running until runChild's finish() reaps the tree.)
    expect(result.status).toBe(0);
    expect(isTimeoutError(result)).toBe(false);
    expect(exitCodeFor(result)).toBe(0);

    const pids = readPids(pidsFile);
    expect(pids.length).toBe(2); // child (exited) + orphaned grandchild recorded

    // Give the grace window a moment to complete the tree-kill of the orphan.
    await new Promise((r) => setTimeout(r, 400));
    for (const pid of pids) expect(isPidAliveSync(pid)).toBe(false);
  }, 15000);
});

describe('proc-tree — pure helpers (real spawnSync ETIMEDOUT shape)', () => {
  it('isTimeoutError recognises the real spawnSync ETIMEDOUT shape (not a timedOut field)', () => {
    // The review: spawnSync sets error.code === 'ETIMEDOUT' and signal ===
    // 'SIGTERM'; there is NO timedOut field. The helper must detect this shape.
    // Cast: a real spawnSync error is an Error instance with a .code property;
    // the fixture models only the field the helper reads.
    const realShape = { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, timedOut: undefined, pid: 123 } as unknown as ProcResult;
    expect(isTimeoutError(realShape)).toBe(true);
    expect(exitCodeFor(realShape)).toBe(1);
  });

  it('isTimeoutError recognises runChild timedOut=true shape', () => {
    const runChildShape = { status: null, signal: null, error: { code: 'ETIMEDOUT' }, timedOut: true, pid: 123 } as unknown as ProcResult;
    expect(isTimeoutError(runChildShape)).toBe(true);
    expect(exitCodeFor(runChildShape)).toBe(1);
  });

  it('isTimeoutError is false for a non-timeout spawn error (e.g. ERR_FILE_NOT_FOUND)', () => {
    const notTimeout = { status: null, signal: null, error: { code: 'ENOENT' }, timedOut: false, pid: null } as unknown as ProcResult;
    expect(isTimeoutError(notTimeout)).toBe(false);
    expect(exitCodeFor(notTimeout)).toBe(1); // still fail-closed
  });
});
