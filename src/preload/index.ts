/**
 * Preload — bridges the sandboxed renderer to the main process over IPC.
 * Exposes the typed surface declared in shared/desktop-api.ts. Every channel
 * name here has a matching `ipcMain.handle` in main/index.ts.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type {
  ApprovalDeliveryNotice,
  ApprovalResolution,
  ConnectionState,
  DesktopApi,
  RuntimeStatus
} from '../shared/desktop-api';
import type { ApprovalRequestPayload } from '../shared/approval-protocol';
import type { ChangesSnapshot, FileDiffResult, RevertFileResult } from '../shared/changes';
import type { ProtocolViolationInfo, RuntimeEventFrame } from '../shared/protocol/types';
import type {
  ModelsRefreshResult,
  OperationResult,
  PermissionMode,
  SaveProviderInput,
  SettingsView
} from '../shared/settings';
import type { OpenProjectResult, PathCheckResult, RecentProject } from '../shared/workspace';
import type { PluginsSnapshot, PluginMutationResult } from '../shared/plugins';
import type {
  SessionLoadResult,
  SessionMutationResult,
  SessionRecord,
  SessionSummary
} from '../shared/session';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: DesktopApi = {
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
    subscribe<ConnectionState>('runtime:connection-state', listener),

  respondApproval: (
    requestId: string,
    reply: { decision: 'allow' | 'reject'; scope: 'once' | 'session' }
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('approval:respond', requestId, reply),
  onApprovalRequest: (listener: (payload: ApprovalRequestPayload) => void): (() => void) =>
    subscribe<ApprovalRequestPayload>('runtime:approval-request', listener),
  onApprovalResolved: (listener: (resolution: ApprovalResolution) => void): (() => void) =>
    subscribe<ApprovalResolution>('runtime:approval-resolved', listener),
  onApprovalNotice: (listener: (notice: ApprovalDeliveryNotice) => void): (() => void) =>
    subscribe<ApprovalDeliveryNotice>('runtime:approval-notice', listener),

  getRuntimeLogTail: (category?: 'stdout' | 'stderr' | 'event' | 'tool' | 'model'): Promise<string> =>
    ipcRenderer.invoke('runtime:get-log-tail', category),
  onProtocolViolation: (listener: (info: ProtocolViolationInfo) => void): (() => void) =>
    subscribe<ProtocolViolationInfo>('runtime:protocol-violation', listener),

  getChangesSnapshot: (): Promise<ChangesSnapshot> => ipcRenderer.invoke('changes:get-snapshot'),
  getFileDiff: (path: string): Promise<FileDiffResult> =>
    ipcRenderer.invoke('changes:get-file-diff', path),
  revertFile: (path: string): Promise<{ result: RevertFileResult; snapshot: ChangesSnapshot }> =>
    ipcRenderer.invoke('changes:revert-file', path),
  onChangesSnapshot: (listener: (snapshot: ChangesSnapshot) => void): (() => void) =>
    subscribe<ChangesSnapshot>('changes:snapshot', listener),

  openProject: (): Promise<OpenProjectResult> => ipcRenderer.invoke('workspace:open-project'),
  openProjectAt: (path: string): Promise<OpenProjectResult> =>
    ipcRenderer.invoke('workspace:open-project-at', path),
  listRecentProjects: (): Promise<RecentProject[]> => ipcRenderer.invoke('workspace:list-recent'),
  pinRecentProject: (id: string, pinned: boolean): Promise<OperationResult> =>
    ipcRenderer.invoke('workspace:pin-recent', id, pinned),
  removeRecentProject: (id: string): Promise<OperationResult> =>
    ipcRenderer.invoke('workspace:remove-recent', id),
  checkPath: (path: string): Promise<PathCheckResult> =>
    ipcRenderer.invoke('workspace:check-path', path),
  getCurrentWorkspace: (): Promise<{ path: string | null }> =>
    ipcRenderer.invoke('workspace:get-current'),
  ensureWorkspaceActive: (path: string): Promise<OpenProjectResult> =>
    ipcRenderer.invoke('workspace:ensure-active', path),

  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke('session:list'),
  getActiveSessionId: (): Promise<{ id: string | null }> =>
    ipcRenderer.invoke('session:get-active-id'),
  createSession: (title?: string): Promise<{ result: SessionMutationResult; record?: SessionRecord }> =>
    ipcRenderer.invoke('session:create', title),
  loadSession: (id: string): Promise<SessionLoadResult> =>
    ipcRenderer.invoke('session:load', id),
  saveSession: (record: SessionRecord): Promise<SessionMutationResult> =>
    ipcRenderer.invoke('session:save', record),
  switchSession: (id: string): Promise<SessionMutationResult> =>
    ipcRenderer.invoke('session:switch', id),
  deleteSession: (id: string): Promise<SessionMutationResult> =>
    ipcRenderer.invoke('session:delete', id),
  flushBeforeQuit: (record: SessionRecord): SessionMutationResult =>
    ipcRenderer.sendSync('session:flush-before-quit', record),

  getSettings: (): Promise<SettingsView> => ipcRenderer.invoke('settings:get'),
  saveProvider: (input: SaveProviderInput): Promise<OperationResult> =>
    ipcRenderer.invoke('settings:save-provider', input),
  deleteProvider: (name: string): Promise<OperationResult> =>
    ipcRenderer.invoke('settings:delete-provider', name),
  setPermissionsMode: (mode: PermissionMode): Promise<OperationResult> =>
    ipcRenderer.invoke('settings:set-permissions-mode', mode),
  setDshPath: (path: string | null): Promise<OperationResult> =>
    ipcRenderer.invoke('settings:set-dsh-path', path),
  refreshModels: (input: {
    providerName?: string;
    baseUrl: string;
    apiKey?: string;
  }): Promise<ModelsRefreshResult> => ipcRenderer.invoke('settings:refresh-models', input),

  detectDsh: () => ipcRenderer.invoke('dsh:detect'),
  chooseDshPath: () => ipcRenderer.invoke('dsh:choose-path'),
  getStderrTail: (): Promise<string> => ipcRenderer.invoke('dsh:get-stderr-tail'),

  listPlugins: (): Promise<PluginsSnapshot> => ipcRenderer.invoke('plugins:list'),
  addPlugin: (spec: string): Promise<PluginMutationResult> => ipcRenderer.invoke('plugins:add', spec),
  removePlugin: (name: string): Promise<PluginMutationResult> =>
    ipcRenderer.invoke('plugins:remove', name)
};

contextBridge.exposeInMainWorld('desktop', api);
