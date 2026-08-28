/**
 * Submit-flow timing tests (DSHA-7 QA regression fix, §15/AC-02/AC-12).
 *
 * These drive the REAL renderer orchestration (`runSubmit` from
 * src/renderer/src/session/submit-flow.ts — the exact code WorkspacePage's
 * submit calls) with a scripted IO recording call order. The QA-caught
 * regression: the renderer can enter the Workspace page while the main
 * process's currentRoot is still null; the first message then hit
 * session:create → 未打开工作区 and (post-fix) the send was blocked — or
 * (pre-fix) silently degraded into an unpersisted send. The review round
 * after that caught a second bug: the page cleared the composer
 * unconditionally after the flow returned, wiping the input the blocked path
 * tried to preserve — so these tests now track the composer input state the
 * way the component does (textarea `value={input}`, cleared only via
 * `clearInput`) and assert it survives every blocked path.
 *
 * Pinned here (the review's acceptance conditions):
 *   - workspace activation strictly PRECEDES session:create;
 *   - on success the message is dispatched and the run starts;
 *   - activation/create failure sends NOTHING, surfaces an accurate notice
 *     (no silent fallback-root degrade) AND preserves the composer input;
 *   - the input is cleared exactly once, only at dispatch time;
 *   - an existing session skips workspace/create entirely;
 *   - create keeps its checkpoint-first / fail-abort contract (null = abort).
 */

import { describe, expect, it } from 'vitest';

import { runSubmit, type SubmitFlowIo } from '../src/renderer/src/session/submit-flow';
import { ensureWorkspaceActive } from '../src/renderer/src/session/session-transition';

interface Recorded {
  calls: string[];
  blocked: string[];
  sendFailed: string[];
  activated: string[];
  createdModels: unknown[];
  clearInputCount: number;
  sendResult: { ok: boolean; error?: string };
  createResult: unknown; // ChatModel | null
}

/**
 * Build the IO plus a composer-input model wired exactly like WorkspacePage:
 * `input` is the state behind `<textarea value={input}>`, and `clearInput` is
 * the ONLY mutation the flow is allowed to make of it.
 */
function makeIo(
  over: Partial<Recorded> & { workspaceRoot?: string | null; hasSession?: boolean } = {}
): SubmitFlowIo & { recorded: Recorded; input: string } {
  const recorded: Recorded = {
    calls: [],
    blocked: [],
    sendFailed: [],
    activated: [],
    createdModels: [],
    clearInputCount: 0,
    sendResult: { ok: true },
    createResult: { items: [], phase: 'idle', changes: [] },
    ...over
  };
  const root = 'workspaceRoot' in over ? (over.workspaceRoot ?? null) : '/tmp/demo/project';
  const hasSession = over.hasSession ?? false;
  // The composer input state, starting with the message being submitted.
  let input = '原始待发送消息';
  return {
    recorded,
    get input(): string {
      return input;
    },
    workspaceRoot: () => root,
    hasActiveSession: () => hasSession,
    activateWorkspace: async (path: string) => {
      recorded.calls.push(`activate:${path}`);
      return { ok: true, path };
    },
    createSession: async (title: string) => {
      recorded.calls.push(`create:${title}`);
      const model = recorded.createResult;
      if (model !== null) recorded.createdModels.push(model);
      return model as never;
    },
    clearInput: () => {
      recorded.calls.push('clearInput');
      recorded.clearInputCount += 1;
      input = '';
    },
    sendMessage: async (text: string) => {
      recorded.calls.push(`send:${text}`);
      return recorded.sendResult;
    },
    onWorkspaceActivated: (path: string) => {
      recorded.calls.push('onWorkspaceActivated');
      recorded.activated.push(path);
    },
    onSessionCreated: (_model: never) => {
      recorded.calls.push('onSessionCreated');
    },
    onBlocked: (notice: string) => {
      recorded.calls.push('onBlocked');
      recorded.blocked.push(notice);
    },
    onSendFailed: (error?: string) => {
      recorded.sendFailed.push(error ?? '');
    }
  };
}

