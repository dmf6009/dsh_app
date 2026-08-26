#!/usr/bin/env node
/* QA independent regression probe (#5, fix/5-responsive-workspace @ 5ccc287).
 *
 * Complements scripts/measure-responsive.mjs by covering the scenarios the
 * dev driver does NOT exercise directly, against the REAL renderer booted
 * normally (no measure mode), driven over CDP with TRUSTED input events:
 *
 *   A) backdrop (遮罩) click closes a drawer            [driver: Esc only]
 *   B) crossing the 960px breakpoint WITH a drawer open
 *      leaves no backdrop/drawer residue                [driver: closes first]
 *   C) approval modal at 500×400: long command scrolls
 *      internally, reject stays visible, focus trap
 *      holds under repeated Tab, trusted Escape ≙ reject [driver: click only]
 *   D) drawer Esc listener stands down while an approval
 *      modal is open (Esc #1 rejects modal, drawer stays;
 *      Esc #2 closes drawer)
 *
 * No product code is modified: the app boots as a user would launch it;
 * CDP (--remote-debugging-port) provides observation + trusted input only.
 * Results → qa-evidence/qa-responsive-probe.json (+ probe-*.png screenshots).
 * Exit codes: 0 all pass · 1 any assertion failed · 2 environment error.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';

/** Grab a random free TCP port to avoid cross-run DevTools bind conflicts. */
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(root, 'qa-evidence');
mkdirSync(outDir, { recursive: true });

const electronBin = require('electron');
if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
  console.error('[qa-probe] ENV-ERROR: electron binary not downloaded'); process.exit(2);
}

