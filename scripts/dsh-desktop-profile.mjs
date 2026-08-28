#!/usr/bin/env node
/**
 * DSH Desktop Profile — the desktop-side runtime behind `dsh --profile desktop`
 * (Runtime Protocol v1 over stdio), driven by a real dsh CLI.
 *
 * The official @deepseek-ai/dsh CLI ships web/tui/headless profiles but no
 * desktop profile yet (the launcher also rejects `--stdio`). This adapter is
 * the repo's desktop runtime implementation: it speaks the Desktop's
 * JSONL contract on stdio and executes each `run` by invoking
 * `dsh --profile headless <message>` in the requested workspace, mapping the
 * result back onto the protocol:
 *
 * - boot            → locate the dsh CLI (env override → bundled → PATH),
 *                     probe `--version`, emit `ready`
 * - `run`           → `run_started`, stream headless stdout as
 *                     `message_delta`, then `message_completed` +
 *                     `run_completed` (exit 0) or `error` + `run_cancelled`
 * - `cancel`        → SIGTERM (then SIGKILL) the child, emit `run_cancelled`;
 *                     the process stays resident (AC-11 semantics)
 * - `approval_response` → no interactive approval flow in headless mode;
 *                     logged and ignored
 *
 * File edits made by the agent inside the workspace are picked up by the
 * desktop's git reconciliation after the terminal frame, so no synthetic
 * `file_changed` events are emitted here.
 *
 * Environment knobs:
 * - DSH_DESKTOP_DSH_BIN   explicit dsh CLI path (tests / special installs)
 * - DSH_DESKTOP_MAX_LINE_BYTES  inbound line cap (default 1 MiB)
 */

import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import process from 'node:process';

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = positiveIntEnv('DSH_DESKTOP_MAX_LINE_BYTES', 1024 * 1024);
const VERSION_PROBE_TIMEOUT_MS = 1500;
const KILL_GRACE_MS = 3000;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Resolved at boot, before the first command can arrive. */
let dshBin = null;

function positiveIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function emit(frame) {
  const line = `${JSON.stringify({ v: PROTOCOL_VERSION, ...frame })}\n`;
  process.stdout.write(line);
}

/* ------------------------------------------------------------------ */
/* dsh CLI resolution                                                   */
/* ------------------------------------------------------------------ */

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function bundledDshCandidates() {
  const binDir = path.join(SCRIPT_DIR, '..', 'node_modules', '.bin');
  return process.platform === 'win32'
    ? [path.join(binDir, 'dsh.cmd'), path.join(binDir, 'dsh')]
    : [path.join(binDir, 'dsh')];
}

