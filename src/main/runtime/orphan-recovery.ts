/**
 * Orphan Recovery — pidfile-based cleanup of leftover runtime processes
 * (issue DSHA-5; same bar as Phase 0 deliverable P0-7 "no orphans").
 *
 * When the Desktop itself crashes hard (or was killed), a still-running DSH
 * child can outlive it. On the next start we read `<home>/.dsh/desktop/
 * runtime.pid` and:
 *
 *   - missing / corrupt file            → nothing to do;
 *   - recorded pid dead                 → stale file, remove it;
 *   - pid alive but different command   → foreign process, never touch it;
 *   - pid alive with our runtime command → terminate (TERM→KILL) and remove.
 *
 * All process interactions are injected so the unit tests run without
 * spawning anything.
 */

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

export interface RuntimePidRecord {
  pid: number;
  /** Full command line of the child we spawned. */
  command: string;
  startedAt: number;
}

export interface OrphanRecoveryDeps {
  pidFile: string;
  now?: () => number;
  isAlive: (pid: number) => boolean | Promise<boolean>;
  /** Command line of an arbitrary live process, or null when unreadable. */
  readCommandLine: (pid: number) => string | null | Promise<string | null>;
  terminate: (pid: number) => Promise<void>;
}

export type RecoveryOutcome =
  | { action: 'none'; reason: 'no_pid_file' }
  | { action: 'none'; reason: 'corrupt_pid_file'; raw?: string }
  | { action: 'cleaned_stale'; pid: number }
  | { action: 'skipped_foreign_process'; pid: number }
  | { action: 'terminated_orphan'; pid: number };

/** Default terminate implementation: SIGTERM, grace wait, then SIGKILL. */
export function defaultTerminate(graceMs = 3000): (pid: number) => Promise<void> {
  return async (pid) => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // already gone
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        process.kill(pid, 0);
      } catch {
        return; // exited on SIGTERM
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  };
}

/** Best-effort `/proc/<pid>/cmdline` reader (Linux); null elsewhere. */
export function readLinuxCommandLine(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.replace(/\0+$/, '').replace(/\0/g, ' ').trim() || null;
  } catch {
    return null;
  }
}

export async function recoverOrphanRuntime(deps: OrphanRecoveryDeps): Promise<RecoveryOutcome> {
  let raw: string;
  try {
    raw = await fs.readFile(deps.pidFile, 'utf8');
  } catch {
    return { action: 'none', reason: 'no_pid_file' };
  }

  let record: RuntimePidRecord | null = null;
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimePidRecord>;
    if (
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 1 &&
      typeof parsed.command === 'string'
    ) {
      record = { pid: parsed.pid, command: parsed.command, startedAt: parsed.startedAt ?? 0 };
    }
  } catch {
    record = null;
  }
  if (record === null) {
    await removeQuietly(deps.pidFile);
    return { action: 'none', reason: 'corrupt_pid_file', raw: raw.slice(0, 200) };
  }

  const alive = await deps.isAlive(record.pid);
  if (!alive) {
    await removeQuietly(deps.pidFile);
    return { action: 'cleaned_stale', pid: record.pid };
  }

  const commandLine = await deps.readCommandLine(record.pid);
  if (!commandLine || !commandLinesMatch(commandLine, record.command)) {
    // Never touch a process we cannot positively identify as ours.
    await removeQuietly(deps.pidFile);
    return { action: 'skipped_foreign_process', pid: record.pid };
  }

  await deps.terminate(record.pid);
  await removeQuietly(deps.pidFile);
  return { action: 'terminated_orphan', pid: record.pid };
}

/** Record a freshly spawned child so a later crash can be cleaned up. */
export async function claimRuntimePidFile(
  pidFile: string,
  record: Omit<RuntimePidRecord, 'startedAt'> & { startedAt?: number },
  now: () => number = Date.now
): Promise<void> {
  const payload: RuntimePidRecord = { ...record, startedAt: record.startedAt ?? now() };
  await fs.mkdir(path.dirname(pidFile), { recursive: true });
  await fs.writeFile(pidFile, `${JSON.stringify(payload)}\n`, 'utf8');
}

export async function releaseRuntimePidFile(pidFile: string): Promise<void> {
  await removeQuietly(pidFile);
}

function commandLinesMatch(live: string, claimed: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const a = norm(live);
  const b = norm(claimed);
  if (a === b) return true;
  // The live cmdline may carry a resolved interpreter prefix
  // ("/usr/bin/node scripts/x.mjs" vs "node scripts/x.mjs"): compare tails.
  return a.endsWith(b) || b.endsWith(a);
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    /* best effort */
  }
}
