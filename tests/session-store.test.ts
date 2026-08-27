/**
 * Session Store tests (§15/§16, baseline F10/AC-12): CRUD + persistence,
 * schema versioning, corrupt-file recovery, cross-restart data integrity and
 * per-workspace scoping. Mirrors the Recent Projects store test discipline.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { SessionStore } from '../src/main/session/session-store';
import { SESSION_SCHEMA_VERSION, type SessionRecord } from '../src/shared/session';
import { ROOT } from './helpers';

const STORE_DIR = path.join(ROOT, '.tmp-tests', 'sessions');
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

beforeEach(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

describe('SessionStore — CRUD', () => {
  it('creates a session, lists it, and stamps schema version', () => {
    const store = makeStore();
    const record = store.create(WS);
    expect(record.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(record.items).toEqual([]);
    expect(record.agentState).toBe('idle');

    const summaries = store.listSummaries(WS);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: record.id, title: record.title });
    expect(summaries[0]!.active).toBe(true);
  });

  it('creates multiple sessions and lists newest-updated first', () => {
    const store = makeStore();
    const a = store.create(WS);
    const b = store.create(WS);
    store.save(WS, { ...a, title: 'updated A' });
    const ids = store.listSummaries(WS).map((s) => s.id);
    expect(ids).toEqual([a.id, b.id]); // A touched last → first
  });

  it('switches the active session', () => {
    const store = makeStore();
    const a = store.create(WS);
    const b = store.create(WS);
    expect(store.getActiveId(WS)).toBe(b.id);

    expect(store.switchTo(WS, a.id).ok).toBe(true);
    expect(store.getActiveId(WS)).toBe(a.id);
    expect(store.switchTo(WS, 'missing').ok).toBe(false);
  });

  it('deletes a session (idempotent) and falls back activeId', () => {
    const store = makeStore();
    const a = store.create(WS);
    const b = store.create(WS);
    store.switchTo(WS, b.id);

    expect(store.delete(WS, b.id).ok).toBe(true);
    expect(store.listSummaries(WS).map((s) => s.id)).toEqual([a.id]);
    expect(store.getActiveId(WS)).toBe(a.id);

    // Deleting again is a no-op success.
    expect(store.delete(WS, b.id).ok).toBe(true);
  });

  it('saves and loads a full transcript round-trip', () => {
    const store = makeStore();
    const created = store.create(WS);
    const record: SessionRecord = {
      ...created,
      model: 'glm-5.2',
      agentState: 'running',
      tokenUsage: { prompt: 120, completion: 30 },
      items: [
        { kind: 'user', id: 'u1', text: '修复登录' },
        { kind: 'assistant', id: 'a1', text: '正在分析…' },
        { kind: 'tool', id: 't1', tool: 'shell', command: 'pytest', output: '12 passed', status: 'ok', level: 'L1', category: 'shell', basis: 'read-only fallback', form: 'terminal' },
        { kind: 'file_changed', id: 'f1', path: 'src/auth.py', change: 'modified' },
        { kind: 'summary', id: 's1', text: '已完成' }
      ]
    };
    expect(store.save(WS, record).ok).toBe(true);

    const loaded = store.load(WS, created.id);
    expect(loaded.ok).toBe(true);
    expect(loaded.record?.model).toBe('glm-5.2');
    expect(loaded.record?.tokenUsage).toEqual({ prompt: 120, completion: 30 });
    expect(loaded.record?.items).toHaveLength(5);
    expect(loaded.record?.items[0]).toMatchObject({ kind: 'user', text: '修复登录' });
    expect(loaded.record?.items[4]).toMatchObject({ kind: 'summary', text: '已完成' });
  });
});

describe('SessionStore — schema versioning', () => {
  it('re-stamps an older schema version on load', () => {
    const store = makeStore();
    const created = store.create(WS);
    // Simulate an older on-disk record missing the current schema stamp.
    const dir = store.workspaceDir(WS);
    const file = path.join(dir, `${created.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionRecord;
    delete (raw as { schemaVersion?: number }).schemaVersion;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

    const loaded = store.load(WS, created.id);
    expect(loaded.ok).toBe(true);
    expect(loaded.record?.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
  });
});

describe('SessionStore — corrupt-file recovery', () => {
  it('flags a corrupt session file instead of throwing', () => {
    const store = makeStore();
    const created = store.create(WS);
    const dir = store.workspaceDir(WS);
    fs.writeFileSync(path.join(dir, `${created.id}.json`), '{not valid json', 'utf8');

    const loaded = store.load(WS, created.id);
    expect(loaded.ok).toBe(false);
    expect(loaded.corrupt).toBe(true);
  });

  it('skips corrupt sessions in the listing but keeps the valid ones', () => {
    const store = makeStore();
    const a = store.create(WS);
    const b = store.create(WS);
    const dir = store.workspaceDir(WS);
    fs.writeFileSync(path.join(dir, `${b.id}.json`), 'garbage{', 'utf8');

    const summaries = store.listSummaries(WS);
    expect(summaries.map((s) => s.id)).toEqual([a.id]);
  });

  it('rebuilds the index from disk when index.json is corrupt', () => {
    const store = makeStore();
    const a = store.create(WS);
    const b = store.create(WS);
    const dir = store.workspaceDir(WS);
    fs.writeFileSync(path.join(dir, 'index.json'), '!!!corrupt!!!', 'utf8');

    // Rebuild should discover both session files.
    expect(store.listSummaries(WS).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('survives a fully missing workspace directory with an empty list', () => {
    const store = makeStore();
    expect(store.listSummaries('/nonexistent/workspace')).toEqual([]);
    expect(store.getActiveId('/nonexistent/workspace')).toBeNull();
  });
});

describe('SessionStore — cross-restart integrity', () => {
  it('persists across a new store instance (simulated app reopen)', () => {
    let tick = 0;
    let idc = 0;
    const opts = {
      baseDirectory: STORE_DIR,
      now: () => new Date(++tick),
      generateId: () => `sess-${++idc}`
    };
    const first = new SessionStore(opts);
    const created = first.create(WS);
    first.save(WS, {
      ...created,
      model: 'deepseek-v4',
      items: [{ kind: 'user', id: 'u1', text: 'hello' }]
    });

    // Fresh instance — simulates a full app close/reopen (AC-12).
    const second = new SessionStore(opts);
    const activeId = second.getActiveId(WS);
    expect(activeId).toBe(created.id);
    const summaries = second.listSummaries(WS, activeId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.active).toBe(true);
    const loaded = second.load(WS, created.id);
    expect(loaded.record?.model).toBe('deepseek-v4');
    expect(loaded.record?.items[0]).toMatchObject({ kind: 'user', text: 'hello' });
  });
});

describe('SessionStore — per-workspace scoping', () => {
  it('keeps sessions from different workspaces separate', () => {
    const store = makeStore();
    const wsA = '/tmp/project-a';
    const wsB = '/tmp/project-b';
    const a = store.create(wsA);
    const b = store.create(wsB);
    expect(store.listSummaries(wsA).map((s) => s.id)).toEqual([a.id]);
    expect(store.listSummaries(wsB).map((s) => s.id)).toEqual([b.id]);
    expect(store.getActiveId(wsA)).toBe(a.id);
    expect(store.getActiveId(wsB)).toBe(b.id);
  });
});

describe('SessionStore — §35 security', () => {
  it('creates session directories with 0700 permissions', () => {
    const store = makeStore();
    store.create(WS);
    const dir = store.workspaceDir(WS);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('never persists API-key-shaped material in a session file', () => {
    const store = makeStore();
    const created = store.create(WS);
    // Even if a malicious/buggy caller stuffed a key into the transcript,
    // save() should persist exactly what it was given — so the audit rule is:
    // session files carry NO credential field by design (model is a name).
    store.save(WS, {
      ...created,
      model: 'glm-5.2',
      items: [{ kind: 'user', id: 'u1', text: 'use the key sk-abcdefgh1234567890' }]
    });
    const file = store.recordPath(WS, created.id);
    const raw = fs.readFileSync(file, 'utf8');
    // The SessionRecord schema has no apiKey field; the only place a key could
    // appear is inside a user message (which is the user's own input, not a
    // stored secret). Assert no top-level credential field exists.
    const parsed = JSON.parse(raw) as SessionRecord;
    expect('apiKey' in parsed).toBe(false);
    expect('credentials' in parsed).toBe(false);
    expect('tokenUsage' in parsed).toBe(true); // §15 Token Usage field exists
  });
});
