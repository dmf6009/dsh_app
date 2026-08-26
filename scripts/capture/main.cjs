/**
 * Capture harness for the Diff page acceptance evidence (DSHA-6 P1-2).
 *
 * Boots the BUILT renderer in Electron with a stub `window.desktop` (see
 * ./preload.cjs), navigates to the Diff page and captures, at 500x400 /
 * 700x500 / 1280x800, screenshots + element-bounds JSON for the normal /
 * binary / empty states and the Revert Stage-1 / Stage-2 / busy flow.
 *
 * Headless-only evidence (Xvfb): it does NOT substitute for a real-desktop
 * 100%/125% DPI manual walkthrough — that remains an explicit regression
 * boundary (see issue reply). No real runtime, no git, no writes outside
 * docs/acceptance/dsha-6/.
 *
 * Run:  xvfb-run -a node scripts/capture/main.cjs   (or npm run capture:diff)
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'docs', 'acceptance', 'dsha-6');
const INDEX = path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, 'preload.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOUNDS_JS = `(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
  };
  const de = document.documentElement;
  const actionBtns = [...document.querySelectorAll('.diff-actions button')].map((b) => {
    const r = b.getBoundingClientRect();
    return { text: (b.textContent || '').trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const ae = document.activeElement;
  const confirmBtn = [...document.querySelectorAll('.confirm-actions button')].find((b) =>
    (b.textContent || '').includes('确认')
  );
  const dialogEl = document.querySelector('.confirm-dialog');
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    noPageHScroll: de.scrollWidth <= de.clientWidth,
    pageScrollWidth: de.scrollWidth,
    pageClientWidth: de.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    toolbar: rect('.diff-toolbar'),
    fileList: rect('.diff-files'),
    monacoHost: rect('.diff-monaco-host'),
    empty: rect('.diff-empty'),
    dialog: rect('.confirm-dialog'),
    actionBtns,
    activeText: ae ? (ae.textContent || '').trim().slice(0, 40) : null,
    activeClass: ae ? ae.className || null : null,
    activeIsCancel: ae ? ae.hasAttribute && ae.hasAttribute('data-dialog-cancel') : false,
    dialogOpen: !!dialogEl,
    dialogBusy: dialogEl ? dialogEl.getAttribute('aria-busy') === 'true' : false,
    confirmDisabled: confirmBtn ? confirmBtn.disabled : null,
    hasSpinner: !!document.querySelector('.confirm-dialog .spinner')
  };
})()`;

let win = null;
let error = null;

async function shoot({ label, w, h, state, actions, wait }) {
  try {
    // Fresh page per shot so a busy dialog / pending revert from a previous
    // shot can never leak into this one.
    win.webContents.reload();
    await sleep(500);
    win.webContents.send('capture:state', state);
    await win.webContents.executeJavaScript(NAV_DIFF);
    await sleep(350);
    win.setContentSize(w, h, false);
    await sleep(120);
    for (const act of actions || []) {
      await win.webContents.executeJavaScript(act);
      await sleep(180);
    }
    await sleep(wait ?? 900);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${label}.png`), image.toPNG());
    const bounds = await win.webContents.executeJavaScript(BOUNDS_JS);
    fs.writeFileSync(path.join(OUT, `${label}.bounds.json`), JSON.stringify(bounds, null, 2));
    console.log(
      `[capture] ${label} @ ${w}x${h} noPageHScroll=${bounds.noPageHScroll} ` +
        `toolbar=${!!bounds.toolbar} dialog=${bounds.dialogOpen} active="${bounds.activeText || ''}"`
    );
  } catch (err) {
    error = err;
    console.error(`[capture] FAILED ${label}:`, err && err.message ? err.message : err);
  }
}

const SELECT_FIRST = `(() => { document.querySelector('.diff-files .change-btn')?.click(); return true; })()`;
const SELECT_BINARY = `(() => { [...document.querySelectorAll('.diff-files .change-btn')].find(b => (b.textContent||'').includes('logo.bin'))?.click(); return true; })()`;
const OPEN_REVERT = `(() => { const b = [...document.querySelectorAll('.diff-actions button')].find(x => (x.textContent||'').includes('恢复')); b?.focus(); b?.click(); return true; })()`;
const GO_STAGE2 = `(() => { [...document.querySelectorAll('.confirm-actions button')].find(b => (b.textContent||'').includes('继续'))?.click(); return true; })()`;
const GO_CONFIRM = `(() => { [...document.querySelectorAll('.confirm-actions button')].find(b => (b.textContent||'').includes('确认'))?.click(); return true; })()`;
const ESCAPE_TRY = `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`;
const CLICK_BACKDROP = `(() => { document.querySelector('.confirm-backdrop')?.click(); return true; })()`;
const CANCEL_DIALOG = `(() => { [...document.querySelectorAll('.confirm-actions button')].find(b => (b.textContent||'').includes('取消'))?.click(); return true; })()`;
const NAV_DIFF = `(() => { [...document.querySelectorAll('.nav-btn')].find(b => (b.textContent||'').includes('Diff'))?.click(); return true; })()`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      offscreen: false
    }
  });

  await win.loadFile(INDEX);
  await sleep(300);
  await win.webContents.executeJavaScript(NAV_DIFF);
  await sleep(400);

  // Normal diff state across the three required viewports.
  await shoot({ label: 'diff-normal-1280', w: 1280, h: 800, state: { mode: 'normal' }, actions: [SELECT_FIRST] });
  await shoot({ label: 'diff-normal-700', w: 700, h: 500, state: { mode: 'normal' }, actions: [SELECT_FIRST] });
  await shoot({ label: 'diff-normal-500', w: 500, h: 400, state: { mode: 'normal' }, actions: [SELECT_FIRST] });

  // Binary + empty states.
  await shoot({ label: 'diff-binary-1280', w: 1280, h: 800, state: { mode: 'normal' }, actions: [SELECT_BINARY] });
  await shoot({ label: 'diff-empty-1280', w: 1280, h: 800, state: { mode: 'empty' } });

  // Revert two-step + busy flow.
  await shoot({ label: 'revert-stage1-1280', w: 1280, h: 800, state: { mode: 'normal' }, actions: [SELECT_FIRST, OPEN_REVERT] });
  await shoot({ label: 'revert-stage2-1280', w: 1280, h: 800, state: { mode: 'normal' }, actions: [SELECT_FIRST, OPEN_REVERT, GO_STAGE2] });
  await shoot({ label: 'revert-busy-1280', w: 1280, h: 800, state: { mode: 'normal', busyDelayMs: 4000 }, actions: [SELECT_FIRST, OPEN_REVERT, GO_STAGE2, GO_CONFIRM], wait: 400 });
  // While busy, Esc and backdrop click must NOT dismiss the dialog, the confirm
  // button stays disabled with a spinner, and aria-busy is set.
  await shoot({ label: 'revert-busy-guard-1280', w: 1280, h: 800, state: { mode: 'normal', busyDelayMs: 4000 }, actions: [SELECT_FIRST, OPEN_REVERT, GO_STAGE2, GO_CONFIRM, ESCAPE_TRY, CLICK_BACKDROP], wait: 400 });
  // Focus restore after close: cancelling returns focus to the trigger button.
  await shoot({ label: 'revert-cancel-restore-1280', w: 1280, h: 800, state: { mode: 'normal' }, actions: [SELECT_FIRST, OPEN_REVERT, CANCEL_DIALOG], wait: 300 });

  console.log(error ? '[capture] DONE with errors' : '[capture] DONE ok');
  app.exit(error ? 1 : 0);
});
