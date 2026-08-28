/**
 * Automated responsive-layout regression for #5 (issue DSHA-5).
 *
 * Launched by scripts/measure-responsive.mjs with DSH_RESPONSIVE_MEASURE=1
 * (Electron under Xvfb). The main process resizes the real window through
 * three mandatory sizes — 500×400, 700×500, 1280×800 — and drives the REAL
 * renderer UI (no synthetic layout):
 *
 *   launch A (approvalFlow=false) — per size:
 *     idle probe + sidebar drawer open/close (focus + Esc + backdrop-free
 *     keyboard path) → send a long message → running probe ("停止") → click
 *     stop → awaiting_cancel probe captured via MutationObserver ("停止中…")
 *     → wait back to idle.
 *   launch B (approvalFlow=true, STUB_APPROVAL_FLOW=1) — per size:
 *     run until approval_required → probe the modal: no page-level overflow,
 *     Reject fully in viewport (sticky action row), focusable, long command
 *     scrolling internally → reject → wait idle.
 *
 * Every probe records element bounds into docs/responsive/responsive-
 * report.json and each state is captured as a PNG screenshot next to it.
 * Throws on the first failed assertion; index.ts turns that into exit code 1.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { BrowserWindow } from 'electron';

import type { RuntimeClient } from './runtime/runtime-client';

const SIZES: Array<[number, number]> = [
  [500, 400],
  [700, 500],
  [1280, 800]
];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PrimaryProbe {
  innerW: number;
  innerH: number;
  scrollW: number;
  bodyScrollW: number;
  clientW: number;
  text: string;
  disabled: boolean;
  rect: Rect;
  fullyInViewport: boolean;
  focusable: boolean;
}

/** Renderer-side probe: page overflow + primary composer button geometry. */
const PROBE_PRIMARY = `(() => {
  const de = document.documentElement;
  const btn = document.querySelector('.composer .btn');
  if (!btn) return { error: 'primary button not found' };
  const r = btn.getBoundingClientRect();
  btn.focus();
  return {
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    scrollW: Math.max(de.scrollWidth, document.body.scrollWidth),
    bodyScrollW: document.body.scrollWidth,
    clientW: de.clientWidth,
    text: (btn.textContent || '').trim(),
    disabled: btn.disabled,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    fullyInViewport:
      r.width > 0 && r.height > 0 &&
      r.left >= -0.5 && r.top >= -0.5 &&
      r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
    focusable: document.activeElement === btn
  };
})()`;

