export interface ChildError extends Error {
  code?: string;
  signal?: string;
}

export interface ProcResult {
  status: number | null;
  signal: string | null;
  error?: ChildError | null;
  timedOut: boolean;
  pid: number | null;
}

export interface TreeKillOpts {
  pid: number | null;
  signal?: string;
  graceMs?: number;
  extraPids?: number[];
  killTreeSync?: (pid: number, sig: string) => void;
  descendants?: (pid: number) => number[];
  killPid?: (pid: number, sig: string) => void;
}

export interface RunChildOpts {
  timeoutMs?: number;
  killSignal?: string;
  graceMs?: number;
  env?: NodeJS.ProcessEnv;
  stdio?: import('child_process').StdioOptions;
  cwd?: string;
  killTreeSync?: (pid: number, sig: string) => void;
}

export function isTimeoutError(result: ProcResult | null | undefined): boolean;
export function exitCodeFor(result: ProcResult | null | undefined): number;
export function descendantsOf(pid: number, opts?: { readChildren?: (pid: number) => number[] }): number[];
export function treeKill(opts: TreeKillOpts): void;
export function defaultTreeKillSync(pid: number, sig: string): void;
export function isPidAliveSync(pid: number): boolean;
export function runChild(cmd: string, args: string[], opts?: RunChildOpts): Promise<ProcResult>;
