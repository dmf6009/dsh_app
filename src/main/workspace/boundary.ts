/**
 * Workspace Boundary service (§7.3, §35, baseline F2/S-4).
 *
 * One shared authority for "is this path inside the active workspace?" — to be
 * reused by Approval flows and file operations in later issues. Pure path
 * logic lives here; filesystem effects are injected so the rules stay
 * unit-testable.
 *
 * Layers of the check:
 *   1. lexical normalization (`..`, `~`, redundant separators, absolute paths)
 *   2. containment decision against the workspace root
 *   3. symlink escape checkpoint (§35): real-path resolution of the target and
 *      its nearest existing ancestor. The check is wired and enforced here,
 *      with the resolver injectable for tests.
 *   4. explicit user authorization grants for out-of-workspace access
 *
 * Containment authority: when real paths resolve, the REAL root decides both
 * ways — a path is inside iff its real location sits under `realpath(root)`.
 * The lexical comparison only classifies the failure (`lexical` vs `symlink`)
 * for the message the user sees. Grants are a separate concern and are keyed on
 * the exact path the user authorized, never on a folded form.
 */

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Expand a leading `~` and collapse the path to an absolute normalized form. */
export function expandAndNormalize(input: string, home: string = homedir()): string {
  let candidate = input.trim();
  if (candidate === '') return candidate;
  if (candidate === '~') return home;
  if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = path.join(home, candidate.slice(2));
  }
  return path.normalize(path.resolve(candidate));
}

export type Containment = 'inside' | 'outside';

/**
 * Lexical containment of `target` under `root`. Both paths must already be
 * absolute and normalized (use {@link expandAndNormalize}).
 */
export function contain(root: string, target: string): Containment {
  const rel = path.relative(root, target);
  if (rel === '') return 'inside';
  if (rel.startsWith('..') && (rel.length === 2 || rel.startsWith(`..${path.sep}`))) {
    return 'outside';
  }
  if (path.isAbsolute(rel)) return 'outside';
  return 'inside';
}

/**
 * Why a path is not accessible.
 *
 * `lexical` and `symlink` are authorizable out-of-boundary accesses
 * (`needsAuthorization: true`). `root_missing` and `unverifiable` are hard
 * errors the user cannot grant their way past (`needsAuthorization: false`).
 */
export type EscapeKind = 'none' | 'lexical' | 'symlink' | 'root_missing' | 'unverifiable';

/**
 * Key under which one authorization grant is stored.
 *
 * Exact, case-preserving match on the normalized absolute path. This is the one
 * place the key policy lives, so `grant`/`revoke`/`hasGrant` can never drift
 * apart. Deliberately NOT case-folded: see {@link WorkspaceBoundary.grant}.
 */
function grantKey(normalizedPath: string): string {
  return normalizedPath;
}

/** True when a filesystem error means "this path component does not exist". */
function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * A path whose real location cannot be established: some component exists but
 * refuses to resolve (permission wall, symlink cycle). Distinct from a path
 * that simply does not exist yet, which is safe to resolve lexically.
 */
class UnverifiablePathError extends Error {
  constructor(target: string, readonly reasonError?: unknown) {
    super(`cannot verify the real path of ${target}`);
    this.name = 'UnverifiablePathError';
  }
}

/** Why a path is not accessible inside the workspace. */
export interface BoundaryCheck {
  allowed: boolean;
  /** Present when `allowed === false`. */
  reason?: string;
  /**
   * True when the failure is an out-of-boundary access that the user may
   * explicitly authorize (§7.3). Distinguishable from hard errors.
   */
  needsAuthorization?: boolean;
  escape?: EscapeKind;
  /** The fully resolved absolute target path. */
  resolvedPath: string;
}

export interface WorkspaceBoundaryOptions {
  home?: string;
  /**
   * Resolves the real path of a filesystem location, following symlinks.
   * Defaults to `fs.promises.realpath`; tests may inject a fake.
   */
  realpath?: (p: string) => Promise<string>;
  /** Returns true when the given absolute path currently exists. */
  exists?: (p: string) => boolean;
}

