/**
 * Contract between the Electron main process and the renderer, exposed over
 * contextBridge as `window.desktop`.
 */

import type { RuntimeEventFrame } from './protocol/types';

export type ConnectionState = 'stopped' | 'starting' | 'ready' | 'crashed';

export interface RuntimeStatus {
  state: ConnectionState;
  sessionId: string | null;
  activeRunId: string | null;
  /** Human-readable description of the child command being run. */
  commandLine: string;
}

export interface DesktopApi {
  getStatus(): Promise<RuntimeStatus>;
  startRuntime(): Promise<RuntimeStatus>;
  stopRuntime(): Promise<RuntimeStatus>;
  restartRuntime(): Promise<RuntimeStatus>;
  sendMessage(message: string): Promise<{ ok: boolean; error?: string }>;
  cancelRun(): Promise<{ ok: boolean; error?: string }>;
  onEvent(listener: (frame: RuntimeEventFrame) => void): () => void;
  onConnectionState(listener: (state: ConnectionState) => void): () => void;
}

export const DESKTOP_API_KEY = 'desktop';
