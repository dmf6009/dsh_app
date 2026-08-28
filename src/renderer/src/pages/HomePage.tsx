/**
 * Home page (§37): DSH detection banner, Open Project entry and Recent
 * Projects records with pin/remove persistence.
 */

import { useCallback, useEffect, useState } from 'react';

import type { PathCheckResult } from '../../../shared/workspace';
import { dshNotFoundCopy } from '../../../shared/error-copy';
import { Badge, Banner, Button, Card } from '../components/ui';
import { useApp } from '../store/app-store';

/** Per-card staleness info resolved once on mount / after mutations. */
interface StaleInfo {
  exists: boolean;
  accessible: boolean;
}

export default function HomePage(): JSX.Element {
  const { state, dispatch } = useApp();
  const [stale, setStale] = useState<Record<string, StaleInfo>>({});
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshRecent = useCallback(async (): Promise<void> => {
    const projects = await window.desktop.listRecentProjects();
    dispatch({ type: 'recent', projects });
    const nextStale: Record<string, StaleInfo> = {};
    await Promise.all(
      projects.map(async (project) => {
        const check: PathCheckResult = await window.desktop.checkPath(project.path);
        nextStale[project.id] = { exists: check.exists && check.isDirectory, accessible: check.accessible };
      })
    );
    setStale(nextStale);
  }, [dispatch]);

  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  /* ---- §38 banner state machine ---------------------------------- */

  const detection = state.dsh;
  let bannerTone: 'info' | 'success' | 'error';
  let bannerTitle: string;
  let bannerText: string;
  /** §32 three-part copy for the not-found scenario; built when applicable. */
  let bannerCopy: { why: string; action: string } | null = null;

  if (state.connection === 'starting') {
    bannerTone = 'info';
    bannerTitle = 'DSH 启动中…';
    bannerText = '正在拉起 Runtime，请稍候。';
  } else if (detection?.found && state.connection === 'ready') {
    bannerTone = 'success';
    bannerTitle = 'DSH 已就绪';
    bannerText = [
      detection.path ? `路径：${detection.path}` : null,
      detection.version ? `版本：${detection.version}` : null
    ]
      .filter(Boolean)
      .join('　·　');
  } else {
    bannerTone = 'error';
    const copy = dshNotFoundCopy(detection?.reason);
    bannerTitle = copy.what;
    bannerText = `${copy.why}`;
    bannerCopy = { why: copy.why, action: copy.action };
  }

  /* ---- actions ---------------------------------------------------- */

  const openProject = async (): Promise<void> => {
    setError(null);
    setOpening(true);
    try {
      const result = await window.desktop.openProject();
      if (result.ok && result.path) {
        dispatch({ type: 'workspace', path: result.path });
        await refreshRecent();
        dispatch({ type: 'navigate', route: 'workspace' });
      } else if (result.error !== 'cancelled') {
        setError(result.error ?? '打开项目失败');
      }
    } finally {
      setOpening(false);
    }
  };

  const openRecent = async (path: string, id: string): Promise<void> => {
    const info = stale[id];
    if (info && (!info.exists || !info.accessible)) return; // disabled row (§3.3)
    setError(null);
    const result = await window.desktop.openProjectAt(path);
    if (result.ok && result.path) {
      dispatch({ type: 'workspace', path: result.path });
      await refreshRecent();
      dispatch({ type: 'navigate', route: 'workspace' });
    } else {
      setError(result.error ?? '打开项目失败');
      void refreshRecent();
    }
  };

  const togglePin = async (id: string, pinned: boolean): Promise<void> => {
    await window.desktop.pinRecentProject(id, pinned);
    await refreshRecent();
  };

  const removeRecord = async (id: string): Promise<void> => {
    await window.desktop.removeRecentProject(id);
    await refreshRecent();
  };

  const chooseDshPath = async (): Promise<void> => {
    const result = await window.desktop.chooseDshPath();
    if (result.ok) {
      const detection = await window.desktop.detectDsh();
      dispatch({ type: 'dsh', detection });
    }
  };

  return (
    <div className="page page-home">
      <Banner
        tone={bannerTone}
        title={bannerTitle}
        actions={
          bannerTone === 'error' ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => void chooseDshPath()}>
                Choose DSH Path
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setError(
                    '请参考 DSH 官方文档安装 dsh CLI（确保 dsh 在 PATH 中），或点击 Choose DSH Path 指定已安装路径。'
                  )
                }
              >
                Install…
              </Button>
            </>
          ) : undefined
        }
      >
        <p className="banner-why">{bannerText}</p>
        {bannerCopy && <p className="banner-action">{bannerCopy.action}</p>}
      </Banner>

      <section className="home-actions">
        <Button variant="primary" loading={opening} onClick={() => void openProject()}>
          打开项目…
        </Button>
        <span className="hint">选择一个目录作为 Workspace；Agent 的所有读写都限制在该目录内。</span>
      </section>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <section className="recent">
        <h2 className="section-title">Recent Projects</h2>
        {state.recent.length === 0 ? (
          <p className="empty-hint">暂无最近项目——通过「打开项目…」添加第一个 Workspace。</p>
        ) : (
          <div className="card-grid">
            {state.recent.map((project) => {
              const info = stale[project.id];
              const isStale = Boolean(info && (!info.exists || !info.accessible));
              return (
                <Card
                  key={project.id}
                  dimmed={isStale}
                  title={
                    <span className="recent-name">
                      {project.pinned && (
                        <span className="pin-flag" title="已置顶" aria-label="已置顶">
                          ★
                        </span>
                      )}
                      {project.name}
                    </span>
                  }
                  meta={<span title={project.path}>{project.path}</span>}
                  actions={
                    <>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={isStale}
                        onClick={() => void openRecent(project.path, project.id)}
                      >
                        打开
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={project.pinned}
                        onClick={() => void togglePin(project.id, !project.pinned)}
                      >
                        {project.pinned ? '取消置顶' : '置顶'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void removeRecord(project.id)}>
                        移除记录
                      </Button>
                    </>
                  }
                >
                  {isStale ? (
                    <Badge tone="warning">目录不可访问 — 仅可移除记录</Badge>
                  ) : (
                    <span className="recent-time">上次打开：{new Date(project.lastOpenedAt).toLocaleString()}</span>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
