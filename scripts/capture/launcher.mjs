/**
 * Pure launcher helpers for the DSHA-6 Diff capture + assertion gate.
 *
 * These functions carry NO side effects (no fs, no spawn) so they can be unit-
 * tested in plain node. The thin entry `scripts/capture/run-capture.mjs` calls
 * them around the real `spawnSync`, keeping the fail-closed / timeout / signal-
 * propagation rules here where they are repeatable and assertable.
 *
 * Fail-closed contract: the gate command must exit NON-ZERO whenever a run
 * dependency is missing or the child fails, times out, or is killed — never
 * exit 0 with the gate unrun. "SKIP on missing electron" (the prior behaviour)
 * is forbidden because it produces a green-looking command that ran nothing.
 */

/**
 * Validate run dependencies before spawning Electron.
 * Returns an array of error strings (empty ⇒ ok to proceed). Missing Electron
 * binary or built renderer entry each fail-closed (non-zero later), so the
 * documented "exit 0 only if every assertion passes" cannot be faked green by
 * an environment that silently skipped the run.
 *
 * @param {{ electronPath: string|null, electronExists: boolean, indexExists: boolean, xvfbNeeded: boolean, xvfbAvailable: boolean }} dep
 * @returns {string[]}
 */
export function preflightErrors(dep) {
  const errs = [];
  if (typeof dep.electronPath !== 'string' || dep.electronPath.length === 0) {
    errs.push('Electron binary path is missing (require(electron) did not resolve).');
  } else if (!dep.electronExists) {
    errs.push(`Electron binary not found on disk at "${dep.electronPath}" (npm postinstall may have been blocked).`);
  }
  if (!dep.indexExists) {
    errs.push('Built renderer entry dist/renderer/index.html is missing — run "npm run build" first.');
  }
  if (dep.xvfbNeeded && !dep.xvfbAvailable) {
    errs.push('No DISPLAY is set and xvfb-run is not available; cannot run the headless capture gate.');
  }
  return errs;
}

/**
 * Decide how to spawn. On Linux without a DISPLAY the Electron binary is run
 * under `xvfb-run -a`; otherwise Electron is launched directly.
 * @param {{ platform: string, hasDisplay: boolean, electronArgsEnv?: string }} o
 * @returns {{ useXvfb: boolean, extraElectronArgs: string[] }}
 */
export function spawnPlan(o) {
  const useXvfb = o.platform === 'linux' && !o.hasDisplay;
  let extraElectronArgs = [];
  if (o.electronArgsEnv) {
    extraElectronArgs = o.electronArgsEnv.split(/\s+/).filter(Boolean);
  } else if (o.platform === 'linux') {
    extraElectronArgs = ['--no-sandbox', '--disable-dev-shm-usage'];
  }
  return { useXvfb, extraElectronArgs };
}

/**
 * Resolve the final process exit code from a child result (spawnSync shape or
 * the async runChild result). Fail-closed: any timeout, error, or kill signal
 * ⇒ 1 (never 0 when the gate did not run cleanly to a clean status). A child
 * that crashed on a missing entry file (ERR_FILE_NOT_FOUND) surfaces as
 * error/status null and must exit non-zero — callers must also preflight, but
 * this is the backstop.
 *
 * Timeout detection uses the REAL spawnSync shape: `error.code === 'ETIMEDOUT'`
 * (spawnSync sets this and `signal === 'SIGTERM'`; it does NOT set a
 * `timedOut` field — the prior code read a non-existent field). The async
 * runChild path sets its own `timedOut: true` when its wall-clock deadline
 * fires; both are recognised via isTimeoutError.
 * @param {{ status: number|null, signal: string|null, error?: { code?: string, message?: string }|null, timedOut?: boolean }} r
 * @returns {number}
 */
export function exitCode(r) {
  // Real spawnSync timeout: error.code ETIMEDOUT (+ signal SIGTERM). The
  // `timedOut` boolean does NOT exist on spawnSync results; only runChild sets
  // it. isTimeoutError accepts both.
  if (r && r.timedOut === true) return 1;
  if (r && r.error && r.error.code === 'ETIMEDOUT') return 1;
  if (r && r.error) return 1;
  if (r && r.signal) return 1;
  if (!r || typeof r.status !== 'number') return 1;
  return r.status;
}

/** Default per-run timeout (ms) — bounds the gate so a wedged Electron child
 * (e.g. ERR_FILE_NOT_FOUND with no exit) cannot hang CI. Overridable via
 * DSH_CAPTURE_TIMEOUT_MS. Generous because the 21-scenario capture + Electron
 * boot + Xvfb can take a couple of minutes under load. */
export const DEFAULT_TIMEOUT_MS = 180_000;
