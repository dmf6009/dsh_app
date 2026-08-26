#!/usr/bin/env node
/**
 * Reference Stub Runtime — simulates `dsh --profile desktop --stdio`.
 *
 * Contract (Phase 0 / P1-B):
 * - emits `ready` on startup, then stays alive reading JSONL commands
 * - on `run`: streams several `message_delta`, one `message_completed`,
 *   a `plan`, a `file_read`, a full shell tool trio (`tool_started` /
 *   `tool_output` / `tool_completed`), two `file_changed` events, and
 *   finishes with `done`
 * - on `cancel`: stops the active run immediately and emits `run_cancelled`.
 *   Default behavior exits afterwards (DSHA-3 deliverable #4); with
 *   STUB_RESIDENT_CANCEL=1 the process stays resident so callers can verify
 *   AC-11 semantics (input unlocks on run_cancelled, no restart needed)
 * - with STUB_APPROVAL_FLOW=1 the run pauses on an `approval_required`
 *   event (L2 shell command) until an `approval_response` command arrives;
 *   reject ends the run via error + run_cancelled
 * - with STUB_EMIT_CANCELLED_TOOLS=1 cancellation first closes unfinished
 *   tools with tool_completed{status:'cancelled'} (mirrors real DSH) so the
 *   desktop's de-duplication can be exercised
 * - ignores malformed input lines without dying; protects itself against
 *   overlong lines; exits cleanly when stdin closes or on SIGTERM/SIGINT
 *
 * Environment knobs (used by tests):
 * - STUB_DELTA_DELAY_MS          pacing between streamed steps (default 90ms)
 * - STUB_MAX_LINE_BYTES          inbound line cap (default 1 MiB)
 * - STUB_RESIDENT_CANCEL         keep process alive after cancel (default off)
 * - STUB_APPROVAL_FLOW           pause for approval mid-run (default off)
 * - STUB_EMIT_CANCELLED_TOOLS    close tools as cancelled on stop (default off)
 */

import process from 'node:process';

const PROTOCOL_VERSION = 1;
const DELAY_MS = positiveIntEnv('STUB_DELTA_DELAY_MS', 90);
const MAX_LINE_BYTES = positiveIntEnv('STUB_MAX_LINE_BYTES', 1024 * 1024);
const RESIDENT_CANCEL = truthyEnv('STUB_RESIDENT_CANCEL');
const APPROVAL_FLOW = truthyEnv('STUB_APPROVAL_FLOW');
const EMIT_CANCELLED_TOOLS = truthyEnv('STUB_EMIT_CANCELLED_TOOLS');

const CANNED_ANSWER =
  '登录接口偶发 500 的原因已定位：session 校验在过期分支直接抛出未捕获异常。' +
  '我已修改 src/auth/login.py，将过期会话重定向到登录页，并补充了回归测试。';

const TOOL_CALL_ID = 'call-login-fix-1';
const APPROVAL_ID = 'approval-rm-build-1';

function positiveIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function truthyEnv(name) {
  const raw = process.env[name];
  return raw === '1' || raw === 'true' || raw === 'yes';
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

let activeRun = null; // { id, sessionId, step, timer, steps, unfinishedTools, paused }

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

  activeRun = {
    id: runId,
    sessionId,
    step: 0,
    timer: null,
    steps: buildRunSteps(runId, sessionId),
    unfinishedTools: new Set(),
    paused: false
  };

  const next = () => {
    if (!activeRun || activeRun.paused) return;
    const step = activeRun.steps[activeRun.step];
    activeRun.step += 1;
    if (step) {
      try {
        step.frame();
      } catch (err) {
        console.error(`[stub] step ${activeRun.step} failed: ${err?.message ?? err}`);
      }
    }
    if (activeRun && !activeRun.paused && activeRun.step < activeRun.steps.length) {
      activeRun.timer = setTimeout(next, DELAY_MS);
    } else if (activeRun && !activeRun.paused) {
      activeRun = null; // done emitted as last step; runtime stays alive
    }
  };
  next();
}

/** Resume the step pump after an approval decision. */
function resumeRun() {
  if (!activeRun || !activeRun.paused) return;
  activeRun.paused = false;
  const next = () => {
    if (!activeRun || activeRun.paused) return;
    const step = activeRun.steps[activeRun.step];
    activeRun.step += 1;
    if (step) {
      try {
        step.frame();
      } catch (err) {
        console.error(`[stub] step ${activeRun.step} failed: ${err?.message ?? err}`);
      }
    }
    if (activeRun && !activeRun.paused && activeRun.step < activeRun.steps.length) {
      activeRun.timer = setTimeout(next, DELAY_MS);
    } else if (activeRun && !activeRun.paused) {
      activeRun = null;
    }
  };
  next();
}

