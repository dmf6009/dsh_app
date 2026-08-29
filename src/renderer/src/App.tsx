/**
 * App shell (§30/§37): global top bar with page navigation + Settings entry,
 * and the keep-alive four-page router — every page stays mounted and is
 * hidden via the `hidden` attribute so in-page state survives navigation.
 */

import type { ReactElement } from 'react';

import { ROUTE_TITLES, useApp, type Route } from './store/app-store';
import { ChangesProvider } from './changes/changes-store';
import HomePage from './pages/HomePage';
import WorkspacePage from './pages/WorkspacePage';
import DiffPage from './pages/DiffPage';
import SettingsPage from './pages/SettingsPage';

const CONNECTION_LABELS: Record<string, string> = {
  stopped: '未启动',
  starting: '启动中…',
  ready: '已就绪',
  crashed: '已崩溃'
};

const NAV_ROUTES: readonly Route[] = ['home', 'workspace', 'diff'];

export default function App(): ReactElement {
  const { state, dispatch } = useApp();

  const navigate = (route: Route): void => dispatch({ type: 'navigate', route });

  return (
    <div className="app">
      <header className="topbar">
        <span className="title">DSH Desktop</span>

        <nav className="nav" aria-label="主导航">
          {NAV_ROUTES.map((route) => (
            <button
              key={route}
              type="button"
              className={`nav-btn${state.route === route ? ' nav-active' : ''}`}
              aria-current={state.route === route ? 'page' : undefined}
              onClick={() => navigate(route)}
            >
              {ROUTE_TITLES[route]}
            </button>
          ))}
        </nav>

        <span className={`conn-pill conn-${state.connection}`}>
          Runtime: {CONNECTION_LABELS[state.connection] ?? state.connection}
        </span>
        <span className="cmdline" title={state.commandLine}>
          {state.commandLine}
        </span>

        {/* 全局设置入口：任何页面都可进入，返回原页面（§37） */}
        <button
          type="button"
          className={`gear-btn${state.route === 'settings' ? ' nav-active' : ''}`}
          aria-label="打开 Settings"
          title="Settings（模型 / DSH / 权限 / 插件）"
          onClick={() =>
            state.route === 'settings'
              ? dispatch({ type: 'close-settings' })
              : dispatch({ type: 'open-settings' })
          }
        >
          <span aria-hidden="true">⚙</span> 设置
        </button>
      </header>

      {/* Keep-alive pages: mounted once, toggled with `hidden`. */}
      <main className="page-host">
        <ChangesProvider>
        {state.flash && state.route !== 'settings' && (
          // Confirmation handed over by Settings on save-and-return (§37): shown
          // on the originating page, dismissible, and cleared by any navigation.
          <div className="flash" role="status">
            <span>{state.flash}</span>
            <button
              type="button"
              className="flash-close"
              aria-label="关闭提示"
              onClick={() => dispatch({ type: 'dismiss-flash' })}
            >
              ×
            </button>
          </div>
        )}
        <div hidden={state.route !== 'home'}>
          <HomePage />
        </div>
        <div hidden={state.route !== 'workspace'}>
          <WorkspacePage />
        </div>
        <div hidden={state.route !== 'diff'}>
          <DiffPage />
        </div>
        <div hidden={state.route !== 'settings'}>
          <SettingsPage />
        </div>
        </ChangesProvider>
      </main>
    </div>
  );
}
