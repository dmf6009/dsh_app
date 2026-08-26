/**
 * Capture-harness preload (DSHA-6 P1-2 acceptance evidence).
 *
 * Exposes a `window.desktop` stub covering the full DesktopApi surface the
 * renderer touches at startup + the Changes/Diff layer, driven by
 * `capture:state` IPC from the capture main. Test-only plumbing — never
 * shipped.
 */

const { contextBridge, ipcRenderer } = require('electron');

let state = { mode: 'normal', busyDelayMs: 2500 };
let changesListener = null;

const TS = '2026-01-01T00:00:00.000Z';
function makeRecords() {
  if (state.mode === 'empty') return [];
  return [
    {
      path: 'src/auth/login.py',
      kind: 'modified',
      source: 'git',
      firstSeenAt: TS,
      lastSeenAt: TS
    },
    {
      path: 'assets/logo.bin',
      kind: 'added',
      source: 'event',
      firstSeenAt: TS,
      lastSeenAt: TS
    },
    {
      path: 'tests/test_login.py',
      kind: 'deleted',
      source: 'git',
      firstSeenAt: TS,
      lastSeenAt: TS
    }
  ];
}

function snapshot() {
  return {
    root: '/demo',
    branch: 'feature/demo',
    detached: false,
    gitAvailable: true,
    records: makeRecords(),
    generatedAt: Date.now()
  };
}

const resolved = (value) => () => Promise.resolve(value);
const noopSub = () => () => {};
const noop = () => undefined;

const api = {
  // --- Changes / Diff (specific behaviour) ---
  getChangesSnapshot: () => Promise.resolve(snapshot()),
  getFileDiff: (path) => {
    if (String(path).includes('logo.bin')) {
      return Promise.resolve({ ok: true, path: String(path), binary: true });
    }
    return Promise.resolve({
      ok: true,
      path: String(path),
      original: 'def login(user):\n    pass\n',
      modified: 'def login(user):\n    # session check\n    return True\n',
      unified:
        'diff --git a/src/auth/login.py b/src/auth/login.py\n' +
        '@@ -1,2 +1,4 @@\n' +
        ' def login(user):\n' +
        '     pass\n' +
        '+    # session check\n' +
        '+    return True\n',
      originalFromHead: true,
      binary: false,
      truncated: false
    });
  },
  revertFile: (path) =>
    new Promise((resolve) => {
      setTimeout(
        () =>
          resolve({
            result: { ok: true, action: 'restored-content' },
            snapshot: snapshot()
          }),
        state.busyDelayMs
      );
    }),
  onChangesSnapshot: (listener) => {
    changesListener = listener;
    return () => {
      changesListener = null;
    };
  },

  // --- subscriptions (must return cleanup) ---
  onEvent: noopSub,
  onConnectionState: noopSub,
  onApprovalRequest: noopSub,
  onApprovalResolved: noopSub,
  onApprovalNotice: noopSub,

  // --- startup / settings / runtime (benign resolved values) ---
  getStatus: resolved({ state: 'stopped', run_id: null, sessionId: null }),
  startRuntime: resolved({ state: 'starting' }),
  stopRuntime: resolved({ state: 'stopped' }),
  restartRuntime: resolved({ state: 'starting' }),
  cancelRun: resolved({ ok: true }),
  listRecentProjects: resolved([]),
  pinRecentProject: resolved({ ok: true }),
  removeRecentProject: resolved({ ok: true }),
  getSettings: resolved({ providers: [], warnings: [], theme: 'light', autoStart: false }),
  detectDsh: resolved({ available: false, path: null, version: null }),
  refreshModels: resolved({ models: [] }),
  checkPath: resolved({ ok: true }),
  chooseDshPath: resolved({ path: null }),
  setDshPath: resolved({ ok: true }),
  getStderrTail: resolved(''),
  sendMessage: resolved({ ok: true }),
  respondApproval: resolved({ ok: true }),
  setPermissionsMode: resolved({ ok: true }),
  saveProvider: resolved({ ok: true }),
  deleteProvider: resolved({ ok: true }),
  openProject: resolved({ ok: true }),
  openProjectAt: resolved({ ok: true }),
  getChangesSnapshotFallback: resolved(snapshot())
};

ipcRenderer.on('capture:state', (_event, s) => {
  state = { ...state, ...s };
  if (changesListener) changesListener(snapshot());
});

contextBridge.exposeInMainWorld('desktop', api);