/**
 * Mutable boundary state bound to one workspace root, with explicit
 * authorization grants (§7.3 "除非用户明确授权").
 */
export class WorkspaceBoundary {
  private readonly root: string;
  private readonly home: string;
  private readonly realpath: (p: string) => Promise<string>;
  private readonly exists: (p: string) => boolean;
  private readonly grants = new Map<string, { path: string; grantedAt: string }>();

  constructor(root: string, options: WorkspaceBoundaryOptions = {}) {
    this.root = expandAndNormalize(root, options.home);
    this.home = options.home ?? homedir();
    this.realpath = options.realpath ?? ((p) => fs.promises.realpath(p));
    this.exists =
      options.exists ??
      ((p) => {
        try {
          fs.statSync(p);
          return true;
        } catch {
          return false;
        }
      });
  }

  get rootPath(): string {
    return this.root;
  }

  /**
   * Full check for a user/tool supplied target. Never throws: unreadable
   * paths surface as `allowed: false` with a reason.
   */
  async check(target: string): Promise<BoundaryCheck> {
    const resolvedPath = expandAndNormalize(target, this.home);
    if (resolvedPath === '') {
      return { allowed: false, reason: '路径为空', resolvedPath };
    }
    // A missing workspace root cannot contain anything — surface it as a hard
    // error rather than pretending containment.
    if (!this.exists(this.root)) {
      return {
        allowed: false,
        reason: 'Workspace 根目录不存在或不可访问',
        escape: 'root_missing',
        needsAuthorization: false,
        resolvedPath
      };
    }
    const inputOutsideLexical = contain(this.root, resolvedPath) === 'outside';

    // Symlink escape checkpoint (§35): resolve what the path really points at.
    // The target itself or any of its ancestors may be a symlink leaving the
    // workspace; resolving through the nearest existing ancestor covers
    // not-yet-created targets behind symlinks too.
    let realTarget: string;
    let realRoot: string;
    try {
      realTarget = await this.resolveReal(resolvedPath);
      realRoot = await this.realpath(this.root);
    } catch {
      // The target's real location cannot be established: some component exists
      // but refuses to resolve (permission wall, symlink cycle), or the root
      // itself stopped resolving. Being lexically inside the root proves nothing
      // here — an unreadable component may be a link pointing out of the
      // workspace. Refuse, and refuse as a HARD error: `needsAuthorization:
      // false` keeps this off the grant path, so an ordinary outside-path grant
      // can never launder an unverifiable path into a verified-safe one.
      //
      // Targets that merely do not exist yet never reach here — those resolve
      // through their nearest existing ancestor (see `resolveReal`), so creating
      // new files inside the workspace keeps working.
      return {
        allowed: false,
        reason: '无法验证目标路径的真实位置',
        escape: 'unverifiable',
        needsAuthorization: false,
        resolvedPath
      };
    }

    // The REAL root is the single authority, in BOTH directions (QA-1/QA-2).
    //   allow side: a workspace opened through a symlinked path (macOS
    //     `/tmp`→`/private/tmp`, symlinked home or project layouts) has a
    //     visible root that differs from its real location. Either spelling of
    //     an in-root file — the linked one or its real canonical one — names
    //     the same bytes inside the workspace, so both are allowed. Deciding
    //     the allow side lexically instead made canonical paths coming from
    //     git output or `realpath` demand per-file authorization.
    //   deny side: links that genuinely leave the workspace are still
    //     rejected even when the visible path looks contained.
    // Trade-off: an outside path that is itself a link INTO the workspace is
    // allowed, because the bytes it reaches are in-workspace. That is the
    // stated semantics of "real root is authoritative", and is consistent with
    // a link that leaves the root and resolves back inside it.
    if (contain(realRoot, realTarget) === 'outside') {
      // Denied either way — the lexical layer only picks the kind and message.
      if (inputOutsideLexical) {
        return this.decide(resolvedPath, 'lexical', '目标路径越出 Workspace 边界');
      }
      return this.decide(
        resolvedPath,
        'symlink',
        contain(this.root, realTarget) === 'outside'
          ? '符号链接指向 Workspace 外部'
          : 'Workspace 根目录解析后不包含该路径'
      );
    }

    return { allowed: true, resolvedPath, escape: 'none', needsAuthorization: false };
  }