describe('runSubmit — workspace activation precedes session:create', () => {
  it('activates the workspace, creates the session, then sends (first message)', async () => {
    const io = makeIo({ workspaceRoot: '/tmp/demo/project' });
    const outcome = await runSubmit(io, '帮我修复登录页的 bug');

    expect(outcome).toEqual({ status: 'dispatched', delivered: true });
    // The review's core ordering assertion: 激活 → create → 清空输入 → send.
    expect(io.recorded.calls).toEqual([
      'activate:/tmp/demo/project',
      'onWorkspaceActivated',
      'create:帮我修复登录页的 bug',
      'onSessionCreated',
      'clearInput',
      'send:帮我修复登录页的 bug'
    ]);
    expect(io.recorded.blocked).toHaveLength(0);
    // Dispatched ⇒ the composer is cleared exactly once.
    expect(io.input).toBe('');
    expect(io.recorded.clearInputCount).toBe(1);
  });

  it('skips workspace/create entirely when a session already exists', async () => {
    const io = makeIo({ hasSession: true });
    const outcome = await runSubmit(io, '第二条消息');

    expect(outcome).toEqual({ status: 'dispatched', delivered: true });
    expect(io.recorded.calls).toEqual(['clearInput', 'send:第二条消息']);
    expect(io.input).toBe('');
  });
});

describe('runSubmit — blocked paths send nothing AND preserve the composer input', () => {
  it('no workspace context at all: no activation, no create, no send, input kept', async () => {
    const io = makeIo({ workspaceRoot: null });
    const outcome = await runSubmit(io, '任何消息');

    expect(outcome).toEqual({ status: 'blocked' });
    expect(io.recorded.calls).toEqual(['onBlocked']);
    expect(io.recorded.blocked).toEqual(['未打开工作区']);
    // The regression the review caught: the input must still hold the message.
    expect(io.input).toBe('原始待发送消息');
    expect(io.recorded.clearInputCount).toBe(0);
  });

  it('workspace activation failed: create and send never run, input kept', async () => {
    const io = makeIo({ workspaceRoot: '/tmp/gone' });
    io.activateWorkspace = async (path: string) => {
      io.recorded.calls.push(`activate:${path}`);
      return { ok: false, error: '目录不存在' };
    };
    const outcome = await runSubmit(io, '消息');

    expect(outcome).toEqual({ status: 'blocked' });
    expect(io.recorded.calls).toEqual(['activate:/tmp/gone', 'onBlocked']);
    expect(io.recorded.blocked).toEqual(['目录不存在']);
    expect(io.recorded.createdModels).toHaveLength(0);
    expect(io.input).toBe('原始待发送消息');
    expect(io.recorded.clearInputCount).toBe(0);
  });

  it('session create aborted (null): the message is NOT sent and the input is kept', async () => {
    const io = makeIo({ createResult: null });
    const outcome = await runSubmit(io, '消息');

    expect(outcome).toEqual({ status: 'blocked' });
    // Activation succeeded, creation was attempted and aborted by the hook's
    // own checkpoint-first semantics — the notice came from there, the send
    // must not happen, and the composer must still hold the message.
    expect(io.recorded.calls).toEqual([
      'activate:/tmp/demo/project',
      'onWorkspaceActivated',
      'create:消息'
    ]);
    expect(io.input).toBe('原始待发送消息');
    expect(io.recorded.clearInputCount).toBe(0);
  });

  it('run start failure after dispatch: input cleared (pre-existing behavior), error surfaced', async () => {
    const io = makeIo({ sendResult: { ok: false, error: 'runtime not ready' } });
    const outcome = await runSubmit(io, '消息');

    // Dispatched (message on screen) but the run failed — cleared, matching
    // the behavior before this flow existed.
    expect(outcome).toEqual({ status: 'dispatched', delivered: false });
    expect(io.recorded.calls).toEqual([
      'activate:/tmp/demo/project',
      'onWorkspaceActivated',
      'create:消息',
      'onSessionCreated',
      'clearInput',
      'send:消息'
    ]);
    expect(io.input).toBe('');
    expect(io.recorded.sendFailed).toEqual(['runtime not ready']);
  });
});

describe('ensureWorkspaceActive — null/empty guard', () => {
  it('refuses a null or blank workspace root without calling activate', async () => {
    let called = 0;
    const activate = async (): Promise<{ ok: boolean }> => {
      called += 1;
      return { ok: true };
    };
    expect((await ensureWorkspaceActive(null, activate)).ok).toBe(false);
    expect((await ensureWorkspaceActive('   ', activate)).ok).toBe(false);
    expect(called).toBe(0);
  });

  it('passes the root through to activation', async () => {
    const seen: string[] = [];
    const outcome = await ensureWorkspaceActive('/tmp/ws', async (path) => {
      seen.push(path);
      return { ok: true, path };
    });
    expect(outcome).toEqual({ ok: true, path: '/tmp/ws' });
    expect(seen).toEqual(['/tmp/ws']);
  });
});
