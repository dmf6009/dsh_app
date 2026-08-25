/**
 * Workspace Manager (§30) — Phase 0 placeholder.
 *
 * The full MVP implementation (open project, recent projects, workspace
 * boundary enforcement per §7) is dispatched as a separate issue. This module
 * only pins the module location in the main-process layout and provides the
 * one thing the prototype needs: a validated default workspace path that is
 * sent with every `run` command.
 */

import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_WORKSPACE = process.env.DSH_WORKSPACE ?? homedir();

export interface WorkspaceInfo {
  /** Absolute path of the workspace root. */
  root: string;
}

export function resolveWorkspace(input?: string | null): WorkspaceInfo {
  if (!input || input.trim() === '') {
    return { root: path.resolve(DEFAULT_WORKSPACE) };
  }
  const expanded = input.startsWith('~') ? path.join(homedir(), input.slice(1)) : input;
  return { root: path.resolve(expanded) };
}