/** Abort the active run from the approval path (reject). */
function failRun(runId, message) {
  if (!activeRun || activeRun.id !== runId) return;
  if (activeRun.timer) clearTimeout(activeRun.timer);
  const { id, sessionId } = activeRun;
  activeRun = null;
  const base = sessionId ? { session_id: sessionId } : {};
  emit({
    type: 'error',
    code: 'operation_rejected',
    message,
    recoverable: false,
    run_id: id,
    ...base
  });
  emit({ type: 'run_cancelled', run_id: id, reason: 'approval_rejected', ...base });
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

  // §9 Plan card demo content.
  steps.push({
    label: 'plan',
    frame: () =>
      emit({
        type: 'plan',
        run_id: runId,
        steps: [
          '定位登录接口 500 的根因',
          '修改 session 过期分支的异常处理',
          '补充回归测试并运行 pytest'
        ]
      })
  });

  // §9 File Read entry.
  steps.push({
    label: 'file_read',
    frame: () =>
      emit({
        type: 'file_read',
        run_id: runId,
        path: 'src/auth/login.py',
        size_bytes: 4211
      })
  });

  if (APPROVAL_FLOW) {
    // L2 destructive shell op — pauses the pump until an approval_response
    // command arrives (allow continues; reject aborts via failRun).
    steps.push({
      label: 'approval_required',
      frame: () => {
        activeRun.paused = true;
        emit({
          type: 'approval_required',
          run_id: runId,
          approval_id: APPROVAL_ID,
          tool: 'shell',
          command: 'rm -rf build/',
          risk_level: 'L2',
          summary: '删除构建产物目录 build/',
          paths: ['build/'],
          ...base
        });
      }
    });
  }

  steps.push({
    label: 'tool_started',
    frame: () => {
      activeRun?.unfinishedTools.add(TOOL_CALL_ID);
      emit({
        type: 'tool_started',
        run_id: runId,
        tool_call_id: TOOL_CALL_ID,
        tool: 'shell',
        command: 'pytest tests/test_login.py'
      })
    }
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
    frame: () => {
      activeRun?.unfinishedTools.delete(TOOL_CALL_ID);
      emit({
        type: 'tool_completed',
        run_id: runId,
        tool_call_id: TOOL_CALL_ID,
        status: 'ok',
        exit_code: 0,
        duration_ms: 320
      })
    }
  });

  // Changes column demo data.
  steps.push({
    label: 'file_changed_modified',
    frame: () =>
      emit({
        type: 'file_changed',
        run_id: runId,
        path: 'src/auth/login.py',
        change: 'modified'
      })
  });
  steps.push({
    label: 'file_changed_added',
    frame: () =>
      emit({
        type: 'file_changed',
        run_id: runId,
        path: 'tests/test_login_session.py',
        change: 'added'
      })
  });

  // §9 Sub-Agent placeholder demo (P1-D will replace this with a real
  // sub-agent surface; the desktop already renders the card from these
  // frames).
  const TASK_CALL_ID = `${TOOL_CALL_ID}-task`;
  steps.push({
    label: 'subagent_started',
    frame: () => {
      activeRun?.unfinishedTools.add(TASK_CALL_ID);
      emit({
        type: 'tool_started',
        run_id: runId,
        tool_call_id: TASK_CALL_ID,
        tool: 'task',
        command: '分析登录模块的会话依赖'
      })
    }
  });
  steps.push({
    label: 'subagent_output',
    frame: () =>
      emit({
        type: 'tool_output',
        run_id: runId,
        tool_call_id: TASK_CALL_ID,
        content: '子任务进行中：已扫描 12 个相关文件',
        stream: 'stdout'
      })
  });
  steps.push({
    label: 'subagent_completed',
    frame: () => {
      activeRun?.unfinishedTools.delete(TASK_CALL_ID);
      emit({
        type: 'tool_completed',
        run_id: runId,
        tool_call_id: TASK_CALL_ID,
        status: 'ok',
        summary: '确认 session 过期分支缺少异常保护（P1-D 提供完整子任务视图）'
      })
    }
  });

  steps.push({
    label: 'done',
    frame: () =>
      emit({
        type: 'done',
        run_id: runId,
        summary: '已修复登录接口偶发 500：2 个文件变更，回归测试通过。',
        ...base
      })
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
  // Cancel also works while the run is paused waiting for an approval.
  const { id, sessionId, unfinishedTools } = activeRun;
  if (activeRun.timer) clearTimeout(activeRun.timer);
  activeRun = null;
  const base = sessionId ? { session_id: sessionId } : {};
  // Mirror real DSH: close unfinished tools as cancelled before the terminal
  // frame (opt-in so the default stays minimal per DSHA-3).
  if (EMIT_CANCELLED_TOOLS) {
    for (const callId of unfinishedTools) {
      emit({
        type: 'tool_completed',
        run_id: id,
        tool_call_id: callId,
        status: 'cancelled',
        ...base
      });
    }
  }
  emit({ type: 'run_cancelled', run_id: id, reason: 'client_requested', ...base });
  if (!RESIDENT_CANCEL) {
    // Legacy behavior: guarantee flush before exiting (DSHA-3 semantics).
    setTimeout(() => process.exit(0), 40);
  }
  return true;
}

function handleApprovalResponse(frame) {
  const approvalId = typeof frame.approval_id === 'string' ? frame.approval_id : '';
  if (!activeRun || !activeRun.paused) {
    console.error(`[stub] approval_response without a paused run: ${approvalId}`);
    return;
  }
  const decision = frame.decision === 'allow' ? 'allow' : 'reject';
  // Echo the decision back so the desktop can assert the round trip.
  emit({ type: 'approval_response', run_id: activeRun.id, approval_id: APPROVAL_ID, decision });
  if (decision === 'allow') {
    resumeRun();
  } else {
    failRun(activeRun.id, '操作被用户拒绝：rm -rf build/ 未执行');
  }
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
      handleApprovalResponse(frame);
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
