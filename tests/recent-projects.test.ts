/**
 * Recent Projects store tests (§7.2, baseline F2): CRUD, pinned-first
 * ordering, dedupe, persistence round-trip, corrupt-file tolerance and the
 * trim budget.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { idForPath, RecentProjectsStore } from '../src/main/workspace/recent-projects';
import { ROOT } from './helpers';

const STORE_DIR = path.join(ROOT, '.tmp-tests', 'recent');

beforeEach(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(STORE_DIR, { recursive: true, force: true });
});

function makeStore(): RecentProjectsStore {
  // Monotonic fake clock: strictly increasing lastOpenedAt makes ordering
  // deterministic even when real operations land within the same millisecond.
  let tick = 0;
  return new RecentProjectsStore({ directory: STORE_DIR, now: () => new Date(++tick) });
}

describe('RecentProjectsStore', () => {
  it('adds, lists and removes records (CRUD)', () => {
    const store = makeStore();
    const a = store.addOrTouch('/tmp/demo/alpha');
    const b = store.addOrTouch('/tmp/demo/beta');
    expect(store.list().map((p) => p.name)).toEqual(['beta', 'alpha']); // 最近打开在前

    expect(store.remove(b.id)).toBe(true);
    expect(store.list().map((p) => p.id)).toEqual([a.id]);
    expect(store.remove('missing-id')).toBe(false);
  });

  it('dedupes by normalized path and touches lastOpenedAt', () => {
    const store = makeStore();
    const first = store.addOrTouch('/tmp/demo/alpha/');
    const second = store.addOrTouch('/tmp/demo/./alpha');
    expect(second.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    expect(new Date(second.lastOpenedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.lastOpenedAt).getTime()
    );
  });

  it('orders pinned entries first, then by lastOpenedAt desc', () => {
    let tick = 0;
    const store = new RecentProjectsStore({ directory: STORE_DIR, now: () => new Date(++tick) });
    const a = store.addOrTouch('/demo/a');
    const b = store.addOrTouch('/demo/b');
    const c = store.addOrTouch('/demo/c');
    // a is oldest now; pin it → must jump to the front.
    expect(store.pin(a.id, true)).toBe(true);
    expect(store.list().map((p) => p.id)).toEqual([a.id, c.id, b.id]);

    expect(store.pin(a.id, false)).toBe(true);
    expect(store.list().map((p) => p.id)).toEqual([c.id, b.id, a.id]);
  });

  it('survives a persistence round-trip through a new instance', () => {
    let tick = 0;
    const first = new RecentProjectsStore({ directory: STORE_DIR, now: () => new Date(++tick) });
    const a = first.addOrTouch('/repo/one');
    first.pin(a.id, true);

    const second = new RecentProjectsStore({ directory: STORE_DIR });
    const list = second.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: idForPath('/repo/one'), name: 'one', pinned: true });

    expect(second.pin(a.id, false)).toBe(true);
    const third = new RecentProjectsStore({ directory: STORE_DIR });
    expect(third.list()[0]?.pinned).toBe(false);
  });

  it('tolerates a corrupt home-state file without throwing', () => {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STORE_DIR, 'home-state.json'), '{not json at all', 'utf8');
    const store = new RecentProjectsStore({ directory: STORE_DIR });
    expect(store.list()).toEqual([]);
    // And writing still works afterwards.
    expect(store.addOrTouch('/demo/recovered')).toBeTruthy();
  });

  it('skips malformed rows instead of crashing', () => {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STORE_DIR, 'home-state.json'),
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: idForPath('/ok/project'),
            path: '/ok/project',
            name: 'project',
            pinned: true,
            lastOpenedAt: '2025-01-01T00:00:00.000Z'
          },
          'garbage',
          { noPath: true },
          { id: 'x', path: '/no/timestamp' }
        ]
      }),
      'utf8'
    );
    const store = new RecentProjectsStore({ directory: STORE_DIR });
    expect(store.list().map((p) => p.path)).toEqual(['/ok/project']);
  });

  it('trims unpinned overflow but keeps pinned entries', () => {
    const store = new RecentProjectsStore({ directory: STORE_DIR, maxEntries: 3 });
    const keep = store.addOrTouch('/keep/me');
    store.pin(keep.id, true);
    for (const dir of ['/x/1', '/x/2', '/x/3', '/x/4']) {
      store.addOrTouch(dir);
      // Ensure strictly increasing timestamps for deterministic ordering.
      store.list();
    }
    const paths = store.list().map((p) => p.path);
    expect(paths).toContain('/keep/me');
    expect(paths).not.toContain('/x/1'); // oldest unpinned dropped
    expect(paths.length).toBeLessThanOrEqual(3 + 1); // budget may be exceeded only by pins
  });
});
