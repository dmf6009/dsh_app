/**
 * Persistence-lifecycle integration tests (DSHA-7 review P0-1, §15/§34/AC-12).
 *
 * The renderer checkpoints the active session through a synchronous
 * flush-before-quit/navigation protocol (WorkspacePage flushNow → preload
 * flushBeforeQuit → main `session:flush-before-quit` handler). The handler is
 * a thin shim: validate the untrusted record, then SessionStore.save. These
 * tests pin that whole contract end-to-end at the store level — no Electron
 * IPC harness exists in this project, so `flushBeforeQuit` below mirrors the
 * handler's exact validate-then-save order (src/main/index.ts).
 *
 * Covered paths (the review's 成功 / 失败 / 异常退出前可控 paths):
 *   - navigation/close checkpoint of a conversation that never hit a
 *     run-termination event (the original AC-12 gap), then a full app
 *     "restart" (fresh store over the same directory) reads it back;
 *   - the same checkpoint on session switch (unmount of the old session);
 *   - a forged record (foreign workspaceRoot / traversal id) is rejected and
 *     the previously persisted content is untouched;
 *   - a disk-write failure during flush returns ok=false and leaves the last
 *     good record intact (atomic write never corrupts on failure).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { SessionStore } from '../src/main/session/session-store';
import {
  validateSessionRecord,
  type SessionMutationResult,
  type SessionRecord
} from '../src/shared/session';
import { ROOT } from './helpers';

const STORE_DIR = path.join(ROOT, '.tmp-tests', 'session-flush');
const WS = '/tmp/demo/project';

let idTick = 0;

function makeStore(): SessionStore {
  let tick = 0;
  idTick = 0;
  return new SessionStore({
    baseDirectory: STORE_DIR,
    now: () => new Date(++tick),
    generateId: () => `sess-${++idTick}`
  });
}

/** Mirror of the main-process `session:flush-before-quit` handler body. */
function flushBeforeQuit(store: SessionStore, root: string, record: unknown): SessionMutationResult {
  if (typeof record !== 'object' || record === null) {
    return { ok: false, error: '未打开工作区或会话记录无效' };
  }
  const validated = validateSessionRecord(record, { expectedWorkspaceRoot: root });
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  return store.save(root, validated.record);
}

/** The record the renderer would build for `base` after the user typed `texts`
 *  WITHOUT any run-termination event having fired (the AC-12 gap scenario). */
function withUserTurns(base: SessionRecord, texts: string[]): SessionRecord {
  return {
    ...base,
    items: [
      ...base.items,
      ...texts.map((text, i) => ({ kind: 'user' as const, id: `u-${i}`, text }))
    ]
  };
}