  /**
   * Real-path resolution that tolerates non-existent leaves: when `p` itself
   * does not exist, resolve its nearest existing ancestor and re-append the
   * remaining segments lexically.
   *
   * Re-appending is only sound for segments that genuinely DO NOT EXIST — a
   * path component that does not exist cannot be a symlink, so no escape can
   * hide in it. A component that exists but cannot be read (`EACCES` on a
   * walled directory, `ELOOP` on a symlink cycle) is a different matter: it may
   * be a link pointing out of the workspace, and lexically re-appending it
   * would fabricate a real path that looks contained. Those throw
   * {@link UnverifiablePathError} so the caller can fail closed.
   *
   * Note `fs.realpath` on a directory whose mode is 000 SUCCEEDS (the wall only
   * blocks resolving paths *below* it), so the discrimination has to happen per
   * failing segment, not once at the top.
   */
  private async resolveReal(p: string): Promise<string> {
    try {
      return await this.realpath(p);
    } catch (err) {
      if (!isNotFound(err)) {
        // `p` itself exists but is unverifiable — do not walk up and guess.
        throw new UnverifiablePathError(p, err);
      }
      let current = p;
      let suffix = '';
      for (;;) {
        const parent = path.dirname(current);
        if (parent === current) throw new UnverifiablePathError(p);
        suffix = suffix === '' ? path.basename(current) : path.join(path.basename(current), suffix);
        current = parent;
        try {
          const realParent = await this.realpath(current);
          return suffix === '' ? realParent : path.join(realParent, suffix);
        } catch (ancestorErr) {
          // Only keep walking past ancestors that truly do not exist. An
          // unreadable ancestor could be an escaping symlink; treat the whole
          // path as unverifiable rather than assuming it stays in-root.
          if (!isNotFound(ancestorErr)) {
            throw new UnverifiablePathError(p, ancestorErr);
          }
        }
      }
    }
  }

  /**
   * Explicit user grant for one outside path (§7.3/§35).
   *
   * Keyed on the exact normalized path the user authorized — no case folding.
   * Folding the key to lower case would make one grant cover a DIFFERENT file
   * on a case-sensitive filesystem (granting `Notes/Report.TXT` would silently
   * authorize `notes/report.txt`), which is a fail-open authorization bug. The
   * cost of exact keys is fail-closed: on a case-insensitive volume the same
   * file spelled differently needs its own grant.
   */
  grant(target: string): void {
    const resolved = expandAndNormalize(target, this.home);
    this.grants.set(grantKey(resolved), {
      path: resolved,
      grantedAt: new Date().toISOString()
    });
  }

  revoke(target: string): void {
    const resolved = expandAndNormalize(target, this.home);
    this.grants.delete(grantKey(resolved));
  }

  hasGrant(target: string): boolean {
    const resolved = expandAndNormalize(target, this.home);
    return this.grants.has(grantKey(resolved));
  }

  /**
   * All currently granted outside paths (for UI display / audit) — the actual
   * paths as authorized, never an internal folded key.
   */
  grantedPaths(): string[] {
    return [...this.grants.values()].map((entry) => entry.path);
  }

  private decide(
    resolvedPath: string,
    escape: Exclude<EscapeKind, 'none'>,
    reason: string
  ): BoundaryCheck {
    if (this.hasGrant(resolvedPath)) {
      return { allowed: true, resolvedPath, escape, needsAuthorization: false };
    }
    return {
      allowed: false,
      reason,
      escape,
      needsAuthorization: true,
      resolvedPath
    };
  }
}
