/**
 * Per-file diff assembly for the Diff page (issue DSHA-6).
 *
 * Returns everything the renderer needs to drive a Monaco DiffEditor in
 * inline (unified) mode: the original text (HEAD blob, read-only plumbing),
 * the current worktree text, plus the raw unified diff and binary/truncation
 * flags. No git write operations are involved anywhere.
 */

import fs from 'node:fs';

import type { FileDiffResult } from '../../shared/changes';
import {
  MAX_DIFF_BYTES,
  defaultGitRunner,
  diffForFile,
  headFileBytes,
  isGitWorkTree,
  normalizeRel,
  safeResolve,
  statusEntries,
  type GitRunner
} from './git-readonly';

function fail(path: string, error: string): FileDiffResult {
  return { ok: false, path, error };
}

/** True when the buffer looks binary (NUL byte in the inspected window). */
function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8 * 1024);
  return probe.includes(0);
}

export async function buildFileDiff(
  root: string | null,
  relPathRaw: string,
  run: GitRunner = defaultGitRunner
): Promise<FileDiffResult> {
  if (!root) return fail(String(relPathRaw ?? ''), '没有打开的工作区');
  const path_ = String(relPathRaw ?? '');
  let abs: string;
  try {
    abs = safeResolve(root, path_);
  } catch (err) {
    return fail(path_, err instanceof Error ? err.message : String(err));
  }
  const rel = normalizeRel(path_);

  // Worktree side (modified content). Missing file ⇒ deleted or not yet real.
  let modifiedBuf: Buffer | null = null;
  try {
    modifiedBuf = fs.readFileSync(abs);
  } catch {
    modifiedBuf = null;
  }

  const gitRepo = await isGitWorkTree(root, run);

  // Binary detection first — refuse line rendering for binaries.
  const diffInfo = gitRepo ? await diffForFile(root, rel, run) : null;
  if (diffInfo?.binary) {
    return { ok: true, path: rel, binary: true };
  }
  if (modifiedBuf != null && looksBinary(modifiedBuf)) {
    return { ok: true, path: rel, binary: true };
  }

  // Original side.
  let originalText = '';
  let originalFromHead = false;
  if (gitRepo) {
    const headBytes = await headFileBytes(root, rel, run);
    if (headBytes != null && !looksBinary(headBytes)) {
      originalText = cap(headBytes.toString('utf8')).text;
      originalFromHead = true;
    } else if (headBytes == null) {
      // Untracked / unborn HEAD: the "original" is empty (added file), unless
      // the index holds a staged copy we can present as pre-worktree state.
      try {
        const idx = await run(root, ['show', `:${rel}`]);
        if (idx.code === 0) originalText = cap(idx.stdout).text;
      } catch {
        /* stay '' */
      }
    } else if (looksBinary(headBytes)) {
      return { ok: true, path: rel, binary: true };
    }
  }

  const truncatedParts: boolean[] = [];
  let unified = '';
  if (diffInfo != null) {
    unified = diffInfo.unified;
    truncatedParts.push(diffInfo.truncated);
  }

  const modifiedText =
    modifiedBuf == null ? '' : cap(modifiedBuf.toString('utf8'), truncatedParts).text;

  return {
    ok: true,
    path: rel,
    unified,
    original: originalText,
    modified: modifiedText,
    originalFromHead,
    binary: false,
    truncated: truncatedParts.some(Boolean)
  };
}

function cap(text: string, sink?: boolean[]): { text: string } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= MAX_DIFF_BYTES) return { text };
  sink?.push(true);
  return { text: buf.subarray(0, MAX_DIFF_BYTES).toString('utf8') };
}

/**
 * Which changed paths exist for a root according to git (used by tests and
 * diagnostics; the renderer consumes snapshots instead).
 */
export async function listChangedPaths(root: string, run: GitRunner = defaultGitRunner): Promise<string[]> {
  if (!(await isGitWorkTree(root, run))) return [];
  return (await statusEntries(root, run)).map((e) => e.path);
}
