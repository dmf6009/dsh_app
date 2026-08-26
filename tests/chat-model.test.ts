/**
 * Chat model unit tests (DSHA-5 §9 seven forms + AC-11 stop flow).
 *
 * Covers: streaming cursor lifecycle, plan/tool/file/sub-agent forms, level
 * badge derivation parity with the approval engine, changes feed, error
 * code mapping, and the run_cancelled semantics (memo ① unfinished-tool
 * marking + dedupe against late tool_completed(cancelled)).
 */

import { describe, expect, it } from 'vitest';

import type { RuntimeEventFrame } from '../src/shared/protocol/types';
import {
  INITIAL_MODEL,
  describeError,
  reduceChat,
  reduceEvent,
  type ChatModel,
  type ToolCardItem
} from '../src/renderer/src/chat/model';

function ev(partial: Record<string, unknown> & { type: string }): RuntimeEventFrame {
  return { v: 1, ...partial } as unknown as RuntimeEventFrame;
}

function toolCards(model: ChatModel): ToolCardItem[] {
  return model.items.filter((i): i is ToolCardItem => i.kind === 'tool');
}

describe('chat model — streaming text', () => {
  it('opens a streaming bubble on run_started, appends deltas, closes on completed', () => {
    let m = reduceChat(INITIAL_MODEL, { type: 'send', text: '修复登录 500' });
    m = reduceEvent(m, ev({ type: 'run_started', run_id: 'r1' }));
    m = reduceEvent(m, ev({ type: 'message_delta', run_id: 'r1', content: '定位' }));
    m = reduceEvent(m, ev({ type: 'message_delta', run_id: 'r1', content: '问题' }));
    const bubble = m.items.find((i) => i.kind === 'assistant');
    expect(bubble).toMatchObject({ text: '定位问题', streaming: true });
    m = reduceEvent(m, ev({ type: 'message_completed', run_id: 'r1', content: '定位问题并修复' }));
    expect(m.items.find((i) => i.kind === 'assistant')).toMatchObject({
      text: '定位问题并修复',
      streaming: false
    });
    expect(m.phase).toBe('running'); // run still open until a terminal event
  });

  it('done closes the phase and renders the runtime summary card', () => {
    let m = reduceChat(INITIAL_MODEL, { type: 'send', text: 'hi' });
    m = reduceEvent(m, ev({ type: 'run_started', run_id: 'r1' }));
    m = reduceEvent(m, ev({ type: 'done', run_id: 'r1', summary: '全部完成' }));
    expect(m.phase).toBe('idle');
    expect(m.items.at(-1)).toMatchObject({ kind: 'summary', text: '全部完成' });
  });
});

describe('chat model — seven forms', () => {
  it('renders plan, shell terminal form, generic tool card with L badge, file read/changed and sub-agent placeholder', () => {
    let m = reduceChat(INITIAL_MODEL, { type: 'send', text: 'go' });
    m = reduceEvent(m, ev({ type: 'run_started', run_id: 'r' }));
    m = reduceEvent(m, ev({ type: 'plan', run_id: 'r', steps: ['a', 'b'] }));
    // Shell → embedded terminal form; destructive command escalates to L2.
    m = reduceEvent(
      m,
      ev({ type: 'tool_started', run_id: 'r', tool_call_id: 'c1', tool: 'shell', command: 'rm -rf build/' })
    );
    m = reduceEvent(m, ev({ type: 'tool_output', run_id: 'r', tool_call_id: 'c1', content: 'removed' }));
    // Read-only tool → card form at L0.
    m = reduceEvent(m, ev({ type: 'tool_started', run_id: 'r', tool_call_id: 'c2', tool: 'read' }));
    // Sub-agent placeholder.
    m = reduceEvent(
      m,
      ev({ type: 'tool_started', run_id: 'r', tool_call_id: 'c3', tool: 'task', command: '分析依赖' })
    );
    // File forms.
    m = reduceEvent(m, ev({ type: 'file_read', run_id: 'r', path: 'src/a.py', size_bytes: 10 }));
    m = reduceEvent(m, ev({ type: 'file_changed', run_id: 'r', path: 'src/a.py', change: 'modified' }));

    const kinds = m.items.map((i) => i.kind);
    expect(kinds).toContain('plan');
    expect(kinds).toContain('file_read');
    expect(kinds).toContain('file_changed');
    expect(kinds).toContain('subagent');

    const cards = toolCards(m);
    const shell = cards.find((c) => c.toolCallId === 'c1')!;
    expect(shell.form).toBe('terminal');
    expect(shell.level).toBe('L2');
    expect(shell.category).toBe('system');
    expect(shell.output).toContain('removed');
    const read = cards.find((c) => c.toolCallId === 'c2')!;
    expect(read.form).toBe('card');
    expect(read.level).toBe('L0');

    const sub = m.items.find((i) => i.kind === 'subagent')!;
    expect(sub).toMatchObject({ label: '分析依赖', status: 'running' });

    // Changes feed mirrors file_changed only.
    expect(m.changes).toEqual([{ id: expect.any(String), path: 'src/a.py', change: 'modified' }]);
  });
});

