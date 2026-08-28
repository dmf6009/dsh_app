/**
 * Session transition timing tests (DSHA-7 review round 2, §15/AC-12).
 *
 * These drive the REAL renderer orchestration (`createSessionWithCheckpoint`
 * / `switchSessionWithCheckpoint` from src/renderer/src/session/session-transition.ts
 * — the exact code path useSessionStore's create/switchTo call) with a
 * scripted IO recording call order, instead of mirroring main-process
 * handlers at the store level. The two review blockers pinned here:
 *
 *   1. create/switch must checkpoint the OUTGOING session BEFORE anything
 *      else — a New Session click can never drop unsaved transcript;
 *   2. a failed outgoing checkpoint must ABORT the transition: no create, no
 *      activate, no state mutation, so the unsaved model stays on screen.
 */

import { describe, expect, it } from 'vitest';

import type { SessionRecord } from '../src/shared/session';
import {
  createSessionWithCheckpoint,
  modelFromRecord,
  switchSessionWithCheckpoint,
  type TransitionIo
} from '../src/renderer/src/session/session-transition';

interface Recorded {
  calls: string[];
  created: SessionRecord[]; // records passed to onCreated
  switched: Array<{ id: string; record: SessionRecord | null }>;
  persistError: string | null;
  createResult: { ok: boolean; error?: string };
  createRecord: SessionRecord | null;
  activateResult: { ok: boolean; error?: string };
  loadResult: { ok: boolean; record?: SessionRecord };
}

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 1,
    id: 'sess-1',
    workspaceRoot: '/tmp/demo/project',
    title: 't',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: null,
    agentState: 'idle',
    tokenUsage: null,
    items: [],
    ...over
  };
}

function makeIo(over: Partial<Recorded> = {}): TransitionIo & { recorded: Recorded } {
  const recorded: Recorded = {
    calls: [],
    created: [],
    switched: [],
    persistError: null,
    createResult: { ok: true },
    createRecord: record({ id: 'sess-new', title: '新会话' }),
    activateResult: { ok: true },
    loadResult: { ok: true, record: record({ id: 'sess-2' }) },
    ...over
  };
  return {
    recorded,
    persistOutgoing: async () => {
      recorded.calls.push('persist');
      return recorded.persistError;
    },
    createNew: async (title?: string) => {
      recorded.calls.push(`create:${title ?? ''}`);
      return { result: recorded.createResult, record: recorded.createRecord ?? undefined };
    },
    activate: async (id: string) => {
      recorded.calls.push(`activate:${id}`);
      return recorded.activateResult;
    },
    load: async (id: string) => {
      recorded.calls.push(`load:${id}`);
      return recorded.loadResult;
    },
    onCreated: (rec) => {
      recorded.calls.push('onCreated');
      recorded.created.push(rec);
    },
    onSwitched: (id, rec) => {
      recorded.calls.push('onSwitched');
      recorded.switched.push({ id, record: rec });
    }
  };
}

describe('createSessionWithCheckpoint — 新建会话先保存旧会话', () => {
  it('checkpoints the outgoing session before creating, then applies UI state', async () => {
    const io = makeIo();
    const outcome = await createSessionWithCheckpoint(io, '新标题');

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.model).toEqual({ items: [], phase: 'idle', changes: [] });
    // Ordering: the outgoing persist strictly precedes the create call.
    expect(io.recorded.calls).toEqual(['persist', 'create:新标题', 'onCreated']);
    expect(io.recorded.created).toHaveLength(1);
    expect(io.recorded.created[0]?.id).toBe('sess-new');
  });

  it('ABORTS on a failed outgoing checkpoint: no session is created, nothing mutates', async () => {
    const io = makeIo({ persistError: '保存会话失败：EACCES' });
    const outcome = await createSessionWithCheckpoint(io, '标题');

    expect(outcome).toMatchObject({ status: 'aborted', stage: 'persist' });
    // The review's data-loss path: create was never called.
    expect(io.recorded.calls).toEqual(['persist']);
    expect(io.recorded.created).toHaveLength(0);
  });

  it('aborts (after a successful persist) when the store refuses to create', async () => {
    const io = makeIo({ createResult: { ok: false, error: '未打开工作区' } });
    const outcome = await createSessionWithCheckpoint(io);

    expect(outcome).toMatchObject({ status: 'aborted', stage: 'create', error: '未打开工作区' });
    expect(io.recorded.calls).toEqual(['persist', 'create:']);
    expect(io.recorded.created).toHaveLength(0);
  });
});