beforeEach(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

describe('flush-before-quit / navigation checkpoint (§15/§34, AC-12)', () => {
  it('checkpoints a conversation that never hit a run-termination event, and a fresh store (app restart) reads it back', () => {
    const store = makeStore();
    const created = store.create(WS);
    // User typed two messages; the run is still idle / never terminated, so
    // the old run-phase-transition trigger would NEVER have fired.
    const live = withUserTurns(created, ['帮我看看这个报错', '日志在 /tmp/log.txt']);

    const flushed = flushBeforeQuit(store, WS, live);
    expect(flushed.ok).toBe(true);

    // "完全关闭应用重开" — a brand-new store instance over the same directory.
    const restarted = makeStore();
    const summaries = restarted.listSummaries(WS);
    expect(summaries.map((s) => s.id)).toContain(created.id);
    const loaded = restarted.load(WS, created.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.record) {
      expect(loaded.record.items.map((i) => (i.kind === 'user' ? i.text : null)))
        .toEqual(['帮我看看这个报错', '日志在 /tmp/log.txt']);
    }
  });

  it('checkpoints the outgoing session on switch (unmount), leaving the incoming session independent', () => {
    const store = makeStore();
    const a = store.create(WS, 'A');
    const b = store.create(WS, 'B');

    // Unsaved work in A; the user switches to B — A must be flushed first.
    const flushed = flushBeforeQuit(store, WS, withUserTurns(a, ['A 的未保存消息']));
    expect(flushed.ok).toBe(true);
    expect(store.switchTo(WS, b.id).ok).toBe(true);

    const restarted = makeStore();
    const loadedA = restarted.load(WS, a.id);
    expect(loadedA.ok).toBe(true);
    if (loadedA.ok && loadedA.record) {
      expect(loadedA.record.items.some((i) => i.kind === 'user' && i.text === 'A 的未保存消息')).toBe(true);
    }
    const loadedB = restarted.load(WS, b.id);
    expect(loadedB.ok).toBe(true);
    if (loadedB.ok && loadedB.record) {
      expect(loadedB.record.items).toHaveLength(0); // B was never polluted by A
    }
  });

  it('is idempotent when unload and before-quit both fire for the same record', () => {
    const store = makeStore();
    const created = store.create(WS);
    const live = withUserTurns(created, ['双触发']);
    expect(flushBeforeQuit(store, WS, live).ok).toBe(true);
    expect(flushBeforeQuit(store, WS, live).ok).toBe(true);
    const reloaded = store.load(WS, created.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok && reloaded.record) {
      expect(reloaded.record.items.filter((i) => i.kind === 'user')).toHaveLength(1);
    }
  });
});

describe('flush failure paths — disk and prior content stay intact', () => {
  it('rejects a forged record (foreign workspaceRoot) and leaves the last good record untouched', () => {
    const store = makeStore();
    const created = store.create(WS);
    // A first, successful checkpoint of real content.
    expect(flushBeforeQuit(store, WS, withUserTurns(created, ['已保存的消息'])).ok).toBe(true);

    // The renderer is untrusted: a tampered flush claims another workspace.
    const forged = { ...withUserTurns(created, ['伪造']), workspaceRoot: '/tmp/other-ws' };
    const result = flushBeforeQuit(store, WS, forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('workspaceRoot');

    // The previously persisted content must still be exactly what landed.
    const loaded = store.load(WS, created.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.record) {
      expect(loaded.record.items.some((i) => i.kind === 'user' && i.text === '已保存的消息')).toBe(true);
      expect(loaded.record.items.some((i) => i.kind === 'user' && i.text === '伪造')).toBe(false);
    }
  });

  it('rejects a traversal-shaped id outright', () => {
    const store = makeStore();
    const created = store.create(WS);
    const evil = { ...created, id: '../escape' } as unknown as SessionRecord;
    expect(flushBeforeQuit(store, WS, evil).ok).toBe(false);
    // No file was created outside the workspace directory.
    expect(fs.existsSync(path.join(STORE_DIR, 'escape.json'))).toBe(false);
  });

  it('returns ok=false when the disk write fails and the last good record is not corrupted', () => {
    const store = makeStore();
    const created = store.create(WS);
    expect(flushBeforeQuit(store, WS, withUserTurns(created, ['第一次保存'])).ok).toBe(true);

    // Make the workspace session directory read-only so the atomic
    // tmp-write fails — the realistic "disk full / permission" flush failure.
    const dir = store.workspaceDir(WS);
    fs.chmodSync(dir, 0o500);
    try {
      const result = flushBeforeQuit(store, WS, withUserTurns(created, ['第二次保存']));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('保存会话失败');
    } finally {
      fs.chmodSync(dir, 0o700);
    }

    // The first save is still intact and loadable — a failed checkpoint must
    // never corrupt or truncate the existing record.
    const loaded = store.load(WS, created.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.record) {
      expect(loaded.record.items.some((i) => i.kind === 'user' && i.text === '第一次保存')).toBe(true);
      expect(loaded.record.items.some((i) => i.kind === 'user' && i.text === '第二次保存')).toBe(false);
    }
    // No half-written tmp files were left behind in the directory.
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});
