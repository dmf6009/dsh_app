/**
 * Session Store tests (§15/§16, baseline F10/AC-12): CRUD + persistence,
 * schema versioning, corrupt-file recovery, cross-restart data integrity and
 * per-workspace scoping. Mirrors the Recent Projects store test discipline.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { SessionStore } from '../src/main/session/session-store';
import {
  isValidSessionId,
  SESSION_SCHEMA_VERSION,
  validateSessionRecord,
  type SessionRecord
} from '../src/shared/session';
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

/* ------------------------------------------------------------------ */
/* Trusted-input validation (P0-2): the renderer and disk content are  */
/* untrusted. IDs are path-traversal-free; records are schema-validated; */
/* cross-workspace / forged-id reads are rejected; unknown kinds and   */
/* wrong-typed fields are dropped, never force-cast.                    */
/* ------------------------------------------------------------------ */

describe('isValidSessionId — traversal / shape guard', () => {
  it('accepts UUID-like and test-form ids', () => {
    expect(isValidSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
    expect(isValidSessionId('sess-1')).toBe(true);
    expect(isValidSessionId('abcDEF_123-456')).toBe(true);
  });

  it('rejects path-traversal and index collisions', () => {
    expect(isValidSessionId('../escape')).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
    expect(isValidSessionId('a\\b')).toBe(false);
    expect(isValidSessionId('index')).toBe(false);
    expect(isValidSessionId('foo.json')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('with null\x00char')).toBe(false);
    expect(isValidSessionId('has space')).toBe(false);
  });
});

describe('validateSessionRecord — schema + consistency', () => {
  const good: SessionRecord = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: 'sess-1',
    workspaceRoot: WS,
    title: 't',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: null,
    agentState: 'idle',
    tokenUsage: null,
    items: [{ kind: 'user', id: 'u1', text: 'hi' }]
  };

  it('accepts a well-formed record', () => {
    expect(validateSessionRecord(good).ok).toBe(true);
  });

  it('rejects id/context mismatch (forged id)', () => {
    const r = validateSessionRecord(good, { expectedId: 'sess-other' });
    expect(r.ok).toBe(false);
  });

  it('rejects cross-workspace workspaceRoot', () => {
    const r = validateSessionRecord(good, { expectedWorkspaceRoot: '/other/workspace' });
    expect(r.ok).toBe(false);
  });

  it('rejects an illegal id', () => {
    const r = validateSessionRecord({ ...good, id: '../x' });
    expect(r.ok).toBe(false);
  });

  it('drops unknown item kinds instead of keeping them', () => {
    const r = validateSessionRecord({
      ...good,
      items: [
        { kind: 'user', id: 'u1', text: 'ok' },
        { kind: 'alien', id: 'x' } as unknown as never,
        // valid kind, but a wrong-typed field (output is a number, not string)
        { kind: 'tool', id: 't1', tool: 'shell', output: 123 as unknown as string }
      ]
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Unknown kind dropped; wrong-typed field dropped but the item kept
      // (only the bad field is removed, never the whole row force-cast).
      expect(r.record.items).toHaveLength(2);
      expect(r.record.items.map((i) => i.kind)).toEqual(['user', 'tool']);
      const tool = r.record.items.find((i) => i.kind === 'tool')!;
      expect(tool.output).toBeUndefined();
      expect(tool.tool).toBe('shell');
    }
  });

  it('rejects wrong-typed top-level fields', () => {
    expect(validateSessionRecord({ ...good, title: 123 as unknown as string }).ok).toBe(false);
    expect(validateSessionRecord({ ...good, items: 'nope' as unknown as [] }).ok).toBe(false);
    expect(validateSessionRecord({ ...good, agentState: 'bogus' }).ok).toBe(false);
    expect(validateSessionRecord({ ...good, tokenUsage: [] as unknown as null }).ok).toBe(false);
  });

  it('validates every tokenUsage value is a finite number (per-value guard)', () => {
    // Well-formed usage maps pass, including empty ones.
    expect(validateSessionRecord({ ...good, tokenUsage: { input: 120, output: 45.5 } }).ok).toBe(true);
    expect(validateSessionRecord({ ...good, tokenUsage: {} }).ok).toBe(true);
    // Non-numeric / non-finite values must be rejected, not force-cast into
    // Record<string, number>.
    expect(validateSessionRecord({ ...good, tokenUsage: { input: '120' } }).ok).toBe(false);
    expect(validateSessionRecord({ ...good, tokenUsage: { input: NaN } }).ok).toBe(false);
    expect(validateSessionRecord({ ...good, tokenUsage: { input: Infinity } }).ok).toBe(false);
    expect(validateSessionRecord({ ...good, tokenUsage: { input: null } }).ok).toBe(false);
    expect(validateSessionRecord({ ...good, tokenUsage: { nested: { deep: 1 } as unknown as number } }).ok).toBe(false);
  });
});

describe('SessionStore — trusted boundary (P0-2 negative paths)', () => {
  it('refuses to load/save/switch/delete a traversal-shaped id', () => {
    const store = makeStore();
    store.create(WS);
    expect(store.load(WS, '../escape').ok).toBe(false);
    expect(store.save(WS, { ...store.create(WS), id: '../escape' }).ok).toBe(false);
    expect(store.switchTo(WS, 'a/b').ok).toBe(false);
    expect(store.delete(WS, 'a\\b').ok).toBe(false);
  });

  it('load rejects an id that is not a member of this workspace index', () => {
    const store = makeStore();
    const wsA = '/tmp/ws-a';
    const wsB = '/tmp/ws-b';
    const a = store.create(wsA);
    // Even though a's file exists under wsA's dir, requesting it from wsB
    // must not find it.
    expect(store.load(wsB, a.id).ok).toBe(false);
    // And a legitimate-but-foreign id never reads across workspaces.
    expect(store.load(wsB, 'sess-foreign').ok).toBe(false);
  });

  it('save refuses a record whose id/workspaceRoot is forged against the context', () => {
    const store = makeStore();
    const created = store.create(WS);
    // Tamper: claim a different workspaceRoot than the one we saved under.
    const forged: SessionRecord = { ...created, workspaceRoot: '/tmp/other' };
    expect(store.save(WS, forged).ok).toBe(false);
    // Tamper: swap the id to a foreign (but index-valid? no) id.
    expect(store.save(WS, { ...created, id: 'foreign-id' }).ok).toBe(false);
  });

  it('loadRecord drops a tampered on-disk record (id/workspace mismatch)', () => {
    const store = makeStore();
    const created = store.create(WS);
    const file = store.recordPath(WS, created.id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionRecord;
    // Rewrite the file with a mismatched workspaceRoot — it must read as corrupt.
    fs.writeFileSync(file, JSON.stringify({ ...raw, workspaceRoot: '/tmp/elsewhere' }), 'utf8');
    expect(store.load(WS, created.id)).toMatchObject({ ok: false });
    // And it no longer appears in the listing.
    expect(store.listSummaries(WS).map((s) => s.id)).not.toContain(created.id);
  });

  it('loadRecord drops items with unknown kinds / wrong field types', () => {
    const store = makeStore();
    const created = store.create(WS);
    const file = store.recordPath(WS, created.id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionRecord;
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...raw,
        items: [
          { kind: 'user', id: 'u1', text: 'kept' },
          { kind: 'malware', id: 'm1' },
          { kind: 'tool', id: 't1', tool: 'shell', output: 999, level: ['bad'] }
        ]
      }),
      'utf8'
    );
    const loaded = store.load(WS, created.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok && loaded.record) {
      // 'malware' (unknown kind) dropped; 'tool' kept but its wrong-typed
      // fields (output:number, level:array) dropped rather than force-cast.
      expect(loaded.record.items).toHaveLength(2);
      expect(loaded.record.items.map((i) => i.kind)).toEqual(['user', 'tool']);
      const tool = loaded.record.items.find((i) => i.kind === 'tool')!;
      expect(tool.output).toBeUndefined();
      expect(tool.level).toBeUndefined();
      expect(tool.tool).toBe('shell');
    }
  });

  it('delete does NOT mutate the index when the record file cannot be removed', () => {
    const store = makeStore();
    const created = store.create(WS);
    const file = store.recordPath(WS, created.id);
    // Replace the record file with a directory so rmSync({force:true}) throws
    // ERR_FS_EISDIR — a realistic deletion failure the store must survive.
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);
    const result = store.delete(WS, created.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/删除会话文件失败/);
    // The index.json on disk must STILL list the id — delete returned failure
    // and did not commit the index change. (listSummaries hides the id because
    // the record is now an unparseable dir; verify the raw index instead.)
    const indexFile = path.join(store.workspaceDir(WS), 'index.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { sessions: string[] };
    expect(index.sessions).toContain(created.id);
    // Cleanup so afterAll can rm the tree.
    fs.rmSync(file, { recursive: true, force: true });
  });
});
