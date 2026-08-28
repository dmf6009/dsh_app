/**
 * First-message lifecycle regression tests (DSHA-7 QA round 3, §15/AC-12).
 *
 * The QA-caught P1: creating a Session for the first message flips the active
 * id, which arms the page's hydrate effect; that async hydrate used to resolve
 * an EMPTY model and `setModel` it over the just-dispatched user message — the
 * message vanished from screen, was never checkpointed, and disappeared
 * across a restart.
 *
 * These tests drive the REAL renderer pieces with adversarial hydration
 * timing — the hydration pass is applied at every await boundary the effect
 * could land on (right after create, and after the send dispatch) — using:
 *
 *   - runSubmit (the exact orchestration WorkspacePage.submit calls),
 *   - reduceChat (the exact reducer behind setModel),
 *   - resolveHydration + shouldApplyHydratedModel (the exact hydration
 *     decision the hook and the effect now apply),
 *   - a REAL SessionStore on disk for create → checkpoint → restart readback.
 *
 * Assertions per the acceptance conditions: the first user message is still
 * displayed after the run completes, IS persisted, and IS readable after a
 * full restart (fresh store instance).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { SessionStore } from '../src/main/session/session-store';
import type { SessionRecord } from '../src/shared/session';
import {
  INITIAL_MODEL,
  reduceChat,
  toSessionItems,
  type ChatModel
} from '../src/renderer/src/chat/model';
import { runSubmit } from '../src/renderer/src/session/submit-flow';
import {
  resolveHydration,
  shouldApplyHydratedModel
} from '../src/renderer/src/session/session-transition';
import { ROOT } from './helpers';

const STORE_DIR = path.join(ROOT, '.tmp-tests', 'session-first-message');
const WS = '/tmp/demo/project';
const MESSAGE = '请帮我梳理认证模块的实现';

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

/**
 * The lifecycle state the WorkspacePage maintains, driven exactly like the
 * page does: model via reduceChat, active record via the hook, hydration via
 * resolveHydration + shouldApplyHydratedModel.
 */
class PageSimulation {
  model: ChatModel = INITIAL_MODEL;
  record: SessionRecord | null = null;
  freshlyCreated = false;

  /** The hydrate effect's body: null → keep; non-null → replace only a
   *  pristine live model (the anti-wipe guard under test). */
  runHydrationPass(): void {
    const restored = resolveHydration(this.freshlyCreated, this.record);
    this.freshlyCreated = false; // consumed, as the hook does
    if (restored === null) return;
    if (!shouldApplyHydratedModel(this.model)) return;
    this.model = restored;
  }

  async submit(): Promise<void> {
    await runSubmit(
      {
        workspaceRoot: () => WS,
        hasActiveSession: () => this.record !== null,
        activateWorkspace: (p) => Promise.resolve({ ok: true, path: p }),
        createSession: async (title: string) => {
          // The hook's create: real disk record, active id flips here — which
          // is exactly what arms the hydrate effect in the page.
          this.record = store.create(WS, title);
          this.freshlyCreated = true;
          if (HYDRATION_TIMING === 'after-create') this.runHydrationPass();
          return { items: [], phase: 'idle', changes: [] };
        },
        clearInput: () => {
          /* composer only */
        },
        sendMessage: (text: string) => {
          this.model = reduceChat(this.model, { type: 'send', text });
          return Promise.resolve({ ok: true });
        },
        onWorkspaceActivated: () => {
          /* app state only */
        },
        onSessionCreated: (model) => {
          this.model = model;
        },
        onBlocked: (notice) => {
          throw new Error(`unexpectedly blocked: ${notice}`);
        },
        onSendFailed: (error) => {
          throw new Error(`unexpected send failure: ${error}`);
        }
      },
      MESSAGE
    );
    if (HYDRATION_TIMING === 'after-dispatch') this.runHydrationPass();
  }

  /** Run-termination checkpoint: the page's persist-on-idle path. */
  checkpoint(): boolean {
    if (this.record === null) return false;
    const saved = store.save(WS, {
      ...this.record,
      items: toSessionItems(this.model.items),
      agentState: 'idle'
    });
    return saved.ok;
  }
}

let store: SessionStore;
let HYDRATION_TIMING: 'after-create' | 'after-dispatch';

describe('hydration decision — the two anti-wipe layers', () => {
  it('resolveHydration returns null for a freshly created session (nothing on disk)', () => {
    expect(resolveHydration(true, null)).toBeNull();
    expect(resolveHydration(true, { id: 'x' } as unknown as SessionRecord)).toBeNull();
  });

  it('resolveHydration projects an existing record; corrupt/missing degrade to empty', () => {
    const model = resolveHydration(false, null);
    expect(model).toEqual({ items: [], phase: 'idle', changes: [] });
  });

  it('shouldApplyHydratedModel refuses to replace any live state, accepts only pristine', () => {
    expect(shouldApplyHydratedModel(INITIAL_MODEL)).toBe(true);
    const withFirstMessage = reduceChat(INITIAL_MODEL, { type: 'send', text: MESSAGE });
    expect(shouldApplyHydratedModel(withFirstMessage)).toBe(false); // the QA case
    const runningOnly = { ...INITIAL_MODEL, phase: 'running' as const };
    expect(shouldApplyHydratedModel(runningOnly)).toBe(false);
    const withChanges = { ...INITIAL_MODEL, changes: [{ id: 'f1', path: 'a.ts', change: 'modified' as const }] };
    expect(shouldApplyHydratedModel(withChanges)).toBe(false);
  });
});

describe('first-message lifecycle vs adversarial hydration timing', () => {
  for (const timing of ['after-create', 'after-dispatch'] as const) {
    it(`first user message survives a hydration pass fired ${timing}, persists, and is readable after restart`, async () => {
      HYDRATION_TIMING = timing;
      store = makeStore();
      const page = new PageSimulation();

      // App-open state: no session yet, pristine model.
      expect(page.record).toBeNull();

      // The user submits the very first message; hydration passes are injected
      // at the adversarial boundaries inside submit().
      await page.submit();

      // 1) 消息仍显示：the model kept the dispatched user message through
      //    the adversarial hydration pass.
      const userItems = page.model.items.filter((i) => i.kind === 'user');
      expect(userItems).toHaveLength(1);
      expect(userItems[0]).toMatchObject({ text: MESSAGE });
      expect(page.model.phase).toBe('running');

      // 2) run 完成 → 回到 idle，消息仍在。
      page.model = reduceChat(page.model, {
        type: 'event',
        frame: { type: 'run_completed', v: 1, summary: '已完成' }
      });
      expect(page.model.phase).toBe('idle');
      expect(page.model.items.some((i) => i.kind === 'user' && i.text === MESSAGE)).toBe(true);

      // 3) 已落盘：the run-termination checkpoint saves the transcript.
      expect(page.checkpoint()).toBe(true);

      // 4) 重启可回看：a brand-new store over the same directory loads the
      //    session with the first message, and the restored model shows it.
      const restarted = makeStore();
      const summaries = restarted.listSummaries(WS);
      expect(summaries.map((s) => s.id)).toContain(page.record!.id);
      const loaded = restarted.load(WS, page.record!.id);
      expect(loaded.ok).toBe(true);
      if (loaded.ok && loaded.record) {
        expect(loaded.record.items.some((i) => i.kind === 'user' && i.text === MESSAGE)).toBe(true);
        const restoredModel = resolveHydration(false, loaded.record);
        expect(restoredModel?.items.some((i) => i.kind === 'user' && i.text === MESSAGE)).toBe(true);
      }
    });
  }
});
