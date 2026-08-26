/**
 * Read-only git data source (issue DSHA-6, F3 / §23).
 *
 * Baseline ruling: the desktop never performs git WRITE operations. Every
 * command in this module is a read-only porcelain/plumbing invocation, and
 * `runGit` enforces that with a hard subcommand whitelist — anything outside
 * {rev-parse, status, diff, ls-files, show} throws before spawn.
 *
 * Provided data:
 *   - current branch (incl. detached-HEAD reporting)
 *   - `git status --porcelain=v1 -z` parsing → A/M/D per file
 *   - unified diff per file (`git diff HEAD -- <path>`), with binary
 *     detection via --numstat and synthesized add-only diffs for untracked
 *   - raw blob content from HEAD (`git show HEAD:<path>`) used by the Diff
 *     page (original side) and by Revert-file restoration (S-5)
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { ChangeKind } from '../../shared/changes';
import { guardRead } from './boundary';

/** Hard ceiling for diff text handed to the renderer (bytes). */
export const MAX_DIFF_BYTES = 16 * 1024 * 1024;

/** Ceiling for one synthesized untracked-file diff body (bytes). */
const MAX_SYNTH_DIFF_BYTES = MAX_DIFF_BYTES;

/**
 * The only git subcommands this module may ever run. Anything else is a
 * programming error — fail loudly instead of mutating a user repository.
 */
const READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'rev-parse',
  'status',
  'diff',
  'ls-files',
  'show',
  'symbolic-ref'
]);

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Byte-exact stdout (used by blob reads so revert restores exact bytes). */
  stdoutBytes?: Buffer;
}

export type GitRunner = (
  root: string,
  args: readonly string[],
  options?: { maxBufferBytes?: number }
) => Promise<GitRunResult>;

/** Default runner: execFile, no shell, argv array only, generous timeout. */
export const defaultGitRunner: GitRunner = (root, args, options) =>
  new Promise<GitRunResult>((resolve, reject) => {
    assertReadonlyArgs(args);
    execFile(
      'git',
      [...args],
      {
        cwd: root,
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: options?.maxBufferBytes ?? 64 * 1024 * 1024,
        encoding: 'buffer' as BufferEncoding
      },
      (err, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''));
        const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ''));
        if (err != null && typeof (err as NodeJS.ErrnoException).code !== 'number') {
          // Spawn-level failure (git missing, cwd gone) — surface it.
          reject(new Error(`git 不可用：${(err as Error).message}`));
          return;
        }
        resolve({
          code: err != null ? Number((err as NodeJS.ErrnoException).code ?? 1) : 0,
          stdout: out.toString('utf8'),
          stderr: errBuf.toString('utf8'),
          stdoutBytes: out
        });
      }
    );
  });

