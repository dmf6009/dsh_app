export interface PreflightDeps {
  electronPath: string | null;
  electronExists: boolean;
  indexExists: boolean;
  xvfbNeeded: boolean;
  xvfbAvailable: boolean;
}

export interface SpawnPlanInput {
  platform: string;
  hasDisplay: boolean;
  electronArgsEnv?: string;
}

export interface SpawnPlan {
  useXvfb: boolean;
  extraElectronArgs: string[];
}

export interface ExitCodeInput {
  status: number | null;
  signal: string | null;
  error?: { message?: string } | null;
  timedOut?: boolean;
}

export function preflightErrors(dep: PreflightDeps): string[];
export function spawnPlan(o: SpawnPlanInput): SpawnPlan;
export function exitCode(r: ExitCodeInput): number;
export const DEFAULT_TIMEOUT_MS: number;
