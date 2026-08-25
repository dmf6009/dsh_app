/**
 * Preload — bridges the sandboxed renderer to the main process over IPC.
 * Exposes the minimal typed surface declared in shared/desktop-api.ts.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type { ConnectionState, RuntimeStatus } from '../shared/desktop-api';
import type { RuntimeEventFrame } from '../shared/protocol/types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api = {
  getStatus: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:get-status'),
  startRuntime: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:start'),
  stopRuntime: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:stop'),
  restartRuntime: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:restart'),
  sendMessage: (message: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('runtime:send', message),
  cancelRun: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('runtime:cancel'),
  onEvent: (listener: (frame: RuntimeEventFrame) => void): (() => void) =>
    subscribe<RuntimeEventFrame>('runtime:event', listener),
  onConnectionState: (listener: (state: ConnectionState) => void): (() => void) =>
    subscribe<ConnectionState>('runtime:connection-state', listener)
};

contextBridge.exposeInMainWorld('desktop', api);