const CLICK_PRIMARY = `(() => {
  const btn = document.querySelector('.composer .btn');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const SEND_LONG_MESSAGE = `(() => {
  const ta = document.querySelector('.composer-input');
  if (!ta || ta.disabled) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  set.call(
    ta,
    ('请完整演示一次任务流程：先给出执行计划，然后读取认证模块文件、运行静态检查工具并输出总结。').repeat(2)
  );
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

/** Install a capture hook that snapshots geometry the moment 停止中 appears. */
const ARM_STOPPING_CAPTURE = `(() => {
  window.__stoppingCapture = null;
  const snapshot = () => {
    const de = document.documentElement;
    const b = document.querySelector('.composer .btn');
    if (!b || !/停止中/.test(b.textContent || '')) return;
    const r = b.getBoundingClientRect();
    btn.focus();
    window.__stoppingCapture = {
      text: (b.textContent || '').trim(),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      fullyInViewport:
        r.width > 0 && r.height > 0 &&
        r.left >= -0.5 && r.top >= -0.5 &&
        r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
      focusable: document.activeElement === b,
      disabled: b.disabled,
      scrollW: Math.max(de.scrollWidth, document.body.scrollWidth),
      innerW: window.innerWidth
    };
    observer.disconnect();
  };
  const btn = document.querySelector('.composer .btn');
  const observer = new MutationObserver(snapshot);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  snapshot();
  return true;
})()`;

const READ_STOPPING_CAPTURE = `window.__stoppingCapture ?? null`;

const PROBE_APPROVAL = `(() => {
  const de = document.documentElement;
  const modal = document.querySelector('.approval-modal');
  const rej = document.querySelector('[data-testid="approval-reject"]');
  const cmd = document.querySelector('[data-testid="approval-command"]');
  if (!modal || !rej) return { error: 'approval modal not found' };
  const r = rej.getBoundingClientRect();
  rej.focus();
  return {
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    scrollW: Math.max(de.scrollWidth, document.body.scrollWidth),
    clientW: de.clientWidth,
    reject: {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      fullyInViewport:
        r.width > 0 && r.height > 0 &&
        r.left >= -0.5 && r.top >= -0.5 &&
        r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
      focusable: document.activeElement === rej
    },
    commandScrollsInternally: cmd ? cmd.scrollHeight > cmd.clientHeight : null,
    commandScrollableStyle: cmd
      ? ['auto', 'scroll', 'clip'].includes(getComputedStyle(cmd).overflowY)
      : null,
    commandContentHeight: cmd ? cmd.scrollHeight : null,
    commandBoxHeight: cmd ? cmd.clientHeight : null,
    commandWithinViewport: (() => {
      if (!cmd) return false;
      const cr = cmd.getBoundingClientRect();
      return cr.bottom <= window.innerHeight + 0.5 && cr.right <= window.innerWidth + 0.5;
    })(),
    modalScrollsInternally: modal.scrollHeight > modal.clientHeight
  };
})()`;

const APPROVAL_REJECT_CLICK = `(() => {
  const rej = document.querySelector('[data-testid="approval-reject"]');
  if (!rej) return false;
  rej.click();
  return true;
})()`;

function drawerScript(side: 'sessions' | 'changes', action: 'open' | 'verify-open' | 'verify-closed'): string {
  if (action === 'open') {
    return `(() => {
      const t = document.querySelector('.sidebar-toggle[data-side="${side}"]');
      if (!t) return { present: false };
      t.click();
      return { present: true };
    })()`;
  }
  if (action === 'verify-open') {
    return `(() => {
      const panel = document.getElementById('${side}-panel');
      const t = document.querySelector('.sidebar-toggle[data-side="${side}"]');
      if (!panel || !t) return { present: false };
      const r = panel.getBoundingClientRect();
      return {
        present: true,
        ariaExpanded: t.getAttribute('aria-expanded') === 'true',
        visible: r.width > 0 && getComputedStyle(panel).visibility !== 'hidden',
        withinViewport:
          r.left >= -0.5 && r.right <= window.innerWidth + 0.5 &&
          r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5,
        focusInsidePanel: panel.contains(document.activeElement)
      };
    })()`;
  }
  return `(() => {
    const panel = document.getElementById('${side}-panel');
    const t = document.querySelector('.sidebar-toggle[data-side="${side}"]');
    if (!panel || !t) return { present: false };
    const r = panel.getBoundingClientRect();
    return {
      present: true,
      offscreenOrHidden:
        getComputedStyle(panel).visibility === 'hidden' ||
        r.right <= 0.5 || r.left >= window.innerWidth - 0.5,
      ariaExpanded: t.getAttribute('aria-expanded') === 'true',
      focusReturnedToToggle: document.activeElement === t
    };
  })()`;
}

class MeasureSession {
  readonly failures: string[] = [];
  readonly report: Array<Record<string, unknown>> = [];

  constructor(
    private readonly win: BrowserWindow,
    private readonly outDir: string
  ) {}

  async exec<T>(expression: string): Promise<T> {
    return (await this.win.webContents.executeJavaScript(expression, true)) as T;
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Let styles/layout settle after a resize or drawer transition. */
  async settle(ms = 350): Promise<void> {
    await this.exec(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    );
    await this.sleep(ms);
  }

  async waitForText(text: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const probe = await this.exec<PrimaryProbe | { error: string }>(PROBE_PRIMARY);
      if ('text' in probe && probe.text.includes(text)) return probe.text;
      await this.sleep(40);
    }
    return null;
  }

  /** The app boots on Home (keep-alive pages); the probes need Workspace. */
  async ensureWorkspaceRoute(): Promise<void> {
    await this.exec(`(() => {
      const btn = [...document.querySelectorAll('.nav-btn')]
        .find((b) => (b.textContent || '').trim() === 'Workspace');
      if (!btn) return false;
      if (btn.getAttribute('aria-current') !== 'page') btn.click();
      return true;
    })()`);
    await this.waitFor(
      `!document.querySelector('.page-workspace')?.hasAttribute('hidden')`,
      'workspace page visible',
      5_000
    );
    await this.waitFor(
      `(() => { const ta = document.querySelector('.composer-input'); return !!ta && !ta.disabled; })()`,
      'composer enabled (runtime ready in renderer)',
      25_000
    );
  }

  async waitFor(exprTruey: string, label: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.exec<unknown>(exprTruey);
      if (value) return;
      await this.sleep(60);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  check(sizeKey: string, scenario: string, condition: boolean, detail: unknown): void {
    if (!condition) this.failures.push(`${sizeKey} ${scenario}: FAILED ${JSON.stringify(detail)}`);
    this.report.push({ size: sizeKey, scenario, ok: condition, detail });
    console.log(
      `[responsive] ${sizeKey} ${scenario}: ${condition ? 'ok' : `FAIL ${JSON.stringify(detail)}`}`
    );
  }

  async screenshot(name: string): Promise<string> {
    const image = await this.win.webContents.capturePage();
    const file = path.join(this.outDir, name);
    await fs.writeFile(file, image.toPNG());
    return file;
  }

  async recordPrimary(sizeKey: string, scenario: string, shot: string): Promise<void> {
    const probe = await this.exec<PrimaryProbe>(PROBE_PRIMARY);
    const noPageOverflow = probe.scrollW <= probe.clientW + 0.5;
    this.check(sizeKey, `${scenario}/no-horizontal-overflow`, noPageOverflow, {
      scrollW: probe.scrollW,
      clientW: probe.clientW,
      bodyScrollW: probe.bodyScrollW
    });
    if (!probe.fullyInViewport) {
      const dump = await this.exec<Record<string, unknown>>(`(() => {
        const rect = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), overflowY: cs.overflowY, minH: cs.minHeight };
        };
        const col = document.querySelector('.col-chat');
        return {
          innerH: window.innerHeight,
          innerW: window.innerWidth,
          docScrollH: document.documentElement.scrollHeight,
          topbar: rect(document.querySelector('.topbar')),
          pageHost: rect(document.querySelector('.page-host')),
          workspace: rect(document.querySelector('.page-workspace')),
          colChat: rect(col),
          children: col ? [...col.children].map((c) => ({ cls: c.className.toString().slice(0, 60), ...rect(c) })) : [],
          chatScrollH: document.querySelector('.chat')?.scrollHeight ?? null,
          chatClientH: document.querySelector('.chat')?.clientHeight ?? null
        };
      })()`);
      console.log(`[responsive] ${sizeKey} ${scenario} LAYOUT DUMP: ${JSON.stringify(dump)}`);
    }
    this.check(sizeKey, `${scenario}/primary-action-in-viewport`, probe.fullyInViewport, probe.rect);
    this.check(
      sizeKey,
      `${scenario}/primary-action-focusable`,
      probe.focusable === !probe.disabled,
      { focusable: probe.focusable, disabled: probe.disabled }
    );
    await this.screenshot(`${shot}-${sizeKey}.png`);
  }
}

async function ensureReady(client: RuntimeClient): Promise<void> {
  if (client.state !== 'ready') {
    // A cancelled/rejected run may have taken the resident stub down; a fresh
    // start is always allowed from stopped/exited/crashed.
    await new Promise((r) => setTimeout(r, 300));
    await client.start();
  }
}

export async function runResponsiveMeasure(
  win: BrowserWindow,
  client: RuntimeClient,
  appRoot: string,
  opts: { approvalFlow: boolean }
): Promise<void> {
  const outDir = path.join(appRoot, 'docs', 'responsive');
  await fs.mkdir(outDir, { recursive: true });
  const session = new MeasureSession(win, outDir);

  await client.start();

  try {
    for (const [w, h] of SIZES) {
      const sizeKey = `${w}x${h}`;
      win.setContentSize(w, h);
      await session.waitFor(
        `window.innerWidth === ${w} && window.innerHeight === ${h}`,
        `viewport ${sizeKey}`,
        5_000
      );
      await session.ensureWorkspaceRoute();
      await session.settle();

      /* ---- idle + drawers ---- */
      const shotPrefix = opts.approvalFlow ? 'approval-flow' : 'workspace';
      await session.recordPrimary(sizeKey, 'idle', `${shotPrefix}-idle`);

      if (w > 960) {
        /* Wide viewport: three-column layout with permanent side columns —
           no toggles, no backdrop, both panels visible inside the window. */
        const wide = await session.exec<Record<string, unknown>>(`(() => {
          const vis = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              visible: r.width > 0 && getComputedStyle(el).visibility !== 'hidden',
              withinViewport:
                r.left >= -0.5 && r.right <= window.innerWidth + 0.5 &&
                r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5
            };
          };
          return {
            sessions: vis('.col-sessions'),
            changes: vis('.col-changes'),
            toggleCount: document.querySelectorAll('.sidebar-toggle').length,
            backdropCount: document.querySelectorAll('.workspace-drawer-backdrop').length
          };
        })()`);
        session.check(sizeKey, 'wide/three-column-permanent', (wide.sessions as {visible:boolean})?.visible === true && (wide.changes as {visible:boolean})?.visible === true && wide.toggleCount === 0 && wide.backdropCount === 0, wide);
        await session.screenshot(`workspace-wide-${sizeKey}.png`);
      } else {

      for (const side of ['sessions', 'changes'] as const) {
        const opened = await session.exec<{ present: boolean }>(
          drawerScript(side, 'open')
        );
        session.check(sizeKey, `drawer-${side}/toggle-present`, opened.present, opened);
        await session.settle(250);
        const openState = await session.exec<{
          present: boolean;
          ariaExpanded?: boolean;
          visible?: boolean;
          withinViewport?: boolean;
          focusInsidePanel?: boolean;
        }>(drawerScript(side, 'verify-open'));
        session.check(sizeKey, `drawer-${side}/opens-with-expanded-state`, openState.present && openState.ariaExpanded === true && openState.visible === true, openState);
        session.check(sizeKey, `drawer-${side}/within-viewport`, openState.withinViewport === true, openState);
        session.check(
          sizeKey,
          `drawer-${side}/focus-moved-into-panel`,
          openState.focusInsidePanel === true,
          openState
        );
        if (side === 'sessions') {
          // DSHA-7 UI/UE acceptance: the hydration transition indicator must
          // be perceivable inside the narrow-screen sessions drawer. The busy
          // window is transient, so the probe is conditional: WHEN observed it
          // must be within the viewport, role=status, and overflow-free; when
          // the app is not transitioning, the indicator must be ABSENT and the
          // list not aria-busy (the transition always resets — never stuck).
          const hydration = await session.exec<{
            observed: boolean;
            withinViewport?: boolean;
            statusRole?: boolean;
            noOverflow?: boolean;
            notStuck: boolean;
          }>(`(() => {
            const list = document.querySelector('.session-list');
            const el = document.querySelector('.sessions-hydrating');
            if (!el) {
              return { observed: false, notStuck: !(list && list.getAttribute('aria-busy') === 'true') };
            }
            const r = el.getBoundingClientRect();
            return {
              observed: true,
              withinViewport: r.right <= window.innerWidth + 0.5 && r.width > 0 && r.height > 0,
              statusRole: el.getAttribute('role') === 'status',
              noOverflow: el.scrollWidth <= el.clientWidth + 0.5,
              notStuck: true
            };
          })()`);
          session.check(
            sizeKey,
            'drawer-sessions/hydration-indicator',
            hydration.notStuck === true &&
              (!hydration.observed ||
                (hydration.withinViewport === true && hydration.statusRole === true && hydration.noOverflow === true)),
            hydration
          );
        }

        await session.exec(
          `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
        );
        await session.settle(250);
        const closed = await session.exec<{
          present: boolean;
          offscreenOrHidden?: boolean;
          ariaExpanded?: boolean;
          focusReturnedToToggle?: boolean;
        }>(drawerScript(side, 'verify-closed'));
        session.check(
          sizeKey,
          `drawer-${side}/esc-closes-and-focus-returns`,
          closed.present &&
            closed.offscreenOrHidden === true &&
            closed.ariaExpanded === false &&
            closed.focusReturnedToToggle === true,
          closed
        );
      }

      if (opts.approvalFlow) {
        /* ---- approval long-command leg ---- */
        await session.exec<boolean>(SEND_LONG_MESSAGE);
        await session.exec<boolean>(CLICK_PRIMARY);
        if (!(await session.waitForText('停止', 10_000))) {
          throw new Error(`${sizeKey}: runtime did not enter running state`);
        }
        await session.waitFor(
          `!!document.querySelector('.approval-modal')`,
          'approval modal',
          30_000
        );
        await session.settle(200);
        const approval = await session.exec<Record<string, unknown>>(PROBE_APPROVAL);
        const rej = approval.reject as {
          fullyInViewport: boolean;
          focusable: boolean;
          rect: Rect;
        };
        session.check(sizeKey, 'approval/no-horizontal-overflow', (approval.scrollW as number) <= (approval.clientW as number) + 0.5, {
          scrollW: approval.scrollW,
          clientW: approval.clientW
        });
        session.check(sizeKey, 'approval/reject-fully-in-viewport', rej.fullyInViewport, rej.rect);
        session.check(sizeKey, 'approval/reject-focusable', rej.focusable, { focusable: rej.focusable });
        session.check(
          sizeKey,
          'approval/long-command-contained-with-internal-scroll',
          approval.commandScrollableStyle === true &&
            approval.commandWithinViewport === true,
          approval
        );
        if ((approval.commandContentHeight as number) > (approval.commandBoxHeight as number)) {
          session.check(
            sizeKey,
            'approval/overflowing-command-actually-scrolls',
            approval.commandScrollsInternally === true,
            {
              commandScrollsInternally: approval.commandScrollsInternally,
              commandContentHeight: approval.commandContentHeight,
              commandBoxHeight: approval.commandBoxHeight
            }
          );
        }
        await session.screenshot(`approval-${sizeKey}.png`);

        await session.exec<boolean>(APPROVAL_REJECT_CLICK);
        if (!(await session.waitForText('发送', 30_000))) {
          throw new Error(`${sizeKey}: run did not settle after rejection`);
        }
        await ensureReady(client);
        continue;
      }

      }

      /* ---- running ---- */
      const sent = await session.exec<boolean>(SEND_LONG_MESSAGE);
      if (!sent) throw new Error(`${sizeKey}: could not type into composer input`);
      const clicked = await session.exec<boolean>(CLICK_PRIMARY);
      if (!clicked) throw new Error(`${sizeKey}: primary button missing`);
      const typed = await session.exec<{ value: string; disabled: boolean }>(
        `(() => { const ta = document.querySelector('.composer-input'); return { value: ta ? ta.value : null, disabled: ta ? ta.disabled : null }; })()`
      );
      if (!(await session.waitForText('停止', 15_000))) {
        const diag = await session.exec<Record<string, unknown>>(`(() => ({
          btnText: (document.querySelector('.composer .btn')?.textContent || '').trim(),
          btnDisabled: document.querySelector('.composer .btn')?.disabled ?? null,
          inputLen: document.querySelector('.composer-input')?.value.length ?? null,
          chatItems: document.querySelectorAll('.chat-list li, .chat li').length,
          lastChatText: [...document.querySelectorAll('.chat-list li, .chat li')].slice(-1).map((n) => (n.textContent || '').slice(0, 120))[0] ?? null,
          connPill: document.querySelector('.conn-pill')?.textContent?.trim() ?? null,
          statePill: document.querySelector('.pill')?.textContent?.trim() ?? null
        }))()`);
        throw new Error(
          `${sizeKey}: runtime did not enter running state (typed=${JSON.stringify(typed)}, diag=${JSON.stringify(diag)})`
        );
      }
      await session.recordPrimary(sizeKey, 'running', `${shotPrefix}-running`);

      /* ---- awaiting_cancel (captured the moment 停止中 appears) ---- */
      await session.exec<boolean>(ARM_STOPPING_CAPTURE);
      await session.exec<boolean>(CLICK_PRIMARY);
      let stopping: Record<string, unknown> | null = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        stopping = await session.exec<Record<string, unknown> | null>(READ_STOPPING_CAPTURE);
        if (stopping !== null) break;
        await session.sleep(25);
      }
      if (stopping === null) throw new Error(`${sizeKey}: awaiting_cancel state not observed`);
      session.check(sizeKey, 'awaiting_cancel/no-horizontal-overflow', (stopping.scrollW as number) <= (stopping.innerW as number) + 0.5, {
        scrollW: stopping.scrollW,
        innerW: stopping.innerW
      });
      session.check(sizeKey, 'awaiting_cancel/in-viewport', stopping.fullyInViewport === true, stopping.rect);
      // 停止中 is intentionally disabled (double-stop guard); an enabled
      // control must take focus, a disabled one must say so.
      session.check(
        sizeKey,
        'awaiting_cancel/focusable-or-disabled',
        stopping.focusable === !(stopping.disabled as boolean),
        { focusable: stopping.focusable, disabled: stopping.disabled }
      );
      await session.screenshot(`workspace-stopping-${sizeKey}.png`);

      if (!(await session.waitForText('发送', 30_000))) {
        throw new Error(`${sizeKey}: cancel did not settle back to idle`);
      }
      await ensureReady(client);
    }
  } finally {
    await fs.writeFile(
      path.join(outDir, opts.approvalFlow ? 'responsive-report-approval.json' : 'responsive-report.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          approvalFlow: opts.approvalFlow,
          sizes: SIZES.map(([w, h]) => `${w}x${h}`),
          results: session.report,
          failures: session.failures
        },
        null,
        2
      )
    );
  }

  if (session.failures.length > 0) {
    console.error(`[responsive] FAIL — ${session.failures.length} assertion(s) failed`);
    throw new Error(session.failures.join('; '));
  }
  console.log('[responsive] PASS — all responsive assertions verified');
}
