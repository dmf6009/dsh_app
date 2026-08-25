/**
 * Runtime Client — application view over the DSH Process Manager.
 *
 * Responsibilities:
 * - translate UI intents into protocol commands (`run` / `cancel`)
 * - track the active run so `cancel` can target it
 * - normalize the terminal frame aliases (`done` ≙ `run_completed`) and stamp
 *   the active run id onto events that omit it
 * - expose a typed event stream for IPC fan-out to the renderer
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { DshProcessManager } from './dsh-process-manager';
import {
  isTerminalEventType,
  makeCancelCommand,
  makeRunCommand,
  type CancelCommandFrame,
  type RunCommandFrame,
  type RuntimeEventFrame
} from '../../shared/protocol/types';

export type RuntimeConnectionState = 'stopped' | 'starting' | 'ready' | 'crashed';

export interface StartOptions {
  sessionId?: string;
}

export interface RuntimeClientEvents {
  'connection-state': (state: RuntimeConnectionState) => void;
  /** Every protocol event frame, post-normalization. */
  event: (frame: RuntimeEventFrame) => void;
  /** Frames that arrived but failed envelope validation. */
  'protocol-violation': (info: { reason: string; detail?: string; preview?: string }) => void;
  stderr: (text: string) => void;
}

export declare interface RuntimeClient {
  on<E extends keyof RuntimeClientEvents>(event: E, listener: RuntimeClientEvents[E]): this;
  off<E extends keyof RuntimeClientEvents>(event: E, listener: RuntimeClientEvents[E]): this;
  emit<E extends keyof RuntimeClientEvents>(
    event: E,
    ...args: Parameters<RuntimeClientEvents[E]>
  ): boolean;
}

const READY_TIMEOUT_MS = 15_000;

export class RuntimeClient extends EventEmitter {
  private connectionState: RuntimeConnectionState = 'stopped';
  private activeRunId: string | null = null;
  /** True while an intentional stop() is in flight, so the resulting exit is
   * not mistaken for a runtime crash. */
  private stopping = false;
  private readonly sessionId: string;

  constructor(private readonly manager: DshProcessManager, options: StartOptions = {}) {
    super();
    this.sessionId = options.sessionId ?? randomUUID();
    this.wireManager();
  }

  get state(): RuntimeConnectionState {
    return this.connectionState;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  get activeRun(): string | null {
    return this.activeRunId;
  }

  get runtimeReady(): boolean {
    return this.connectionState === 'ready';
  }

  /** Spawn the runtime process and wait for its `ready` frame. */
  async start(): Promise<void> {
    if (this.connectionState === 'ready' || this.connectionState === 'starting') return;
    this.setConnectionState('starting');
    try {
      await this.manager.start();
    } catch (err) {
      this.setConnectionState('crashed');
      throw err;
    }
    await this.waitForReady();
  }

  async stop(): Promise<void> {
    if (this.connectionState === 'stopped') return;
    this.stopping = true;
    try {
      await this.manager.stop();
      this.activeRunId = null;
    } finally {
      this.stopping = false;
    }
    this.setConnectionState('stopped');
  }

  async restart(): Promise<void> {
    await this.manager.restart();
    this.setConnectionState('starting');
    await this.waitForReady();
  }

  /** Send a `run` command; resolves with the generated run id. */
  run(message: string, workspace: string): string {
    const runId = randomUUID();
    const command: RunCommandFrame = makeRunCommand({
      run_id: runId,
      session_id: this.sessionId,
      workspace,
      message
    });
    if (!this.manager.send(command)) {
      throw new Error(`cannot send run: runtime is ${this.manager.currentState}`);
    }
    this.activeRunId = runId;
    return runId;
  }

  /** Request cancellation of the given run (default: the active one). */
  cancel(runId: string | null = this.activeRunId): boolean {
    if (!runId) return false;
    const command: CancelCommandFrame = makeCancelCommand(runId);
    return this.manager.send(command);
  }

  /* ---------------------------------------------------------------- */

  private wireManager(): void {
    this.manager.on('frame', (frame) => this.onFrame(frame));
    this.manager.on('decode-error', (info) => this.emit('protocol-violation', info));
    this.manager.on('stderr', (text) => this.emit('stderr', text));
    this.manager.on('exit', () => {
      if (!this.stopping && this.connectionState !== 'crashed' && this.connectionState !== 'stopped') {
        this.setConnectionState('crashed');
      }
    });
  }

  private onFrame(raw: unknown): void {
    const frame = raw as RuntimeEventFrame;
    switch (frame.type) {
      case 'ready': {
        this.setConnectionState('ready');
        break;
      }
      case 'run_started': {
        if (!frame.run_id && this.activeRunId) {
          (frame as { run_id?: string }).run_id = this.activeRunId;
        }
        break;
      }
      default:
        break;
    }
    if (
      isTerminalEventType(frame.type) &&
      frame.run_id === undefined &&
      this.activeRunId &&
      (frame.type === 'run_completed' || frame.type === 'done' || frame.type === 'run_cancelled')
    ) {
      (frame as { run_id?: string }).run_id = this.activeRunId;
    }
    if (isTerminalEventType(frame.type)) {
      this.activeRunId = null;
    }
    this.emit('event', frame);
  }

  private waitForReady(): Promise<void> {
    if (this.connectionState === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`runtime did not become ready within ${READY_TIMEOUT_MS}ms`));
      }, READY_TIMEOUT_MS);
      timer.unref();

      const onFrame = (raw: unknown): void => {
        if ((raw as { type?: string })?.type === 'ready') {
          cleanup();
          resolve();
        }
      };
      const onSpawnError = (): void => {
        cleanup();
        reject(new Error('runtime process failed to start'));
      };
      const onExit = (): void => {
        cleanup();
        reject(new Error('runtime process exited before becoming ready'));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.manager.removeListener('frame', onFrame);
        this.manager.removeListener('spawn-error', onSpawnError);
        this.manager.removeListener('exit', onExit);
      };

      this.manager.on('frame', onFrame);
      this.manager.on('spawn-error', onSpawnError);
      this.manager.on('exit', onExit);
    });
  }

  private setConnectionState(state: RuntimeConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.emit('connection-state', state);
  }
}
