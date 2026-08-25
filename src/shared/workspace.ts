/**
 * Workspace / recent-projects types shared between main and renderer (§7, §37).
 */

/** One Recent Projects entry as shown on Home. */
export interface RecentProject {
  /** Stable id derived from the absolute path. */
  id: string;
  /** Display name = directory basename. */
  name: string;
  /** Absolute path of the project root. */
  path: string;
  pinned: boolean;
  /** ISO timestamp of the last time the project was opened. */
  lastOpenedAt: string;
}

export interface OpenProjectResult {
  ok: boolean;
  /** Chosen/validated absolute path; present when ok. */
  path?: string;
  /** `cancelled` when the user dismissed the directory picker. */
  error?: 'cancelled' | 'not_a_directory' | 'unreadable' | string;
}

export interface PathCheckResult {
  exists: boolean;
  isDirectory: boolean;
  accessible: boolean;
}
