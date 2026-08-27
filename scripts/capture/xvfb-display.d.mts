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
export function displayOccupied(num: number): boolean;
export function newOwnerToken(): string;
export function readOwner(num: number, opts?: DisplayOpts): OwnerInfo | null;
export function acquireDisplay(num: number, opts?: DisplayOpts): string | null;
export function acquireStale(
  num: number,
  opts?: DisplayOpts,
  isPidAlive?: (pid: number) => boolean
): string | null;
export function releaseOwned(num: number, token: string, opts?: DisplayOpts): boolean;
export function shouldCleanSocket(input: ShouldCleanInput): boolean;
export function cleanOwnedSocket(input: CleanSocketInput, opts?: DisplayOpts): boolean;
export function findFreeDisplay(opts?: DisplayOpts): ClaimHandle | null;
export function claimExplicit(num: number, opts?: DisplayOpts): ClaimHandle | null;
export function socketExistedBefore(num: number): boolean;
