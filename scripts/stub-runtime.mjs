#!/usr/bin/env node
/**
 * Reference Stub Runtime — simulates `dsh --profile desktop --stdio`.
 *
 * Contract (Phase 0):
 * - emits `ready` on startup, then stays alive reading JSONL commands
 * - on `run`: streams several `message_delta`, one `message_completed`,
 *   a full tool trio (`tool_started` / `tool_output` / `tool_completed`),
 *   and finishes with `done`
 * - on `cancel`: stops the active run immediately, emits `run_cancelled`,
 *   and exits (per DSHA-3 deliverable #4)
 * - ignores malformed input lines without dying; protects itself against
 *   overlong lines; exits cleanly when stdin closes or on SIGTERM/SIGINT
 *
 * Environment knobs (used by tests):
 * - STUB_DELTA_DELAY_MS   pacing between streamed steps (default 90ms)
 * - STUB_MAX_LINE_BYTES   inbound line cap (default 1 MiB)
 */

import process from 'node:process';

const PROTOCOL_VERSION = 1;
const DELAY_MS = positiveIntEnv('STUB_DELTA_DELAY_MS', 90);
const MAX_LINE_BYTES = positiveIntEnv('STUB_MAX_LINE_BYTES', 1024 * 1024);

const CANNED_ANSWER =
  '登录接口偶发 500 的原因已定位：session 校验在过期分支直接抛出未捕获异常。' +
  '我已修改 src/auth/login.py，将过期会话重定向到登录页，并补充了回归测试。';

const TOOL_CALL_ID = 'call-login-fix-1';

function positiveIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function emit(frame) {
  const line = `${JSON.stringify({ v: PROTOCOL_VERSION, ...frame })}\n`;
  process.stdout.write(line);
}

/* ------------------------------------------------------------------ */
/* Inbound decoding — fault tolerant by design (mirrors src/shared/     */
/* protocol/codec.ts semantics in dependency-free JS).                  */
/* ------------------------------------------------------------------ */

const decoderState = {
  pending: [],
  pendingBytes: 0,
  discarding: false
};

function pushChunk(text) {
  let offset = 0;
  if (decoderState.discarding) {
    // Overlong line in progress: drop everything up to the next newline.
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
    console.error(`[stub] dropped oversized line (> ${MAX_LINE_BYTES} bytes)`);
    resetPending();
    decoderState.discarding = true;
  }
}

function consumeLine() {
  let line = decoderState.pending.join('');
  resetPending();
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    console.error('[stub] dropped oversized terminated line');
    return;
  }
  if (line.length === 0) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.error(`[stub] ignoring malformed line: ${line.slice(0, 120)}`);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.v !== PROTOCOL_VERSION) {
    console.error('[stub] ignoring frame with bad envelope');
    return;
  }
  handleCommand(parsed);
}

function resetPending() {
  decoderState.pending = [];
  decoderState.pendingBytes = 0;
}

/* ------------------------------------------------------------------ */
/* Run simulation                                                       */
/* ------------------------------------------------------------------ */

let activeRun = null; // { id, sessionId, step, timer }

function startRun(frame) {
  if (activeRun) {
    emit({
      type: 'error',
      code: 'run_already_active',
      message: 'stub runtime supports one active run at a time',
      recoverable: true
    });
    return;
  }
  const runId = typeof frame.run_id === 'string' ? frame.run_id : `stub-run-${Date.now()}`;
  const sessionId = typeof frame.session_id === 'string' ? frame.session_id : undefined;

  activeRun = { id: runId, sessionId, step: 0, timer: null };

  const steps = buildRunSteps(runId, sessionId);
  const next = () => {
    if (!activeRun) return;
    const step = steps[activeRun.step];
    activeRun.step += 1;
    if (step) {
      try {
        step.frame();
      } catch (err) {
        console.error(`[stub] step ${activeRun.step} failed: ${err?.message ?? err}`);
      }
    }
    if (activeRun.step < steps.length) {
      activeRun.timer = setTimeout(next, DELAY_MS);
    } else {
      activeRun = null; // done emitted as last step; runtime stays alive
    }
  };
  next();
}

function buildRunSteps(runId, sessionId) {
  const base = sessionId ? { session_id: sessionId } : {};
  const deltas = chunkText(CANNED_ANSWER, 7);
  const steps = [];

  steps.push({
    label: 'run_started',
    frame: () => emit({ type: 'run_started', run_id: runId, ...base })
  });
  deltas.forEach((part) => {
    steps.push({
      label: 'message_delta',
      frame: () => emit({ type: 'message_delta', run_id: runId, content: part })
    });
  });

  steps.push({
    label: 'message_completed',
    frame: () => emit({ type: 'message_completed', run_id: runId, content: CANNED_ANSWER })
  });
  steps.push({
    label: 'tool_started',
    frame: () =>
      emit({
        type: 'tool_started',
        run_id: runId,
        tool_call_id: TOOL_CALL_ID,
        tool: 'shell',
        command: 'pytest tests/test_login.py'
      })
  });
  steps.push({
    label: 'tool_output_1',
    frame: () =>
      emit({
        type: 'tool_output',
        run_id: runId,
        tool_call_id: TOOL_CALL_ID,
        content: 'collected 14 items',
        stream: 'stdout'
      })
  });
  steps.push({
    label: 'tool_output_2',
    frame: () =>
      emit({
        type: 'tool_output',
        run_id: runId,
        tool_call_id: TOOL_CALL_ID,
        content: '12 passed, 2 skipped in 0.32s',
        stream: 'stdout'
      })
  });
  steps.push({
    label: 'tool_completed',
    frame: () =>
      emit({
        type: 'tool_completed',
        run_id: runId,
        tool_call_id: TOOL_CALL_ID,
        status: 'ok',
        exit_code: 0,
        duration_ms: 320
      })
  });
  steps.push({
    label: 'done',
    frame: () => emit({ type: 'done', run_id: runId, summary: CANNED_ANSWER })
  });

  return steps;
}

function chunkText(text, parts) {
  const size = Math.ceil(text.length / parts);
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function cancelActiveRun(runIdFilter) {
  if (!activeRun) return false;
  if (runIdFilter && activeRun.id !== runIdFilter) return false;
  const { id, sessionId } = activeRun;
  if (activeRun.timer) clearTimeout(activeRun.timer);
  activeRun = null;
  const base = sessionId ? { session_id: sessionId } : {};
  emit({ type: 'run_cancelled', run_id: id, reason: 'client_requested', ...base });
  // Guarantee the cancellation frame is flushed before exiting.
  setTimeout(() => process.exit(0), 40);
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
    default:
      console.error(`[stub] ignoring unsupported command type "${frame.type}"`);
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => pushChunk(chunk.toString('utf8')));
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(1));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

emit({
  type: 'ready',
  profile: 'desktop-stub',
  pid: process.pid,
  dsh_version: 'stub-0.1.0'
});