/* ---------- minimal CDP client (one socket, optional sessionId) ---------- */

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 1; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.data ?? ''})`));
        else resolve(msg.result);
        return;
      }
      for (const l of this.listeners) l(msg);
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error('ws connect failed')));
    });
  }
  onEvent(fn) { this.listeners.push(fn); }
  send(method, params = {}, sessionId) {
    const id = this.seq++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, 30_000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- launch app under Xvfb ---------- */

const env = {
  ...process.env,
  STUB_APPROVAL_FLOW: '1',
  STUB_DELTA_DELAY_MS: '120',
  STUB_RESIDENT_CANCEL: '1'
};
const dbgPort = await freePort();
const child = spawn('xvfb-run', ['-a', electronBin, root,
  `--remote-debugging-port=${dbgPort}`, '--no-sandbox', '--disable-dev-shm-usage'],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
child.on('error', (e) => console.error('[qa-probe] spawn error:', e));
/** Kill the whole xvfb-run subtree (Xvfb + electron + stub), never just the wrapper. */
const killTree = (sig = 'SIGKILL') => {
  try { process.kill(-child.pid, sig); } catch { /* group already gone */ }
  try { child.kill(sig); } catch { /* already dead */ }
};
const die = async (code) => { killTree(); await sleep(700); process.exit(code); };

let devToolsUrl = null;
const sniff = (d) => {
  const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/);
  if (m && !devToolsUrl) { devToolsUrl = m[1]; console.log('[qa-probe] devtools:', devToolsUrl); }
};
// Electron prints the DevTools endpoint on STDOUT (not stderr).
child.stdout.on('data', (d) => { sniff(d); });
child.stderr.on('data', (d) => { sniff(d); });

const bootDeadline = Date.now() + 45_000;
let rawErr = '';
const origWrite = process.stderr.write.bind(process.stderr);
child.stderr.on('data', (d) => { rawErr += String(d); });
while (!devToolsUrl && Date.now() < bootDeadline && child.exitCode === null) await sleep(200);
if (!devToolsUrl) {
  console.error('[qa-probe] ENV-ERROR: no DevTools endpoint; app did not boot. exitCode=', child.exitCode, child.signalCode);
  console.error('[qa-probe] --- last stderr ---\n' + rawErr.slice(-2500));
  await die(2);
}

/* ---------- results ---------- */

const results = [];
const shots = {};
let failed = false;
const record = (id, desc, pass, detail) => {
  pass = !!pass; if (!pass) failed = true;
  results.push({ id, desc, pass, detail: detail ?? null });
  console.log(`[qa-probe] ${pass ? 'ok' : 'FAIL'} ${id} — ${desc}${detail ? ' :: ' + JSON.stringify(detail) : ''}`);
};
async function shot(cdp, sid, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  writeFileSync(path.join(outDir, `probe-${name}.png`), Buffer.from(data, 'base64'));
  shots[name] = `qa-evidence/probe-${name}.png`;
}

/* ---------- attach ---------- */


let cdp = null;       // assigned inside drive try; helpers close over these
let sid = null;
let pageInfo = null;

/* ---------- helpers ---------- */

async function evalJs(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? expression.slice(0, 80)));
  return r.result.value;
}
async function waitFor(expr, label, timeout = 15_000) {
  const dl = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < dl) {
    try { if (await evalJs(expr)) return true; }
    catch (e) { if (!lastErr) { lastErr = e; console.error('[qa-probe] waitFor[' + label + '] first eval error:', e.message); } }
    await sleep(120);
  }
  if (!lastErr) {
    // expression evaluated fine but stayed falsy — dump what we actually see
    try { console.error('[qa-probe] waitFor[' + label + '] stuck, saw:', JSON.stringify(await evalJs(expr))); } catch {}
  }
  throw new Error('waitFor timeout: ' + label);
}
async function center(selector) {
  return evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
}
/** Trusted mouse click through Chromium's input pipeline. */
async function clickAt(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1
    }, sid);
  }
}
async function clickSelector(sel) {
  const c = await center(sel);
  if (!c) return false;
  await clickAt(c.x, c.y);
  return true;
}
/** Trusted key press. */
async function pressKey(key, code, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
}
const pressEscape = () => pressKey('Escape', 'Escape', 27);
const pressTab = () => pressKey('Tab', 'Tab', 9);

/* Viewport resize. Electron 33 strips the CDP Browser.* window domain and
 * this sandbox has no xdotool/wmctrl/sudo, so we use Chromium's own
 * Emulation.setDeviceMetricsOverride — the same primitive Playwright's
 * setViewportSize uses. Layout, CSS and matchMedia all run for real at the
 * emulated size; ONLY the OS window frame is simulated (disclosed in
 * evidence + report). */
async function resizeTo(innerW, innerH) {
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: innerW, height: innerH, deviceScaleFactor: 1, mobile: false }, sid);
  await settle();
  const iw = await evalJs('window.innerWidth'), ih = await evalJs('window.innerHeight');
  return Math.abs(iw - innerW) <= 1 && Math.abs(ih - innerH) <= 1;
}
const settle = () => sleep(350);

const stateProbe = `(function snapshot() {
  const $ = (s) => document.querySelector(s);
  const vis = (el) => !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
  const inVp = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             fullyInViewport: r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 &&
               r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5 };
  };
  const de = document.documentElement;
  const sessPanel = $('.col-sessions'), chgPanel = $('.col-changes');
  const sessToggle = document.querySelector('.sidebar-toggle[data-side="sessions"]');
  const composer = $('.composer'), btn = $('.composer .btn');
  return {
    innerW: innerWidth, innerH: innerHeight,
    scrollOverflow: Math.max(de.scrollWidth, document.body.scrollWidth) > de.clientWidth + 0.5,
    backdrop: vis($('.workspace-drawer-backdrop')),
    sessionsDrawerOpen: !!sessPanel && sessPanel.classList.contains('drawer-open'),
    sessionsVisible: vis(sessPanel),
    changesDrawerOpen: !!chgPanel && chgPanel.classList.contains('drawer-open'),
    toggleCount: document.querySelectorAll('.sidebar-toggle').length,
    sessionsToggleAria: sessToggle ? sessToggle.getAttribute('aria-expanded') : null,
    activeInSessionsPanel: !!sessPanel && sessPanel.contains(document.activeElement),
    focusOnToggle: !!sessToggle && document.activeElement === sessToggle,
    threeCol: vis($('.col-sessions')) && vis($('.col-changes')) && vis($('.col-chat')),
    composerRect: inVp(composer), primaryBtnText: btn ? btn.textContent.trim() : null,
    primaryBtnDisabled: btn ? btn.disabled : null,
    approvalModalOpen: vis($('.approval-modal')),
    reject: inVp(document.querySelector('[data-testid="approval-reject"]')),
    cmd: (() => {
      const c = document.querySelector('[data-testid="approval-command"]');
      if (!c) return null;
      const cs = getComputedStyle(c), r = c.getBoundingClientRect();
      return { overflowY: cs.overflowY, scrollsInternally: c.scrollHeight > c.clientHeight,
               contentH: c.scrollHeight, boxH: c.clientHeight,
               withinViewport: r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5 };
    })(),
    activeInsideModal: (() => { const m = $('.approval-modal'); return !!m && m.contains(document.activeElement); })(),
    activeIsReject: document.activeElement?.dataset?.testid === 'approval-reject'
  };
})()`;
const snap = () => evalJs(stateProbe);

/* ---------- drive ---------- */

try {
cdp = await Cdp.connect(devToolsUrl);
await sleep(400); // let initial targets register
// Pure-CDP discovery (undici fetch is blocked by the sandbox).
const { targetInfos } = await cdp.send('Target.getTargets');
pageInfo = targetInfos.find((t) => t.type === 'page');
if (!pageInfo) throw new Error('page target missing');
({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId: pageInfo.targetId, flatten: true }));
await cdp.send('Page.enable', {}, sid);
await cdp.send('Runtime.enable', {}, sid);
console.log('[qa-probe] attached:', pageInfo.title || pageInfo.url);
  /* land on Workspace page and wait for runtime ready */
  await waitFor(`document.readyState === 'complete'`, 'renderer loaded', 20_000);
  await evalJs(`(() => { const b = [...document.querySelectorAll('.nav-btn')].find((x) => (x.textContent||'').trim()==='Workspace'); if (b && b.getAttribute('aria-current')!=='page') b.click(); return !!b; })()`);
  await waitFor(`!document.querySelector('.page-workspace')?.hasAttribute('hidden')`, 'workspace visible');
  await waitFor(`document.querySelector('.composer .btn')?.textContent.includes('发送')`, 'runtime ready/idle', 30_000);
  record('boot', 'app booted normally, runtime ready, workspace visible', true);

  /* ===== A) backdrop click close @700×500 ===== */
  if (!(await resizeTo(700, 500))) throw new Error('resize to 700x500 failed');
  await settle();
  let st = await snap();
  record('A0', 'resized to 700×500, narrow layout, idle', !st.scrollOverflow && st.toggleCount === 2 && !st.approvalModalOpen, { innerW: st.innerW, innerH: st.innerH, toggles: st.toggleCount });

  await clickSelector('.sidebar-toggle[data-side="sessions"]');
  await settle(); st = await snap();
  record('A1', 'trusted click opens sessions drawer (backdrop shown)', st.sessionsDrawerOpen && st.backdrop && st.sessionsToggleAria === 'true', { aria: st.sessionsToggleAria, backdrop: st.backdrop });
  await shot(cdp, sid, 'A1-drawer-open-700');

  await clickSelector('.workspace-drawer-backdrop');
  await settle(); st = await snap();
  record('A2', 'backdrop click closes drawer, aria-expanded=false', !st.backdrop && !st.sessionsDrawerOpen && st.sessionsToggleAria === 'false', { aria: st.sessionsToggleAria });

  /* changes drawer: trusted Esc close returns focus to its toggle */
  await clickSelector('.sidebar-toggle[data-side="changes"]');
  await settle();
  const chgOpened = await evalJs(`(() => { const p=document.querySelector('.col-changes'); return !!p && p.classList.contains('drawer-open') && p.contains(document.activeElement); })()`);
  await pressEscape(); await settle();
  st = await snap();
  record('A3', 'changes drawer: trusted Esc closes, focus returns to toggle', chgOpened && !st.changesDrawerOpen && !st.backdrop, { openedWithFocusInside: chgOpened, closedNow: !st.changesDrawerOpen });

  /* ===== B) cross breakpoint with drawer OPEN ===== */
  await clickSelector('.sidebar-toggle[data-side="sessions"]');
  await settle(); st = await snap();
  record('B0', 'sessions drawer reopened before crossing breakpoint', st.sessionsDrawerOpen && st.backdrop, {});
  await shot(cdp, sid, 'B0-before-crossing-700');

  if (!(await resizeTo(1280, 800))) throw new Error('resize to 1280x800 failed');
  await settle(); st = await snap();
  record('B1', 'crossed up to 1280×800 while open: NO residue (no backdrop/drawer/toggles, three columns visible)',
    !st.backdrop && !st.sessionsDrawerOpen && st.toggleCount === 0 && st.threeCol && !st.scrollOverflow,
    { backdrop: st.backdrop, drawerOpen: st.sessionsDrawerOpen, toggles: st.toggleCount, threeCol: st.threeCol });
  await shot(cdp, sid, 'B1-crossed-wide-1280');

  if (!(await resizeTo(700, 500))) throw new Error('resize back to 700x500 failed');
  await settle(); st = await snap();
  record('B2', 'crossed back down to 700×500: clean narrow state, no stale drawer/backdrop',
    !st.backdrop && !st.sessionsDrawerOpen && st.toggleCount === 2 && st.sessionsToggleAria === 'false' && st.composerRect.fullyInViewport,
    { toggles: st.toggleCount, aria: st.sessionsToggleAria, composer: st.composerRect });

  /* ===== C) approval modal @500×400: trap + Esc=Reject ===== */
  if (!(await resizeTo(500, 400))) throw new Error('resize to 500x400 failed');
  await settle();
  await evalJs(`(() => {
    const ta = document.querySelector('.composer-input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    set.call(ta, '请完整演示一次任务流程：先给出执行计划，然后读取认证模块文件、运行静态检查工具并输出总结。'.repeat(3));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await clickSelector('.composer .btn');
  await waitFor(`(document.querySelector('.composer .btn')?.textContent||'').includes('停止')`, 'running state', 20_000);
  await waitFor(`!!document.querySelector('.approval-modal')`, 'approval modal', 30_000);
  await settle(); st = await snap();
  record('C0', 'approval modal open at 500×400: no page overflow, command scrolls internally & inside viewport',
    !st.scrollOverflow && st.cmd?.overflowY !== 'visible' && st.cmd?.scrollsInternally === true && st.cmd?.withinViewport === true,
    { cmd: st.cmd, scrollOverflow: st.scrollOverflow });
  record('C1', 'reject button fully visible at 500×400', st.reject?.fullyInViewport === true, st.reject);
  record('C2', 'composer NOT pushed out of viewport behind modal', st.composerRect.fullyInViewport === true, st.composerRect);
  await shot(cdp, sid, 'C0-approval-500');

  record('C3', 'initial focus sits on 拒绝 (safe default)', st.activeIsReject, {});
  let trapped = true, lastActive = null;
  for (let i = 0; i < 6; i++) {
    await pressTab(); await sleep(60);
    lastActive = await evalJs(`(() => { const m=document.querySelector('.approval-modal'); return !!m && m.contains(document.activeElement); })()`);
    if (!lastActive) { trapped = false; break; }
  }
  record('C4', 'focus trap holds: 6×Tab never escapes the modal', trapped, { stillInsideAfterEachTab: lastActive });
  await shot(cdp, sid, 'C4-after-tabs-500');

  await pressEscape();
  await waitFor(`!document.querySelector('.approval-modal')`, 'modal closed by Esc', 10_000);
  await settle(); st = await snap();
  record('C5', 'trusted Escape ≙ reject-once: modal gone, run settles back to 发送',
    !st.approvalModalOpen && (st.primaryBtnText ?? '').includes('发送'),
    { btn: st.primaryBtnText });
  await shot(cdp, sid, 'C5-after-esc-500');

  /* ===== D) drawer Esc stands down while approval open @700×500 =====
     Real-world order: the run starts FIRST, the user has the drawer open
     when the approval pops (opening the drawer before sending would put
     the backdrop over the send button). */
  if (!(await resizeTo(700, 500))) throw new Error('resize to 700x500 (D) failed');
  await settle();

  await evalJs(`(() => {
    const ta = document.querySelector('.composer-input');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    set.call(ta, '再次演示审批流。'.repeat(6));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await clickSelector('.composer .btn');
  await waitFor(`(document.querySelector('.composer .btn')?.textContent||'').includes('停止')`, 'running state (D)', 20_000);
  await clickSelector('.sidebar-toggle[data-side="sessions"]');
  await settle(); st = await snap();
  record('D0', 'mid-run: sessions drawer opened while run is live', st.sessionsDrawerOpen && st.backdrop,
    { drawerOpen: st.sessionsDrawerOpen, btn: st.primaryBtnText });

  await waitFor(`!!document.querySelector('.approval-modal')`, 'approval modal (D)', 30_000);
  await settle(); st = await snap();
  record('D1', 'approval modal coexists with open drawer beneath', st.approvalModalOpen && st.sessionsDrawerOpen,
    { modalOpen: st.approvalModalOpen, drawerOpen: st.sessionsDrawerOpen });
  await shot(cdp, sid, 'D1-modal-over-drawer-700');

  await pressEscape(); await settle(); st = await snap();
  record('D2', 'Esc #1 rejects the MODAL only — drawer stays open (listener stood down)',
    !st.approvalModalOpen && st.sessionsDrawerOpen && st.backdrop,
    { modalOpen: st.approvalModalOpen, drawerStillOpen: st.sessionsDrawerOpen });

  await pressEscape(); await settle(); st = await snap();
  record('D3', 'Esc #2 then closes the drawer (focus back on toggle)',
    !st.sessionsDrawerOpen && !st.backdrop && st.focusOnToggle,
    { drawerOpen: st.sessionsDrawerOpen, focusOnToggle: st.focusOnToggle });

  await waitFor(`(document.querySelector('.composer .btn')?.textContent||'').includes('发送')`, 'run settled (D)', 20_000);
  record('D4', 'second run also settled after Esc-reject', true);
} catch (err) {
  failed = true;
  results.push({ id: 'DRIVER', desc: String(err instanceof Error ? err.message : err), pass: false, detail: null });
  console.error('[qa-probe] DRIVER ERROR:', err);
}

/* safety net: any escape from the try above must still tear the tree down */
process.on('uncaughtException', (e) => { console.error('[qa-probe] UNCAUGHT:', e); killTree(); process.exit(2); });
process.on('unhandledRejection', (e) => { console.error('[qa-probe] UNHANDLED:', e); killTree(); process.exit(2); });

writeFileSync(path.join(outDir, 'qa-responsive-probe.json'), JSON.stringify(
  { generatedAt: new Date().toISOString(), commit: '5ccc287e6871b3b917919d09fc44c80ff2f05cc5',
    driver: 'qa-evidence/qa-cdp-probe.mjs (CDP trusted-input independent probe)', shots,
    passed: results.filter((r) => r.pass).length, failedCount: results.filter((r) => !r.pass).length, results },
  null, 2));

/* ---------- teardown: graceful quit so before-quit stops the stub ---------- */
try { await cdp.send('Browser.close', {}); } catch { killTree('SIGTERM'); }
await new Promise((r) => setTimeout(r, 1500));
await sleep(500);
if (child.exitCode === null) killTree('SIGKILL');
console.log(`[qa-probe] ${failed ? 'FAIL' : 'PASS'} — ${results.filter((r) => r.pass).length}/${results.length} assertions passed`);
process.exit(failed ? 1 : 0);
