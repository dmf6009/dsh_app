export interface DisplayOpts {
  min?: number;
  max?: number;
  lockDir?: string;
}

export interface ShouldCleanSocketInput {
  num: number;
  socketExistedBefore: boolean;
  xvfbPidAlive: boolean;
}

export const DEFAULT_MIN_DISPLAY: number;
export const DEFAULT_MAX_DISPLAY: number;

export function socketPath(num: number): string;
export function lockPath(num: number, opts?: DisplayOpts): string;
export function displayOccupied(num: number): boolean;
export function acquireDisplay(num: number, opts?: DisplayOpts): boolean;
export function releaseDisplay(num: number, opts?: DisplayOpts): void;
export function findFreeDisplay(opts?: DisplayOpts): number | null;
export function claimExplicit(num: number, opts?: DisplayOpts): boolean;
export function socketExistedBefore(num: number): boolean;
export function shouldCleanSocket(input: ShouldCleanSocketInput): boolean;