describe('chat model — stop flow (AC-11 / memo ①)', () => {
  it('marks unfinished tools cancelled on run_cancelled and shows 已被手动停止', () => {
    let m = reduceChat(INITIAL_MODEL, { type: 'send', text: 'go' });
    m = reduceEvent(m, ev({ type: 'run_started', run_id: 'r' }));
    m = reduceEvent(m, ev({ type: 'tool_started', run_id: 'r', tool_call_id: 'c1', tool: 'shell', command: 'pytest' }));
    m = reduceEvent(m, ev({ type: 'tool_started', run_id: 'r', tool_call_id: 'c2', tool: 'task', command: '子任务' }));

    m = reduceChat(m, { type: 'cancel-requested' });
    expect(m.phase).toBe('awaiting_cancel');

    m = reduceEvent(m, ev({ type: 'run_cancelled', run_id: 'r' }));
    expect(m.phase).toBe('idle');
    const cards = toolCards(m);
    expect(cards.map((c) => c.status)).toEqual(['cancelled']);
    expect(m.items.some((i) => i.kind === 'subagent' && i.status === 'cancelled')).toBe(true);
    expect(m.items.filter((i) => i.kind === 'notice' && i.tone === 'stop')).toHaveLength(1);
  });

  it('absorbs a late tool_completed(cancelled) for an already-marked card (dedupe)', () => {
    let m = reduceChat(INITIAL_MODEL, { type: 'send', text: 'go' });
    m = reduceEvent(m, ev({ type: 'run_started', run_id: 'r' }));
    m = reduceEvent(m, ev({ type: 'tool_started', run_id: 'r', tool_call_id: 'c1', tool: 'shell', command: 'pytest' }));
    m = reduceEvent(m, ev({ type: 'run_cancelled', run_id: 'r' }));
    const before = m.items.length;
    m = reduceEvent(m, ev({ type: 'tool_completed', run_id: 'r', tool_call_id: 'c1', status: 'cancelled' }));
    expect(m.items).toHaveLength(before);
    expect(toolCards(m)[0]!.status).toBe('cancelled');
    // And the reverse order also ends with exactly one stop notice.
    let n = reduceChat(INITIAL_MODEL, { type: 'send', text: 'go' });
    n = reduceEvent(n, ev({ type: 'run_started', run_id: 'r' }));
    n = reduceEvent(n, ev({ type: 'tool_started', run_id: 'r', tool_call_id: 'x', tool: 'shell', command: 'ls' }));
    n = reduceEvent(n, ev({ type: 'tool_completed', run_id: 'r', tool_call_id: 'x', status: 'cancelled' }));
    n = reduceEvent(n, ev({ type: 'run_cancelled', run_id: 'r' }));
    expect(toolCards(n)[0]!.status).toBe('cancelled');
    expect(n.items.filter((i) => i.kind === 'notice' && i.tone === 'stop')).toHaveLength(1);
  });

  it('cancel failure returns the pump to running with an error notice', () => {
    let m = reduceChat(INITIAL_MODEL, { type: 'send', text: 'go' });
    m = reduceEvent(m, ev({ type: 'run_started', run_id: 'r' }));
    m = reduceChat(m, { type: 'cancel-requested' });
    m = reduceChat(m, { type: 'cancel-failed', error: 'no active run' });
    expect(m.phase).toBe('running');
    expect(m.items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' });
  });

  it('approval round trips through awaiting_approval and back to running', () => {
    let m = reduceChat(INITIAL_MODEL, { type: 'send', text: 'go' });
    m = reduceEvent(m, ev({ type: 'run_started', run_id: 'r' }));
    m = reduceChat(m, { type: 'approval-opened', payload: {} as never });
    expect(m.phase).toBe('awaiting_approval');
    m = reduceChat(m, { type: 'approval-resolved', decision: 'allow' });
    expect(m.phase).toBe('running');
  });
});

describe('chat model — provider errors', () => {
  it('maps 401/404/429 to actionable copy and keeps other codes raw', () => {
    expect(describeError('bad key', 401)).toContain('API Key 无效或未配置（401）');
    expect(describeError('no such model', '404')).toContain('模型或接口不存在（404）');
    expect(describeError('slow down', '429')).toContain('请求过于频繁，请稍后重试（429）');
    expect(describeError('boom', 'EPIPE')).toBe('boom [EPIPE]');
    expect(describeError('boom')).toBe('boom');
  });

  it('a non-recoverable error ends the run phase; recoverable ones keep it', () => {
    let m = reduceChat(INITIAL_MODEL, { type: 'send', text: 'go' });
    m = reduceEvent(m, ev({ type: 'run_started', run_id: 'r' }));
    m = reduceEvent(m, ev({ type: 'error', run_id: 'r', message: '临时失败', recoverable: true }));
    expect(m.phase).toBe('running');
    m = reduceEvent(m, ev({ type: 'error', run_id: 'r', message: '致命', code: 401 }));
    expect(m.phase).toBe('idle');
  });
});
