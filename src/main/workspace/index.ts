/**
 * Workspace Manager (§30) — owns the active workspace (§7.1), Recent Projects
 * records (§7.2) and the per-workspace boundary service (§7.3/§35).
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { expandAndNormalize, WorkspaceBoundary } from './boundary';
import { RecentProjectsStore } from './recent-projects';
import type { OpenProjectResult, PathCheckResult, RecentProject } from '../../shared/workspace';

export interface WorkspaceManagerOptions {
  recent?: RecentProjectsStore;
  home?: string;
  /** Opens a native directory picker; resolves null when cancelled. */
  selectDirectory?: () => Promise<string | null>;
}

export class WorkspaceManager {
  private readonly recent: RecentProjectsStore;
  private readonly home: string;
  private readonly selectDirectory: () => Promise<string | null>;
  private activeRoot: string | null = null;
  private activeBoundary: WorkspaceBoundary | null = null;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.home = options.home ?? homedir();
    this.recent =
      options.recent ??
      new RecentProjectsStore({
        directory: path.join(this.home, '.dsh', 'desktop')
      });
    this.selectDirectory =
      options.selectDirectory ??
      (() => Promise.resolve(null));
  }

  /* ---- §7.1 打开项目 ---- */

  /** Native picker flow: cancel → `{ok:false,error:'cancelled'}` (§3.3 disabled row). */
  async openViaDialog(): Promise<OpenProjectResult> {
    let chosen: string | null;
    try {
      chosen = await this.selectDirectory();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!chosen) return { ok: false, error: 'cancelled' };
    return this.openAt(chosen);
  }

  /** Create a workspace at an explicit path (used by tests and IPC). */
  openAt(projectPath: string): OpenProjectResult {
    const normalized = expandAndNormalize(projectPath, this.home);
    const check = this.checkPath(normalized);
    if (!check.exists) return { ok: false, error: '目录不存在' };
    if (!check.isDirectory) return { ok: false, error: '所选路径不是目录' };
    if (!check.accessible) return { ok: false, error: '目录不可访问（权限不足）' };

    this.activate(normalized);
    this.recent.addOrTouch(normalized);
    return { ok: true, path: normalized };
  }

  /* ---- Active workspace ---- */

  activate(rootPath: string): void {
    this.activeRoot = expandAndNormalize(rootPath, this.home);
    this.activeBoundary = new WorkspaceBoundary(this.activeRoot, { home: this.home });
  }

  get currentRoot(): string | null {
    return this.activeRoot;
  }

  /**
   * Root sent with every `run` command. Falls back to the Phase-0 behaviour
   * (DSH_WORKSPACE / home) when no project is open yet.
   */
  fallbackRoot(): string {
    if (this.activeRoot) return this.activeRoot;
    const env = process.env.DSH_WORKSPACE;
    return expandAndNormalize(env && env.trim() !== '' ? env : this.home, this.home);
  }

  /** Boundary for the active workspace (creates one on demand). */
  boundary(): WorkspaceBoundary {
    if (!this.activeBoundary) {
      this.activate(this.fallbackRoot());
    }
    return this.activeBoundary!;
  }

  /* ---- §7.2 Recent Projects ---- */

  listRecent(): RecentProject[] {
    return this.recent.list();
  }

  pinRecent(id: string, pinned: boolean): boolean {
    return this.recent.pin(id, pinned);
  }

  removeRecent(id: string): boolean {
    return this.recent.remove(id);
  }

  /** Marks stale cards on Home (目录不可访问 → 只保留移除记录). */
  checkPath(target: string): PathCheckResult {
    const result: PathCheckResult = { exists: false, isDirectory: false, accessible: false };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(expandAndNormalize(target, this.home));
    } catch (err) {
      return {
        ...result,
        exists: (err as NodeJS.ErrnoException).code !== 'ENOENT',
        accessible: false
      };
    }
    result.exists = true;
    result.isDirectory = stat.isDirectory();
    result.accessible = result.isDirectory;
    if (result.isDirectory) {
      try {
        fs.accessSync(expandAndNormalize(target, this.home), fs.constants.R_OK);
      } catch {
        result.accessible = false;
      }
    }
    return result;
  }
}
