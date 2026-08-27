export interface DisplayOpts {
  min?: number;
  max?: number;
  lockDir?: string;
}

export interface OwnerInfo {
  token: string;
  pid: number | null;
}

export interface ClaimHandle {
  num: number;
  token: string;
}

export interface CleanSocketInput {
  num: number;
  token: string;
  socketExistedBefore: boolean;
  xvfbPidAlive: boolean;
}

export interface ShouldCleanInput {
  socketExistedBefore: boolean;
  xvfbPidAlive: boolean;
}

export const DEFAULT_MIN_DISPLAY: number;
export const DEFAULT_MAX_DISPLAY: number;

export function socketPath(num: number): string;
export function lockPath(num: number, opts?: DisplayOpts): string;
/** The per-display mutex file path (kernel flock target). */
export function mutPath(num: number, opts?: DisplayOpts): string;
export function displayOccupied(num: number): boolean;
export function newOwnerToken(): string;
export function readOwner(num: number, opts?: DisplayOpts): OwnerInfo | null;
export function acquireDisplay(num: number, opts?: DisplayOpts): string | null;
/** Reclaim a dead-owner lock. ALWAYS under the per-display flock (no lock-free
 * branch on the public mutation API). */
export function acquireStale(num: number, opts?: DisplayOpts): string | null;
/** CRITICAL SECTION (caller MUST hold the per-display flock). Pure path op.
 * b0/b1/b2 are test hooks (b0 after acquiring flock, b1 after verify, b2 after
 * the destructive op). */
export function acquireStaleCritical(
  num: number,
  opts?: DisplayOpts,
  isPidAlive?: (pid: number) => boolean,
  barrier0?: string,
  barrier1?: string,
  barrier2?: string
): string | null;
/** Compare-and-release the lockfile for `num` ONLY IF its current owner token
 * still equals `token`. Runs under the per-display flock. ALWAYS a boolean. */
export function releaseOwned(num: number, token: string, opts?: DisplayOpts): boolean;
/** CRITICAL SECTION (caller MUST hold the per-display flock). Pure path op. */
export function releaseOwnedCritical(
  num: number,
  token: string,
  opts?: DisplayOpts,
  barrier0?: string,
  barrier1?: string,
  barrier2?: string
): boolean;
export function shouldCleanSocket(input: ShouldCleanInput): boolean;
/** Remove the X11 socket for `num` ONLY IF we STILL own the claim. Runs under
 * the per-display flock. ALWAYS a boolean. */
export function cleanOwnedSocket(input: CleanSocketInput, opts?: DisplayOpts): boolean;
/** CRITICAL SECTION (caller MUST hold the per-display flock). Pure path op. */
export function cleanOwnedSocketCritical(
  input: CleanSocketInput,
  opts?: DisplayOpts,
  barrier0?: string,
  barrier1?: string,
  barrier2?: string
): boolean;
export function findFreeDisplay(opts?: DisplayOpts): ClaimHandle | null;
export function claimExplicit(num: number, opts?: DisplayOpts): ClaimHandle | null;
export function socketExistedBefore(num: number): boolean;