/** Throws unless every argument stays inside the read-only whitelist. */
export function assertReadonlyArgs(args: readonly string[]): void {
  const sub = args[0];
  if (typeof sub !== 'string' || !READONLY_SUBCOMMANDS.has(sub)) {
    throw new Error(`拒绝执行非只读 git 命令：${String(sub)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

/**
 * Resolve a workspace-relative path against `root`, rejecting anything that
 * escapes the workspace (absolute paths pointing elsewhere, `..` climbs,
 * drive letters). Returns the absolute path on success.
 */
export function safeResolve(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('路径无效');
  }
  if (path.isAbsolute(relPath) && !relPath.startsWith(root)) {
    throw new Error('拒绝访问工作区之外的路径');
  }
  if (/^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new Error('拒绝访问工作区之外的路径');
  }
  const abs = path.resolve(root, relPath);
  const rootAbs = path.resolve(root);
  const relFromRoot = path.relative(rootAbs, abs);
  if (relFromRoot === '' || relFromRoot === '..' || relFromRoot.startsWith(`..${path.sep}`)) {
    throw new Error('拒绝访问工作区之外的路径');
  }
  return abs;
}

/* ------------------------------------------------------------------ */
/* Repository facts                                                    */
/* ------------------------------------------------------------------ */

export async function isGitWorkTree(root: string, run: GitRunner = defaultGitRunner): Promise<boolean> {
  try {
    const res = await run(root, ['rev-parse', '--is-inside-work-tree']);
    return res.code === 0 && res.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export interface BranchInfo {
  /** Branch name, or short SHA when detached; null outside a work tree. */
  branch: string | null;
  detached: boolean;
}

export async function currentBranch(root: string, run: GitRunner = defaultGitRunner): Promise<BranchInfo> {
  if (!(await isGitWorkTree(root, run))) return { branch: null, detached: false };
  const verify = await run(root, ['rev-parse', '--verify', 'HEAD']);
  if (verify.code !== 0) {
    // Unborn branch (fresh repo, no commits yet): HEAD still names the
    // branch via its symbolic ref — report it instead of hiding the pill.
    const sym = await run(root, ['symbolic-ref', '--short', 'HEAD']);
    if (sym.code === 0 && sym.stdout.trim() !== '') {
      return { branch: sym.stdout.trim(), detached: false };
    }
    return { branch: null, detached: false };
  }
  const res = await run(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = res.stdout.trim();
  if (res.code !== 0 || name === '') return { branch: null, detached: false };
  if (name !== 'HEAD') return { branch: name, detached: false };
  // Detached HEAD: abbrev-ref prints literally "HEAD" — report the SHA.
  const sha = await run(root, ['rev-parse', '--short', 'HEAD']);
  return { branch: sha.code === 0 ? sha.stdout.trim() : null, detached: true };
}

/** True when the repo has at least one commit (HEAD resolves). */
export async function hasHead(root: string, run: GitRunner = defaultGitRunner): Promise<boolean> {
  try {
    const res = await run(root, ['rev-parse', '--verify', 'HEAD']);
    return res.code === 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Status (name-status reconciliation source)                          */
/* ------------------------------------------------------------------ */

export interface StatusEntry {
  path: string;
  kind: ChangeKind;
  /** Two-letter porcelain code, kept for diagnostics/tests. */
  code: string;
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * Mapping (worktree column wins so the UI reflects what is on disk):
 *   D (either column) → deleted · A (either column) / "??" → added ·
 *   M / R / C / T → modified.
 */
export function parseStatusZ(stdout: string): StatusEntry[] {
  const parts = stdout.split('\u0000');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const raw = parts[i]!;
    if (raw === '') continue;
    // Format: `XY<space>PATH`; rename/copy adds `\0ORIGINAL` right after.
    const match = /^(.{2}) (.*)$/s.exec(raw);
    if (!match) continue;
    const code = match[1]!;
    const filePath = match[2]!;
    const x = code[0]!;
    const y = code[1]!;
    if (x === '?' || y === '?') {
      if (x === '?' && y === '?') {
        entries.push({ path: normalizeRel(filePath), kind: 'added', code });
      }
      continue;
    }
    if (x === '!' || y === '!') continue; // ignored files are not changes
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      // -z renames carry the ORIGINAL path in the next slot; the displayed
      // path is the destination. MVP maps renames/copies to "modified".
      i += 1; // skip original path slot
      entries.push({ path: normalizeRel(filePath), kind: 'modified', code });
      continue;
    }
    entries.push({ path: normalizeRel(filePath), kind: kindOfXY(x, y), code });
  }
  return entries;
}

function kindOfXY(x: string, y: string): ChangeKind {
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A') return 'added';
  return 'modified';
}

/** `/`-separated, no leading `./`, platform-independent display form. */
export function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export async function statusEntries(root: string, run: GitRunner = defaultGitRunner): Promise<StatusEntry[]> {
  try {
    const res = await run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (res.code !== 0) return [];
    return parseStatusZ(res.stdout);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Per-file unified diff                                               */
/* ------------------------------------------------------------------ */

export interface UnifiedDiffResult {
  unified: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * Unified diff of one file against HEAD.
 *
 * - tracked & changed → `git diff HEAD -- <path>` (index+worktree vs HEAD)
 * - untracked         → synthesized add-only diff built from disk content
 * - clean             → empty unified text
 */
export async function diffForFile(
  root: string,
  relPath: string,
  run: GitRunner = defaultGitRunner
): Promise<UnifiedDiffResult | null> {
  if (!(await hasHead(root, run))) {
    return synthesizeAddDiff(root, relPath);
  }
  const numstat = await run(root, [
    'diff',
    'HEAD',
    '--numstat',
    '--no-color',
    '--',
    relPath
  ]);
  if (numstat.code !== 0) return null;
  if (/^-\t-\t/.test(numstat.stdout)) {
    return { unified: '', truncated: false, binary: true };
  }
  const diff = await run(root, [
    'diff',
    'HEAD',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--',
    relPath
  ]);
  if (diff.code !== 0) return null;
  if (diff.stdout.trim() !== '') {
    return capDiff(diff.stdout);
  }
  // Empty output: either clean-tracked or untracked (diff HEAD skips them).
  const tracked = await run(root, ['ls-files', '--error-unmatch', '--', relPath]);
  if (tracked.code === 0) {
    return { unified: '', truncated: false, binary: false };
  }
  return synthesizeAddDiff(root, relPath);
}

function capDiff(text: string): UnifiedDiffResult {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= MAX_DIFF_BYTES) {
    return { unified: text, truncated: false, binary: false };
  }
  return { unified: buf.subarray(0, MAX_DIFF_BYTES).toString('utf8'), truncated: true, binary: false };
}

/** Build an add-only unified diff for an untracked (or HEAD-less) file. */
async function synthesizeAddDiff(
  root: string,
  relPath: string,
  _run: GitRunner = defaultGitRunner
): Promise<UnifiedDiffResult | null> {
  const abs = safeResolve(root, relPath);
  // Canonical boundary check (P0/QA-adjacent): untracked add-diff synthesis
  // must never read through a file/dir symlink to outside the workspace.
  // Fail closed — an out-of-bound target yields an empty (safe) unified diff,
  // never leaked bytes.
  try {
    await guardRead(root, abs);
  } catch {
    return { unified: '', truncated: false, binary: false };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { unified: '', truncated: false, binary: false };
  }
  if (stat.isDirectory()) {
    return { unified: '', truncated: false, binary: false };
  }
  let content: Buffer;
  try {
    content = fs.readFileSync(abs);
  } catch {
    return { unified: '', truncated: false, binary: false };
  }
  if (content.includes(0)) {
    return { unified: '', truncated: false, binary: true };
  }
  const lines = content.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const rel = normalizeRel(relPath);
  // A real @@ hunk header keeps the synthesized diff parseable by the
  // renderer's unified parser and consistent with git's add-only output.
  const header =
    `diff --git a/${rel} b/${rel}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${rel}\n` +
    `@@ -0,0 +1,${lines.length} @@\n`;
  const bodySize = lines.reduce((acc, l) => acc + l.length + 2, 0);
  if (header.length + bodySize > MAX_SYNTH_DIFF_BYTES) {
    const budget = MAX_SYNTH_DIFF_BYTES - header.length;
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      const cost = line.length + 2;
      if (used + cost > budget) break;
      kept.push(line);
      used += cost;
    }
    return {
      unified: header + kept.map((l) => `+${l}`).join('\n') + '\n',
      truncated: true,
      binary: false
    };
  }
  return { unified: header + lines.map((l) => `+${l}`).join('\n') + '\n', truncated: false, binary: false };
}

/* ------------------------------------------------------------------ */
/* HEAD blob access                                                    */
/* ------------------------------------------------------------------ */

/**
 * Raw bytes of `<path>` at HEAD, or null when HEAD lacks the file.
 * Used for the Diff page's original side and S-5 revert restoration.
 */
export async function headFileBytes(
  root: string,
  relPath: string,
  run: GitRunner = defaultGitRunner
): Promise<Buffer | null> {
  try {
    const res = await run(root, ['show', `HEAD:${normalizeRel(relPath)}`], {
      maxBufferBytes: MAX_DIFF_BYTES + 1024 * 1024
    });
    if (res.code !== 0) return null;
    return res.stdoutBytes ?? Buffer.from(res.stdout, 'utf8');
  } catch {
    return null;
  }
}