function locateDshBin() {
  // An explicit override that points nowhere is treated as "no dsh" (same
  // semantics as the desktop's dsh-locator: a broken configured path is a
  // diagnosable not-found, never a silent fallback to PATH).
  const override = process.env.DSH_DESKTOP_DSH_BIN?.trim();
  if (override) return isExecutable(override) ? override : null;
  for (const candidate of bundledDshCandidates()) {
    if (isExecutable(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.trim() === '') continue;
    const candidate = path.join(dir, 'dsh');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function probeVersion(bin) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), VERSION_PROBE_TIMEOUT_MS);
    try {
      execFile(bin, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS }, (err, stdout) => {
        clearTimeout(timer);
        resolve(err && !stdout ? null : String(stdout ?? '').trim() || null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Inbound decoding — mirrors stub-runtime.mjs / codec.ts semantics     */
/* ------------------------------------------------------------------ */

const decoderState = { pending: [], pendingBytes: 0, discarding: false };

function pushChunk(text) {
  let offset = 0;
  if (decoderState.discarding) {
    const nl = text.indexOf('\n');
    if (nl === -1) return;
    decoderState.discarding = false;
    offset = nl + 1;
  }
  while (offset < text.length) {
    const nl = text.indexOf('\n', offset);
    if (nl === -1) {
      append(text.slice(offset));
      checkOverflow();
      break;
    }
    append(text.slice(offset, nl));
    offset = nl + 1;
    consumeLine();
  }
}

function append(part) {
  if (!part) return;
  decoderState.pending.push(part);
  decoderState.pendingBytes += Buffer.byteLength(part);
}

function checkOverflow() {
  if (!decoderState.discarding && decoderState.pendingBytes > MAX_LINE_BYTES) {
    console.error(`[desktop-profile] dropped oversized line (> ${MAX_LINE_BYTES} bytes)`);
    resetPending();
    decoderState.discarding = true;
  }
}

function consumeLine() {
  let line = decoderState.pending.join('');
  resetPending();
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return;
  if (line.length === 0) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.error(`[desktop-profile] ignoring malformed line: ${line.slice(0, 120)}`);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.v !== PROTOCOL_VERSION) {
    console.error('[desktop-profile] ignoring frame with bad envelope');
    return;
  }
  handleCommand(parsed);
}

function resetPending() {
  decoderState.pending = [];
  decoderState.pendingBytes = 0;
}

/* ------------------------------------------------------------------ */
/* Run execution — one dsh headless child per run                       */
/* ------------------------------------------------------------------ */

let activeRun = null; // { id, sessionId, child, stdoutText, stderrText, cancelling }

function startRun(frame) {
  if (activeRun) {
    emit({
      type: 'error',
      code: 'run_already_active',
      message: 'desktop profile supports one active run at a time',
      recoverable: true
    });
    return;
  }
  const runId = typeof frame.run_id === 'string' ? frame.run_id : `desktop-run-${Date.now()}`;
  const sessionId = typeof frame.session_id === 'string' ? frame.session_id : undefined;
  const message = typeof frame.message === 'string' ? frame.message : '';
  const workspace = typeof frame.workspace === 'string' && frame.workspace !== ''
    ? frame.workspace
    : process.cwd();

  const base = sessionId ? { session_id: sessionId } : {};
  emit({ type: 'run_started', run_id: runId, ...base });

  if (!dshBin) {
    finishRun(runId, base, {
      code: 'dsh_cli_not_found',
      message:
        '未找到 dsh CLI，无法执行任务。请先安装 @deepseek-ai/dsh（npm install）或用 ' +
        'DSH_DESKTOP_DSH_BIN 指定 dsh 路径。'
    });
    return;
  }

  let child;
  try {
    child = spawn(dshBin, ['--profile', 'headless', message], {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    finishRun(runId, base, {
      code: 'dsh_spawn_failed',
      message: `无法启动 dsh CLI：${err?.message ?? err}`
    });
    return;
  }

  activeRun = { id: runId, sessionId, child, stdoutText: '', stderrText: '', cancelling: false };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (!activeRun || activeRun.id !== runId) return;
    activeRun.stdoutText += chunk;
    if (chunk) emit({ type: 'message_delta', run_id: runId, ...base, content: String(chunk) });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (!activeRun || activeRun.id !== runId) return;
    activeRun.stderrText += chunk;
  });

  child.on('error', (err) => {
    if (!activeRun || activeRun.id !== runId) return;
    finishRun(runId, base, {
      code: 'dsh_spawn_failed',
      message: `无法启动 dsh CLI：${err?.message ?? err}`
    });
  });

  child.on('close', (code) => {
    if (!activeRun || activeRun.id !== runId) return;
    const { stdoutText, stderrText } = activeRun;
    activeRun = null;
    if (code === 0) {
      const summary = summarize(stdoutText);
      emit({ type: 'message_completed', run_id: runId, ...base, content: stdoutText });
      emit({ type: 'run_completed', run_id: runId, ...base, summary, content: stdoutText });
    } else {
      const detail = (stderrText || stdoutText).trim().split('\n').filter(Boolean).slice(-4).join('\n');
      emit({
        type: 'error',
        code: 'dsh_run_failed',
        message: `dsh 任务执行失败（exit=${code}）${detail ? `：\n${detail}` : ''}`,
        recoverable: true,
        run_id: runId,
        ...base
      });
      emit({ type: 'run_cancelled', run_id: runId, reason: 'dsh_run_failed', ...base });
    }
  });
}

function summarize(text) {
  const firstLine = text.trim().split('\n').find((l) => l.trim() !== '');
  if (!firstLine) return undefined;
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/** Emit the failure pair (error + run_cancelled) and drop the active run. */
function finishRun(runId, base, error) {
  if (activeRun?.id === runId) {
    try {
      activeRun.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    activeRun = null;
  }
  emit({ type: 'error', run_id: runId, recoverable: true, ...error, ...base });
  emit({ type: 'run_cancelled', run_id: runId, reason: 'dsh_run_failed', ...base });
}

function cancelActiveRun(runIdFilter) {
  if (!activeRun) return false;
  if (runIdFilter && activeRun.id !== runIdFilter) return false;
  const { id, sessionId, child } = activeRun;
  const base = sessionId ? { session_id: sessionId } : {};
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  // Enforce the grace period unconditionally — the run state is already
  // cleared below, so no other path will SIGKILL a stubborn child.
  setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }, KILL_GRACE_MS).unref();
  // Clear the run BEFORE the child's close event fires: the close handler
  // bails out on an unknown run, so the terminal frame comes from here with
  // the canonical reason instead of a synthetic success/failure pair.
  activeRun = null;
  emit({ type: 'run_cancelled', run_id: id, reason: 'client_requested', ...base });
  return true;
}

function handleCommand(frame) {
  switch (frame.type) {
    case 'run':
      startRun(frame);
      break;
    case 'cancel':
      cancelActiveRun(typeof frame.run_id === 'string' ? frame.run_id : undefined);
      break;
    case 'approval_response':
      // Headless mode has no interactive approval flow; decisions from the
      // desktop are logged for diagnostics and otherwise ignored.
      console.error('[desktop-profile] approval_response ignored (no approval flow in headless mode)');
      break;
    default:
      console.error(`[desktop-profile] ignoring unsupported command type "${frame.type}"`);
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

function shutdown(code) {
  if (activeRun) {
    try {
      activeRun.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    activeRun = null;
  }
  process.exit(code);
}

function startListening() {
  // Registered only AFTER the ready frame is written: the version probe below
  // awaits, and stdin data events during that await must never be handled
  // before the handshake — `ready` is guaranteed to be the first frame.
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => pushChunk(chunk.toString('utf8')));
  process.stdin.on('end', () => shutdown(0));
  process.stdin.on('error', () => shutdown(1));
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

dshBin = locateDshBin();
if (!dshBin) {
  // Still complete the ready handshake so the desktop shows a diagnosable
  // state instead of a bare crash; every run will report dsh_cli_not_found.
  emit({ type: 'ready', profile: 'desktop', pid: process.pid });
} else {
  const version = await probeVersion(dshBin);
  emit({ type: 'ready', profile: 'desktop', pid: process.pid, dsh_version: version ?? undefined });
}
startListening();
