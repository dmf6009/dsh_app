/**
 * Chat ↔ Session projection round-trip tests (DSHA-7 §15, F10/AC-12).
 *
 * `toSessionItems` / `fromSessionItems` are the pure functions that turn the
 * live ChatModel transcript into the persisted SessionItem form and back. The
 * round-trip must be lossless for the fields worth persisting and must clear
 * streaming flags on reload (a saved session is at rest).
 */

import { describe, expect, it } from 'vitest';

import {
  fromSessionItems,
  INITIAL_MODEL,
  reduceChat,
  toSessionItems,
  type ChatItem
} from '../src/renderer/src/chat/model';
import type { SessionItem } from '../src/shared/session';

function apply(...frames: Parameters<typeof reduceChat>[1][]): ChatItem[] {
  let model = INITIAL_MODEL;
  for (const action of frames) model = reduceChat(model, action);
  return model.items;
}

describe('Session projection round-trip', () => {
  it('preserves user + assistant text and clears streaming on reload', () => {
    const items = apply(
      { type: 'send', text: '修复登录' },
      { type: 'event', frame: { type: 'run_started', v: 1, run_id: 'r1' } },
      { type: 'event', frame: { type: 'message_delta', v: 1, content: '正在' } },
      { type: 'event', frame: { type: 'message_delta', v: 1, content: '分析' } },
      { type: 'event', frame: { type: 'message_completed', v: 1, content: '正在分析' } }
    );
    const persisted = toSessionItems(items);
    const restored = fromSessionItems(persisted);
    expect(restored.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect((restored[0] as { text: string }).text).toBe('修复登录');
    expect((restored[1] as { text: string }).text).toBe('正在分析');
    expect((restored[1] as { streaming: boolean }).streaming).toBe(false);
  });

  it('preserves tool cards with all five elements + terminal form', () => {
    const items = apply(
      { type: 'event', frame: { type: 'run_started', v: 1, run_id: 'r2' } },
      { type: 'event', frame: { type: 'tool_started', v: 1, tool: 'shell', command: 'pytest', tool_call_id: 'tc1' } },
      { type: 'event', frame: { type: 'tool_output', v: 1, tool_call_id: 'tc1', content: '12 passed' } },
      { type: 'event', frame: { type: 'tool_completed', v: 1, tool_call_id: 'tc1', status: 'ok' } }
    );
    const persisted = toSessionItems(items);
    const tool = persisted.find((i) => i.kind === 'tool')!;
    expect(tool).toMatchObject({
      tool: 'shell', command: 'pytest', output: '12 passed\n', status: 'ok', form: 'terminal'
    });
    expect(['L0', 'L1', 'L2']).toContain(tool.level);
    const restored = fromSessionItems(persisted);
    const rt = restored.find((i) => i.kind === 'tool')!;
    expect(rt).toMatchObject({ tool: 'shell', command: 'pytest', output: '12 passed\n', status: 'ok' });
  });

  it('preserves plan, file_read, file_changed, summary and notice', () => {
    const items = apply(
      { type: 'event', frame: { type: 'run_started', v: 1, run_id: 'r3' } },
      { type: 'event', frame: { type: 'plan', v: 1, steps: ['定位', '修复', '测试'] } },
      { type: 'event', frame: { type: 'file_read', v: 1, path: 'src/auth.py', size_bytes: 1024 } },
      { type: 'event', frame: { type: 'file_changed', v: 1, path: 'src/auth.py', change: 'modified' } },
      { type: 'event', frame: { type: 'run_completed', v: 1, summary: '已完成' } },
      { type: 'event', frame: { type: 'error', v: 1, message: 'boom', code: '401' } }
    );
    const persisted = toSessionItems(items);
    // run_started creates a streaming assistant bubble; run_completed fills
    // it with the summary text, so it survives persistence as a content bubble.
    expect(persisted.map((i) => i.kind)).toEqual([
      'assistant', 'plan', 'file_read', 'file_changed', 'summary', 'notice'
    ]);
    const restored = fromSessionItems(persisted);
    const assistant = restored.find((i) => i.kind === 'assistant') as { text: string };
    expect(assistant.text).toBe('已完成');
    const plan = restored.find((i) => i.kind === 'plan') as { steps: string[] };
    expect(plan.steps).toEqual(['定位', '修复', '测试']);
    const fc = restored.find((i) => i.kind === 'file_changed');
    expect(fc).toMatchObject({ path: 'src/auth.py', change: 'modified' });
    const notice = restored.find((i) => i.kind === 'notice');
    expect(notice).toMatchObject({ tone: 'error' });
  });

  it('drops unknown item kinds defensively without throwing', () => {
    const bogus = [{ kind: 'alien', id: 'x' }] as unknown as SessionItem[];
    expect(() => fromSessionItems(bogus)).not.toThrow();
  });
});
