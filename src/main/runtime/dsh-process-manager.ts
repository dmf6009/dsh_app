/**
 * DSH Process Manager (§30).
 *
 * Owns the lifecycle of one DSH child process (`dsh --profile desktop
 * --stdio`, or any stand-in command such as the Phase 0 stub runtime):
 *
 * - spawn with piped stdio and line-oriented stdout decoding (JSONL)
 * - stdin writes of encoded protocol frames
 * - stderr captured into a bounded tail for diagnostics (§32: show stderr)
 * - exit code / signal capture; abnormal termination is surfaced both as a
 *   transport event and as a synthesized protocol `error` frame
 * - graceful stop (SIGTERM → SIGKILL after a grace period) that always waits
 *   until the child is reaped, so no zombie processes are left behind
 * - restart support: stop whatever is running, then start fresh
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { encodeFrame, FrameDecoder } from '../../shared/protocol/codec';
import type { ErrorEventFrame } from '../../shared/protocol/types';

export type DshProcessState = 'idle' | 'starting' | 'running' | 'stopping' | 'exited';

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the stop was initiated by this manager (stop/restart). */
  expected: boolean;
}

export interface DshProcessManagerOptions {
  /** Executable to spawn, e.g. `dsh` or `node`. */
  command: string;
  /** Args, e.g. ['--profile', 'desktop', '--stdio'] or ['scripts/stub-runtime.mjs']. */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Max bytes for a single stdout protocol line before protection kicks in. */
  maxLineBytes?: number;
  /** How long to wait between SIGTERM and SIGKILL when stopping. Default 3s. */
  killGraceMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 3_000;

/** Bounded ring of recent stderr text, kept for error reports. */
class StderrTail {
  private chunks: string[] = [];
  private total = 0;
  constructor(private readonly limit = 16 * 1024) {}

  append(text: string): void {
    this.chunks.push(text);
    this.total += Buffer.byteLength(text);
    while (this.total > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.total -= Buffer.byteLength(dropped);
    }
  }

  reset(): void {
    this.chunks = [];
    this.total = 0;
  }

