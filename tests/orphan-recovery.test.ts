/**
 * Orphan recovery tests (DSHA-5 / P0-7 同口径): stale pid cleanup, foreign
 * process protection, real-orphan termination, and corrupt pidfile handling.
 * All process interactions are injected — no actual signals are sent here
 * except through fakes.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  claimRuntimePidFile,
  recoverOrphanRuntime,
  releaseRuntimePidFile,
  type RuntimePidRecord
} from '../src/main/runtime/orphan-recovery';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined))
  );
});

async function makePidFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-orphans-'));
  tempDirs.push(dir);
  return path.join(dir, 'runtime.pid');
}

interface World {
  alive: Set<number>;
  commandLines: Map<number, string>;
  terminated: number[];
}

function deps(pidFile: string, world: World) {
  return {
    pidFile,
    isAlive: (pid: number) => world.alive.has(pid),
    readCommandLine: (pid: number) => world.commandLines.get(pid) ?? null,
    terminate: async (pid: number) => {
      world.terminated.push(pid);
      world.alive.delete(pid);
    }
  };
}

const OUR_COMMAND = '/usr/local/bin/dsh --profile desktop --stdio';

async function seed(
  pidFile: string,
  record: Partial<RuntimePidRecord> & { pid: number }
): Promise<void> {
  const payload = { command: OUR_COMMAND, startedAt: 1_700_000_000_000, ...record };
  await fs.writeFile(pidFile, `${JSON.stringify(payload)}\n`, 'utf8');
}

describe('recoverOrphanRuntime', () => {
  it('does nothing when no pid file exists', async () => {
    const pidFile = await makePidFile();
    const world: World = { alive: new Set(), commandLines: new Map(), terminated: [] };
    const outcome = await recoverOrphanRuntime(deps(pidFile, world));
    expect(outcome).toEqual({ action: 'none', reason: 'no_pid_file' });
    expect(world.terminated).toHaveLength(0);
  });

  it('cleans up a stale record whose pid is gone', async () => {
    const pidFile = await makePidFile();
    await seed(pidFile, { pid: 4242 });
    const world: World = { alive: new Set(), commandLines: new Map(), terminated: [] };
    const outcome = await recoverOrphanRuntime(deps(pidFile, world));
    expect(outcome).toEqual({ action: 'cleaned_stale', pid: 4242 });
    await expect(fs.access(pidFile)).rejects.toBeTruthy();
  });

  it('terminates a live orphan running our exact runtime command', async () => {
    const pidFile = await makePidFile();
    await seed(pidFile, { pid: 5151 });
    const world: World = {
      alive: new Set([5151]),
      commandLines: new Map([[5151, OUR_COMMAND]]),
      terminated: []
    };
    const outcome = await recoverOrphanRuntime(deps(pidFile, world));
    expect(outcome).toEqual({ action: 'terminated_orphan', pid: 5151 });
    expect(world.terminated).toEqual([5151]);
    await expect(fs.access(pidFile)).rejects.toBeTruthy();
  });

  it('matches resolved-interpreter command lines by suffix', async () => {
    const pidFile = await makePidFile();
    await seed(pidFile, { pid: 6007 });
    const world: World = {
      alive: new Set([6007]),
      commandLines: new Map([[6007, `/usr/bin/node3 ${OUR_COMMAND}`]]),
      terminated: []
    };
    const outcome = await recoverOrphanRuntime(deps(pidFile, world));
    expect(outcome.action).toBe('terminated_orphan');
  });

  it('never touches a live foreign process that merely reused the pid', async () => {
    const pidFile = await makePidFile();
    await seed(pidFile, { pid: 777 });
    const world: World = {
      alive: new Set([777]),
      commandLines: new Map([[777, '/usr/sbin/nginx -g daemon off;']]),
      terminated: []
    };
    const outcome = await recoverOrphanRuntime(deps(pidFile, world));
    expect(outcome).toEqual({ action: 'skipped_foreign_process', pid: 777 });
    expect(world.terminated).toHaveLength(0);
    // The bogus record is still removed so future runs re-evaluate cleanly.
    await expect(fs.access(pidFile)).rejects.toBeTruthy();
  });

  it('survives a corrupt pid file and removes it', async () => {
    const pidFile = await makePidFile();
    await fs.writeFile(pidFile, '{not json at all', 'utf8');
    const world: World = { alive: new Set(), commandLines: new Map(), terminated: [] };
    const outcome = await recoverOrphanRuntime(deps(pidFile, world));
    expect(outcome.action).toBe('none');
    await expect(fs.access(pidFile)).rejects.toBeTruthy();
  });

  it('rejects nonsensical pids (pid 1) without signaling anything', async () => {
    const pidFile = await makePidFile();
    await seed(pidFile, { pid: 1 });
    const world: World = { alive: new Set([1]), commandLines: new Map(), terminated: [] };
    const outcome = await recoverOrphanRuntime(deps(pidFile, world));
    expect(outcome.action).toBe('none');
    expect(world.terminated).toHaveLength(0);
  });
});

describe('pid file claim & release', () => {
  it('writes a readable record and release removes it', async () => {
    const pidFile = await makePidFile();
    await claimRuntimePidFile(pidFile, { pid: 9001, command: OUR_COMMAND }, () => 12345);
    const raw = JSON.parse(await fs.readFile(pidFile, 'utf8')) as RuntimePidRecord;
    expect(raw).toMatchObject({ pid: 9001, command: OUR_COMMAND, startedAt: 12345 });

    await releaseRuntimePidFile(pidFile);
    await expect(fs.access(pidFile)).rejects.toBeTruthy();
    // Releasing again stays quiet.
    await releaseRuntimePidFile(pidFile);
  });
});
