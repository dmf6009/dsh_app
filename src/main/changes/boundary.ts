/**
 * Canonical workspace-boundary guard for the Changes/Diff layer (issue DSHA-6,
 * P0 review fix).
 *
 * `safeResolve` in git-readonly is purely lexical — it cannot see symlinks.
 * A repository-controlled path swapped to a link pointing outside the
 * workspace would let the Diff page read external content and Revert overwrite
 * an external target. This module reuses the shared `WorkspaceBoundary`
 * authority (realpath + nearest-existing-ancestor resolution + real-root
 * containment) so every filesystem touch here is verified against the REAL
 * location of the file, not its visible spelling.
 *
 * TOCTOU stance: true atomicity (O_NOFOLLOW / openat) is not exposed by Node's
 * fs API, so we mitigate by (a) canonical check immediately before each
 * operation and (b) a post-write re-check that catches a between-check-and-use
 * parent swap and fails closed (removing any artifact that landed outside).
 * File-level symlinks are refused outright for write/delete regardless of where
 * they point, since operating "through" a link is never intended here.
 */

import fs from 'node:fs';

import { WorkspaceBoundary } from '../workspace/boundary';

/**
 * Resolve and verify that `absPath` really lives under the workspace `root`,
 * following symlinks to the canonical location. Throws when the real location
 * escapes the root (or cannot be verified / root missing). Returns the
 * canonical resolved path on success.
 */
export async function assertInsideWorkspace(root: string, absPath: string): Promise<string> {
  const boundary = new WorkspaceBoundary(root);
  const check = await boundary.check(absPath);
  if (!check.allowed) {
    throw new Error(check.reason ?? '目标路径越出工作区边界');
  }
  return check.resolvedPath;
}

/**
 * Guard a read: verify the canonical location is inside the workspace. Reading
 * through an in-workspace symlink is permitted (the bytes it reaches are in the
 * workspace); anything resolving outside is rejected.
 */
export async function guardRead(root: string, absPath: string): Promise<void> {
  await assertInsideWorkspace(root, absPath);
}

/**
 * Guard a write/delete: canonical containment PLUS refusal to operate through a
 * file-level symlink (fail closed even for in-workspace links).
 */
export async function guardWrite(root: string, absPath: string): Promise<void> {
  await assertInsideWorkspace(root, absPath);
  try {
    if (fs.lstatSync(absPath).isSymbolicLink()) {
      throw new Error('拒绝通过符号链接执行写入/删除操作');
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return; // not-yet-created target is fine
    throw err;
  }
}

/**
 * Post-write re-verification: confirm the target still resolves inside the
 * workspace after the write. Catches a parent directory swapped to an
 * escaping symlink between the pre-check and the write. On failure, removes
 * the artifact (best effort) so nothing hostile is left behind, and throws.
 */
export async function verifyAfterWrite(root: string, absPath: string): Promise<void> {
  try {
    await assertInsideWorkspace(root, absPath);
  } catch (err) {
    try {
      fs.rmSync(absPath, { force: true });
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}
