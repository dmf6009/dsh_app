/**
 * Recent Projects store (§7.2, baseline F2).
 *
 * Desktop-local record of opened projects, persisted as JSON under the DSH
 * desktop state directory (`~/.dsh/desktop/home-state.json`). Ordering rule:
 * pinned entries first, then by most recent open time.
 *
 * Corrupt/missing files degrade to an empty list — Home must always render
 * (§3.3 状态矩阵: 空态 is a first-class state).
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { expandAndNormalize } from './boundary';
import type { RecentProject } from '../../shared/workspace';

export interface RecentProjectsOptions {
  /** Where the JSON state file lives; defaults to `~/.dsh/desktop`. */
  directory?: string;
  now?: () => Date;
  maxEntries?: number;
}

interface StoredState {
  version: 1;
  projects: Array<Omit<RecentProject, 'name'> & { name?: string }>;
}

export class RecentProjectsStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly maxEntries: number;
  private cache: RecentProject[] | null = null;

  constructor(options: RecentProjectsOptions = {}) {
    const dir = options.directory ?? path.join(homedir(), '.dsh', 'desktop');
    this.filePath = path.join(dir, 'home-state.json');
    this.now = options.now ?? (() => new Date());
    this.maxEntries = options.maxEntries ?? 50;
  }

  /** Pinned-first, then most recently opened; a fresh copy each call. */
  list(): RecentProject[] {
    if (this.cache === null) {
      this.cache = this.load();
    }
    return sortProjects(this.cache);
  }

  /**
   * Record an open of `projectPath`: adds it when new, refreshes
   * `lastOpenedAt` otherwise. Returns the up-to-date record.
   */
  addOrTouch(projectPath: string): RecentProject {
    const normalized = expandAndNormalize(projectPath);
    const list = this.list();
    const existing = list.find((p) => samePath(p.path, normalized));
    const stamp = this.now().toISOString();
    let record: RecentProject;
    if (existing) {
      record = { ...existing, lastOpenedAt: stamp };
      this.cache = list.map((p) => (p.id === record.id ? record : p));
    } else {
      record = {
        id: idForPath(normalized),
        name: path.basename(normalized) || normalized,
        path: normalized,
        pinned: false,
        lastOpenedAt: stamp
      };
      this.cache = trim([...list, record], this.maxEntries);
    }
    this.persist(this.cache);
    return record;
  }

  pin(id: string, pinned: boolean): boolean {
    const list = this.list();
    const target = list.find((p) => p.id === id);
    if (!target || target.pinned === pinned) return Boolean(target);
    this.cache = list.map((p) => (p.id === id ? { ...p, pinned } : p));
    this.persist(this.cache);
    return true;
  }

  remove(id: string): boolean {
    const list = this.list();
    if (!list.some((p) => p.id === id)) return false;
    // 移除记录 only drops the Home entry — never touches project files (§7.2).
    this.cache = list.filter((p) => p.id !== id);
    this.persist(this.cache);
    return true;
  }

  /** Test/diagnostic escape hatch: forget everything (file reset too). */
  reset(): void {
    this.cache = [];
    this.persist(this.cache);
  }

  get location(): string {
    return this.filePath;
  }

  private load(): RecentProject[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as StoredState;
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.projects)) {
        return [];
      }
      const projects: RecentProject[] = [];
      for (const entry of parsed.projects) {
        if (
          typeof entry?.id !== 'string' ||
          typeof entry?.path !== 'string' ||
          typeof entry?.lastOpenedAt !== 'string'
        ) {
          continue; // skip malformed rows instead of failing the whole list
        }
        projects.push({
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : path.basename(entry.path),
          path: entry.path,
          pinned: entry.pinned === true,
          lastOpenedAt: entry.lastOpenedAt
        });
      }
      return projects;
    } catch {
      // 损坏文件容错：JSON parse failure → empty state, never throw.
      return [];
    }
  }

  private persist(list: RecentProject[]): void {
    const payload: StoredState = {
      version: 1,
      projects: list.map((p) => ({ ...p }))
    };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  /** Async no-op kept for symmetry with async callers in IPC handlers. */
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Enforce the list budget without ever evicting pinned entries: unpinned
 * records are dropped oldest-first.
 */
function trim(list: RecentProject[], maxEntries: number): RecentProject[] {
  if (list.length <= maxEntries) return list;
  const droppable = list
    .filter((p) => !p.pinned)
    .sort((a, b) => a.lastOpenedAt.localeCompare(b.lastOpenedAt))
    .slice(0, list.length - maxEntries)
    .map((p) => p.id);
  return list.filter((p) => !droppable.includes(p.id));
}

/** Stable id: hash-free but collision-safe within one machine's home dir. */
export function idForPath(normalizedPath: string): string {
  return Buffer.from(normalizedPath, 'utf8').toString('base64url');
}

function samePath(a: string, b: string): boolean {
  return a === b;
}

export function sortProjects(list: RecentProject[]): RecentProject[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // Pin 置顶优先
    return b.lastOpenedAt.localeCompare(a.lastOpenedAt); // 最近打开倒序
  });
}
