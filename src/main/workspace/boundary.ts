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

export type EscapeKind = 'none' | 'lexical' | 'symlink' | 'root_missing';

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
  private readonly grants = new Map<string, { grantedAt: string }>();

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
    if (contain(this.root, resolvedPath) === 'outside') {
      return this.decide(resolvedPath, 'lexical', '目标路径越出 Workspace 边界');
    }

    // Symlink escape checkpoint (§35): resolve what the path really points at.
    // The target itself or any of its ancestors may be a symlink leaving the
    // workspace; resolving through the nearest existing ancestor covers
    // not-yet-created targets behind symlinks too.
    try {
      const realTarget = await this.resolveReal(resolvedPath);
      const outsideLexical = contain(this.root, realTarget) === 'outside';
      const realRoot = await this.realpath(this.root);
      const outsideReal = contain(realRoot, realTarget) === 'outside';
      // A workspace opened through a symlinked path (macOS `/tmp`/`/var`,
      // symlinked home or project layouts) resolves to a different prefix —
      // that alone must not fail every access (QA-1). Deny therefore requires
      // the real target to leave the REAL root; the lexical disagreement is
      // only used to pick the message. The real-root layer stays authoritative,
      // so links that genuinely leave the workspace behind the root are still
      // rejected even when the visible path looks contained.
      if (outsideReal) {
        return this.decide(
          resolvedPath,
          'symlink',
          outsideLexical ? '符号链接指向 Workspace 外部' : 'Workspace 根目录解析后不包含该路径'
        );
      }
    } catch {
      // Unresolvable for reasons other than symlinks (e.g. permission walls on
      // every ancestor). Existence problems are not boundary problems and are
      // left to the caller (file operations issue).
    }

    return { allowed: true, resolvedPath, escape: 'none', needsAuthorization: false };
  }

  /**
   * Real-path resolution that tolerates non-existent leaves: when `p` itself
   * does not exist, resolve its nearest existing ancestor and re-append the
   * remaining segments lexically. Throws only when nothing resolves.
   */
  private async resolveReal(p: string): Promise<string> {
    try {
      return await this.realpath(p);
    } catch {
      let current = p;
      let suffix = '';
      for (;;) {
        const parent = path.dirname(current);
        if (parent === current) throw new Error(`cannot resolve real path of ${p}`);
        suffix = suffix === '' ? path.basename(current) : path.join(path.basename(current), suffix);
        current = parent;
        try {
          const realParent = await this.realpath(current);
          return suffix === '' ? realParent : path.join(realParent, suffix);
        } catch {
          /* keep walking up */
        }
      }
    }
  }

  /** Explicit user grant for one outside path (§7.3/§35). */
  grant(target: string): void {
    const resolved = expandAndNormalize(target, this.home);
    this.grants.set(resolved.toLowerCase(), { grantedAt: new Date().toISOString() });
  }

  revoke(target: string): void {
    const resolved = expandAndNormalize(target, this.home);
    this.grants.delete(resolved.toLowerCase());
  }

  hasGrant(target: string): boolean {
    const resolved = expandAndNormalize(target, this.home);
    return this.grants.has(resolved.toLowerCase());
  }

  /** All currently granted outside paths (for UI display / audit). */
  grantedPaths(): string[] {
    return [...this.grants.keys()];
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