  toString(): string {
    return this.chunks.join('');
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface DshProcessManagerEvents {
  'state-changed': (state: DshProcessState, previous: DshProcessState) => void;
  /** A decoded protocol frame arrived on the child's stdout. */
  frame: (frame: unknown) => void;
  /** A stdout line could not be decoded (malformed JSON / bad envelope). */
  'decode-error': (info: { reason: string; detail?: string; preview?: string }) => void;
  /** One or more stdout lines exceeded the configured size cap. */
  'oversized-line': (info: { count: number }) => void;
  stderr: (text: string) => void;
  'spawn-error': (error: Error) => void;
  exit: (info: ExitInfo) => void;
}

export declare interface DshProcessManager {
  on<E extends keyof DshProcessManagerEvents>(event: E, listener: DshProcessManagerEvents[E]): this;
  off<E extends keyof DshProcessManagerEvents>(event: E, listener: DshProcessManagerEvents[E]): this;
  once<E extends keyof DshProcessManagerEvents>(
    event: E,
    listener: DshProcessManagerEvents[E]
  ): this;
  emit<E extends keyof DshProcessManagerEvents>(
    event: E,
    ...args: Parameters<DshProcessManagerEvents[E]>
  ): boolean;
}

export class DshProcessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: DshProcessState = 'idle';
  private readonly decoder: FrameDecoder;
  private readonly stderrTail = new StderrTail();
  private readonly killGraceMs: number;
  private killTimer: NodeJS.Timeout | null = null;
  private exitDeferred: Deferred<ExitInfo> | null = null;
  private lastExit: ExitInfo | null = null;

  constructor(private readonly options: DshProcessManagerOptions) {
    super();
    this.decoder = new FrameDecoder({ maxLineBytes: options.maxLineBytes });
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  get currentState(): DshProcessState {
    return this.state;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get commandLine(): string {
    return [this.options.command, ...(this.options.args ?? [])].join(' ');
  }

  get recentStderr(): string {
    return this.stderrTail.toString();
  }

  /**
   * Spawn the child process. Resolves once the OS-level spawn succeeded and
   * stdio is wired; application readiness is signaled separately by the
   * runtime itself through a `ready` frame (observed via `frame`).
   */
  async start(): Promise<void> {
    if (this.state === 'starting' || this.state === 'running') {
      throw new Error(`cannot start: process manager is ${this.state}`);
    }
    this.decoder.reset();
    this.stderrTail.reset();
    this.lastExit = null;
    this.setState('starting');

    let child: ChildProcess;
    try {
      child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      this.failSpawn(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.child = child;
    this.exitDeferred = createDeferred<ExitInfo>();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        child.removeListener('error', onError);
        child.removeListener('spawn', onSpawn);
      };
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.failSpawn(err);
        reject(err);
      };
      const onSpawn = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.wire(child);
        // A concurrent stop() may already be waiting; don't clobber its state.
        if (this.state === 'starting') this.setState('running');
        resolve();
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  }

  /** Send one protocol frame to the child's stdin. Returns false if not running. */
  send(frame: { v: unknown; type: unknown }): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable || this.state !== 'running') return false;
    stdin.write(encodeFrame(frame));
    return true;
  }

  /**
   * Stop the child: close stdin, SIGTERM, escalate to SIGKILL after the grace
   * period, and wait until the process is reaped. Idempotent and safe to call
   * from any state.
   */
  async stop(): Promise<ExitInfo> {
    const child = this.child;
    if (!child) {
      return this.lastExit ?? { code: null, signal: null, expected: true };
    }
    if (this.state === 'stopping') {
      return this.exitDeferred ? this.exitDeferred.promise : (this.lastExit ?? abortExit());
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      // Already dead; wait for the exit bookkeeping to land.
      return this.exitDeferred ? this.exitDeferred.promise : (this.lastExit ?? abortExit());
    }

    this.setState('stopping');
    try {
      child.stdin?.destroy();
    } catch {
      /* pipe already gone */
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    if (this.killGraceMs > 0) {
      this.killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, this.killGraceMs);
      this.killTimer.unref();
    }

    return this.exitDeferred ? this.exitDeferred.promise : abortExit();
  }

  /** Stop anything running, then start a fresh child. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Stop the child and detach all listeners. Final teardown helper. */
  async dispose(): Promise<void> {
    await this.stop();
    this.clearKillTimer();
    this.removeAllListeners();
  }

  /* ---------------------------------------------------------------- */

  private failSpawn(err: Error): void {
    this.child = null;
    this.exitDeferred?.resolve({ code: null, signal: null, expected: true });
    this.setState('idle');
    this.emit('spawn-error', err);
  }

  private wire(child: ChildProcess): void {
    const stdout = child.stdout!;
    const stderr = child.stderr!;

    stdout.on('data', (chunk: Buffer) => {
      const result = this.decoder.push(chunk);
      result.frames.forEach((frame) => this.emit('frame', frame));
      result.invalid.forEach((info) =>
        this.emit('decode-error', { reason: info.reason, detail: info.detail, preview: info.preview })
      );
      if (result.oversizedLines > 0) {
        this.emit('oversized-line', { count: result.oversizedLines });
      }
    });

    // The streams die with the pipe; swallow their own 'error' events so they
    // never crash the host (streams without an error listener throw).
    stdout.on('error', () => undefined);
    stderr.on('error', () => undefined);

    stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderrTail.append(text);
      this.emit('stderr', text);
    });

    child.once('exit', (code, signal) => this.handleExit(code, signal));
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearKillTimer();
    const wasStopping = this.state === 'stopping';
    this.child = null;
    const info: ExitInfo = { code, signal, expected: wasStopping };
    this.lastExit = info;
    // Abnormal termination (crash / kill) is surfaced additionally as a
    // synthesized protocol `error` frame (§32 Agent Crash): consumers listen
    // to frames uniformly. A deliberate clean self-exit (code 0) stays silent.
    const abnormal = signal !== null || (code !== null && code !== 0);
    if (!wasStopping && abnormal) {
      const message =
        `DSH process terminated unexpectedly ` +
        `(code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      const frame: ErrorEventFrame = {
        v: 1,
        type: 'error',
        code: signal != null ? 'process_killed' : 'process_exited_unexpectedly',
        message,
        recoverable: true
      };
      this.emit('frame', frame);
    }
    this.setState(wasStopping ? 'idle' : 'exited');
    this.exitDeferred?.resolve(info);
    this.emit('exit', info);
  }

  private setState(next: DshProcessState): void {
    const previous = this.state;
    if (previous === next) return;
    this.state = next;
    this.emit('state-changed', next, previous);
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }
}

function abortExit(): ExitInfo {
  throw new Error('process manager is in an inconsistent state: no exit record available');
}
