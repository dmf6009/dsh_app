/**
 * Contract between the Electron main process and the renderer, exposed over
 * contextBridge as `window.desktop`.
 */

import type { RuntimeEventFrame } from './protocol/types';
import type {
  ModelsRefreshResult,
  OperationResult,
  PermissionMode,
  SaveProviderInput,
  SettingsView
} from './settings';
import type { OpenProjectResult, PathCheckResult, RecentProject } from './workspace';

export type ConnectionState = 'stopped' | 'starting' | 'ready' | 'crashed';

export interface RuntimeStatus {
  state: ConnectionState;
  sessionId: string | null;
  activeRunId: string | null;
  /** Human-readable description of the child command being run. */
  commandLine: string;
}

/** Result of probing for a DSH installation (§32/§38 startup chain). */
export interface DshDetection {
  found: boolean;
  /** Absolute path of the detected binary when found. */
  path?: string;
  version?: string;
  /** Why detection failed (already localized for direct display). */
  reason?: string;
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

  /* ---- Home / workspace (§7) ---- */
  /** Opens the native directory picker, then activates + records the project. */
  openProject(): Promise<OpenProjectResult>;
  /** Activates a known path directly (Recent Projects 打开). */
  openProjectAt(path: string): Promise<OpenProjectResult>;
  listRecentProjects(): Promise<RecentProject[]>;
  pinRecentProject(id: string, pinned: boolean): Promise<OperationResult>;
  removeRecentProject(id: string): Promise<OperationResult>;
  checkPath(path: string): Promise<PathCheckResult>;
  getCurrentWorkspace(): Promise<{ path: string | null }>;

  /* ---- Settings (§17/§12/§32) ---- */
  getSettings(): Promise<SettingsView>;
  saveProvider(input: SaveProviderInput): Promise<OperationResult>;
  deleteProvider(name: string): Promise<OperationResult>;
  setPermissionsMode(mode: PermissionMode): Promise<OperationResult>;
  setDshPath(path: string | null): Promise<OperationResult>;
  refreshModels(input: {
    providerName?: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<ModelsRefreshResult>;

  /* ---- DSH detection / runtime diagnostics (§32/§38) ---- */
  detectDsh(): Promise<DshDetection>;
  chooseDshPath(): Promise<{ ok: boolean; path?: string; error?: 'cancelled' | string }>;
  getStderrTail(): Promise<string>;
}

export const DESKTOP_API_KEY = 'desktop';
