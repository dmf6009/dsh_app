/**
 * Global renderer store (§30 应用层): route state, runtime connection,
 * workspace context and settings cache.
 *
 * Routing is keep-alive (§39): all four pages stay mounted and are toggled
 * with the `hidden` attribute, so switching Workspace⇄Diff (or leaving
 * Settings and coming back) never loses in-page state.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode
} from 'react';

import type { ConnectionState } from '../../../shared/desktop-api';
import type { DshDetection } from '../../../shared/desktop-api';
import type { SettingsView } from '../../../shared/settings';
import type { RecentProject } from '../../../shared/workspace';

export type Route = 'home' | 'workspace' | 'diff' | 'settings';
export const ROUTES: readonly Route[] = ['home', 'workspace', 'diff', 'settings'] as const;

export const ROUTE_TITLES: Record<Route, string> = {
  home: 'Home',
  workspace: 'Workspace',
  diff: 'Diff Viewer',
  settings: 'Settings'
};

export interface AppState {
  route: Route;
  /** Page to return to when Settings closes (§37: 全局入口，返回原页面). */
  returnRoute: Route;
  connection: ConnectionState;
  commandLine: string;
  workspaceRoot: string | null;
  recent: RecentProject[];
  settings: SettingsView | null;
  dsh: DshDetection | null;
}

export type AppAction =
  | { type: 'navigate'; route: Route }
  | { type: 'open-settings' }
  | { type: 'close-settings' }
  | { type: 'connection'; state: ConnectionState }
  | { type: 'status'; state: ConnectionState; commandLine: string }
  | { type: 'workspace'; path: string | null }
  | { type: 'recent'; projects: RecentProject[] }
  | { type: 'settings-view'; view: SettingsView }
  | { type: 'dsh'; detection: DshDetection };

export const initialAppState: AppState = {
  route: 'home',
  returnRoute: 'home',
  connection: 'stopped',
  commandLine: '',
  workspaceRoot: null,
  recent: [],
  settings: null,
  dsh: null
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'navigate':
      return { ...state, route: action.route };
    case 'open-settings':
      return state.route === 'settings'
        ? state
        : { ...state, route: 'settings', returnRoute: state.route };
    case 'close-settings':
      return { ...state, route: state.returnRoute };
    case 'connection':
      return { ...state, connection: action.state };
    case 'status':
      return { ...state, connection: action.state, commandLine: action.commandLine };
    case 'workspace':
      return { ...state, workspaceRoot: action.path };
    case 'recent':
      return { ...state, recent: action.projects };
    case 'settings-view':
      return { ...state, settings: action.view };
    case 'dsh':
      return { ...state, dsh: action.detection };
    default:
      return state;
  }
}

interface AppStore {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

const AppContext = createContext<AppStore | null>(null);

/**
 * Bootstraps global data once: recent projects, settings, DSH detection and
 * the runtime auto-start chain from Phase 0 (§38).
 */
export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(appReducer, initialAppState);

  useEffect(() => {
    const offState = window.desktop.onConnectionState((connection) =>
      dispatch({ type: 'connection', state: connection })
    );

    void window.desktop
      .getStatus()
      .then((status) =>
        dispatch({ type: 'status', state: status.state, commandLine: status.commandLine })
      )
      .then(() => window.desktop.startRuntime())
      .then((status) =>
        dispatch({ type: 'status', state: status.state, commandLine: status.commandLine })
      )
      .catch(() => dispatch({ type: 'connection', state: 'crashed' }));

    void window.desktop.listRecentProjects().then((projects) => {
      dispatch({ type: 'recent', projects });
      // listRecentProjects returns pinned-first order; activating its head
      // opens the shell on the pinned project (falling back to most recent).
      if (projects.length > 0) {
        dispatch({ type: 'workspace', path: projects[0]!.path });
      }
    });

    void window.desktop.getSettings().then((view) => dispatch({ type: 'settings-view', view }));
    void window.desktop.detectDsh().then((detection) => dispatch({ type: 'dsh', detection }));

    return () => {
      offState();
    };
  }, []);

  const store = useMemo<AppStore>(() => ({ state, dispatch }), [state]);
  return <AppContext.Provider value={store}>{children}</AppContext.Provider>;
}

export function useApp(): AppStore {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