describe('switchSessionWithCheckpoint — 切换会话先保存旧会话', () => {
  it('persists outgoing → activates → loads → applies state, and projects the loaded record', async () => {
    const target = record({
      id: 'sess-2',
      items: [
        { kind: 'user', id: 'u1', text: '你好' },
        { kind: 'file_changed', id: 'f1', path: 'src/a.ts', change: 'added' }
      ]
    });
    const io = makeIo({ loadResult: { ok: true, record: target } });
    const outcome = await switchSessionWithCheckpoint(io, 'sess-2');

    expect(outcome.status).toBe('completed');
    expect(io.recorded.calls).toEqual(['persist', 'activate:sess-2', 'load:sess-2', 'onSwitched']);
    expect(io.recorded.switched).toEqual([{ id: 'sess-2', record: target }]);
    if (outcome.status !== 'completed') return;
    // The projected model carries the transcript and the file changes, at rest.
    expect(outcome.model.phase).toBe('idle'); // never auto-resume
    expect(outcome.model.items).toHaveLength(2);
    expect(outcome.model.changes).toEqual([{ id: 'f1', path: 'src/a.ts', change: 'added' }]);
  });

  it('ABORTS on a failed outgoing checkpoint: no activate, no state mutation, model stays null', async () => {
    const io = makeIo({ persistError: '保存会话失败：磁盘已满' });
    const outcome = await switchSessionWithCheckpoint(io, 'sess-2');

    expect(outcome).toMatchObject({ status: 'aborted', stage: 'persist' });
    expect(io.recorded.calls).toEqual(['persist']);
    expect(io.recorded.switched).toHaveLength(0);
    // The hook maps aborted → null, so WorkspacePage keeps the current model.
  });

  it('aborts when the index switch (activate) fails, after a successful outgoing persist', async () => {
    const io = makeIo({ activateResult: { ok: false, error: '会话不存在' } });
    const outcome = await switchSessionWithCheckpoint(io, 'sess-gone');

    expect(outcome).toMatchObject({ status: 'aborted', stage: 'activate', error: '会话不存在' });
    expect(io.recorded.calls).toEqual(['persist', 'activate:sess-gone']);
    expect(io.recorded.switched).toHaveLength(0);
  });

  it('treats a corrupt/missing target record as a completed switch to an empty transcript', async () => {
    const io = makeIo({ loadResult: { ok: false } });
    const outcome = await switchSessionWithCheckpoint(io, 'sess-2');

    expect(outcome.status).toBe('completed');
    expect(io.recorded.switched).toEqual([{ id: 'sess-2', record: null }]);
    if (outcome.status !== 'completed') return;
    expect(outcome.model).toEqual({ items: [], phase: 'idle', changes: [] });
  });
});

describe('modelFromRecord — record projection', () => {
  it('returns the empty at-rest model for absent records', () => {
    expect(modelFromRecord(null)).toEqual({ items: [], phase: 'idle', changes: [] });
    expect(modelFromRecord(undefined)).toEqual({ items: [], phase: 'idle', changes: [] });
  });

  it('maps file_changed items to workspace changes and never resumes a run', () => {
    const model = modelFromRecord(
      record({
        items: [
          { kind: 'file_changed', id: 'f1', path: 'a.ts' }, // no change → modified default
          { kind: 'file_changed', id: 'f2', path: 'b.ts', change: 'deleted' },
          { kind: 'user', id: 'u1', text: 'hi' }
        ],
        agentState: 'running' // even a mid-run snapshot loads at rest
      })
    );
    expect(model.phase).toBe('idle');
    expect(model.changes).toEqual([
      { id: 'f1', path: 'a.ts', change: 'modified' },
      { id: 'f2', path: 'b.ts', change: 'deleted' }
    ]);
    expect(model.items).toHaveLength(3);
  });
});
