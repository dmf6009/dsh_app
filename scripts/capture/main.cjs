/**
 * Capture + hard-assertion harness for the Diff page acceptance evidence
 * (DSHA-6 P1-2 / UI-UE review).
 *
 * Boots the BUILT renderer in Electron with a stub `window.desktop`
 * (./preload.cjs), navigates to the Diff page, and for each scenario captures
 * a screenshot + element-bounds JSON and runs HARD assertions. ANY unmet
 * acceptance requirement is reported per-scene with the field/values and the
 * process exits non-zero (no false-green).
 *
 * Coverage matrix (each at 500x400, 700x500, 1280x800):
 *   normal, binary, empty, Revert Stage-1, Revert Stage-2, Revert busy+guard,
 *   Revert cancel → focus restore.
 *
 * Headless-only evidence (Xvfb): does NOT substitute for a real-desktop
 * 100%/125% DPI manual walkthrough — that stays an explicit regression
 * boundary. No real runtime, no git, no writes outside docs/acceptance/dsha-6/.
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
    diffStatus: !!document.querySelector('.diff-status'),
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

const SELECT_FIRST = `(() => { document.querySelector('.diff-files .change-btn')?.click(); return true; })()`;
const SELECT_BINARY = `(() => { [...document.querySelectorAll('.diff-files .change-btn')].find(b => (b.textContent||'').includes('logo.bin'))?.click(); return true; })()`;
const OPEN_REVERT = `(() => { const b = [...document.querySelectorAll('.diff-actions button')].find(x => (x.textContent||'').includes('恢复')); b?.focus(); b?.click(); return true; })()`;
const GO_STAGE2 = `(() => { [...document.querySelectorAll('.confirm-actions button')].find(b => (b.textContent||'').includes('继续'))?.click(); return true; })()`;
const GO_CONFIRM = `(() => { [...document.querySelectorAll('.confirm-actions button')].find(b => (b.textContent||'').includes('确认'))?.click(); return true; })()`;
const ESCAPE_TRY = `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`;
const CLICK_BACKDROP = `(() => { document.querySelector('.confirm-backdrop')?.click(); return true; })()`;
const CANCEL_DIALOG = `(() => { [...document.querySelectorAll('.confirm-actions button')].find(b => (b.textContent||'').includes('取消'))?.click(); return true; })()`;
const NAV_DIFF = `(() => { [...document.querySelectorAll('.nav-btn')].find(b => (b.textContent||'').includes('Diff'))?.click(); return true; })()`;

let win = null;
const allFailures = [];

function pushFailures(scene, list) {
  for (const f of list) {
    allFailures.push(`[${scene}] ${f}`);
  }
}

function overlapCheck(btns) {
  const out = [];
  for (let i = 0; i < btns.length; i += 1) {
    for (let j = i + 1; j < btns.length; j += 1) {
      const a = btns[i];
      const b = btns[j];
      const intersect =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (intersect) out.push(`${a.text || a.x} ↔ ${b.text || b.x}`);
    }
  }
  return out;
}

async function shoot(scene) {
  const { label, w, h, state, actions, wait, expect: expectFn } = scene;
  try {
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

    const failures = expectFn(bounds);
    pushFailures(label, failures);
    const ok = failures.length === 0;
    console.log(
      `[capture] ${label} @ ${w}x${h} ${ok ? 'PASS' : 'FAIL'} ` +
        `noPageHScroll=${bounds.noPageHScroll} dialog=${bounds.dialogOpen} active="${bounds.activeText || ''}"`
    );
    return ok;
  } catch (err) {
    pushFailures(label, [`harness error: ${err && err.message ? err.message : err}`]);
    console.error(`[capture] FAILED ${label}:`, err && err.message ? err.message : err);
    return false;
  }
}

/* ---- assertion presets ---- */
const noHScroll = (b) =>
  b.noPageHScroll === true ? [] : [`noPageHScroll=false (page=${b.pageScrollWidth} client=${b.pageClientWidth})`];
const toolbarVisible = (b) => (b.toolbar ? [] : ['toolbar not visible']);
const noOverlap = (b) => {
  const ov = overlapCheck(b.actionBtns);
  return ov.length ? [`action buttons overlap: ${ov.join(', ')}`] : [];
};

const V = [
  { w: 500, h: 400, tag: '500' },
  { w: 700, h: 500, tag: '700' },
  { w: 1280, h: 800, tag: '1280' }
];

const scenes = [];
for (const { w, h, tag } of V) {
  scenes.push(
    {
      label: `diff-normal-${tag}`,
      w,
      h,
      state: { mode: 'normal' },
      actions: [SELECT_FIRST],
      expect: (b) => [...noHScroll(b), ...toolbarVisible(b), ...noOverlap(b)]
    },
    {
      label: `diff-binary-${tag}`,
      w,
      h,
      state: { mode: 'normal' },
      actions: [SELECT_BINARY],
      expect: (b) => [
        ...noHScroll(b),
        ...toolbarVisible(b),
        ...(b.diffStatus ? [] : ['binary placeholder (.diff-status) not shown'])
      ]
    },
    {
      label: `diff-empty-${tag}`,
      w,
      h,
      state: { mode: 'empty' },
      expect: (b) => [...noHScroll(b), ...(b.empty ? [] : ['empty state not visible'])]
    },
    {
      label: `revert-stage1-${tag}`,
      w,
      h,
      state: { mode: 'normal' },
      actions: [SELECT_FIRST, OPEN_REVERT],
      expect: (b) => [
        ...noHScroll(b),
        ...toolbarVisible(b),
        ...(b.dialogOpen ? [] : ['dialog not open']),
        ...(b.activeIsCancel ? [] : ['Stage-1 focus not on cancel (active=' + (b.activeText || 'none') + ')'])
      ]
    },
    {
      label: `revert-stage2-${tag}`,
      w,
      h,
      state: { mode: 'normal' },
      actions: [SELECT_FIRST, OPEN_REVERT, GO_STAGE2],
      expect: (b) => [
        ...noHScroll(b),
        ...toolbarVisible(b),
        ...(b.dialogOpen ? [] : ['dialog not open']),
        ...(b.activeIsCancel ? ['Stage-2 focus still on cancel'] : []),
        ...(b.activeText === '确认丢弃我的修改' ? [] : ['Stage-2 focus not on confirm (active=' + (b.activeText || 'none') + ')'])
      ]
    },
    {
      label: `revert-busy-guard-${tag}`,
      w,
      h,
      state: { mode: 'normal', busyDelayMs: 4000 },
      actions: [SELECT_FIRST, OPEN_REVERT, GO_STAGE2, GO_CONFIRM, ESCAPE_TRY, CLICK_BACKDROP],
      wait: 400,
      expect: (b) => [
        ...noHScroll(b),
        ...toolbarVisible(b),
        ...(b.dialogOpen ? [] : ['busy: dialog was dismissed by Esc/backdrop']),
        ...(b.dialogBusy ? [] : ['busy: aria-busy not set']),
        ...(b.confirmDisabled === true ? [] : ['busy: confirm button not disabled']),
        ...(b.hasSpinner ? [] : ['busy: no spinner shown'])
      ]
    },
    {
      label: `revert-cancel-restore-${tag}`,
      w,
      h,
      state: { mode: 'normal' },
      actions: [SELECT_FIRST, OPEN_REVERT, CANCEL_DIALOG],
      wait: 300,
      expect: (b) => [
        ...noHScroll(b),
        ...toolbarVisible(b),
        ...(b.dialogOpen ? ['cancel: dialog still open'] : []),
        ...(b.activeText === '恢复此文件…' ? [] : ['focus not restored to trigger (active=' + (b.activeText || 'none') + ')'])
      ]
    }
  );
}

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

  let passed = 0;
  for (const scene of scenes) {
    if (await shoot(scene)) passed += 1;
  }

  console.log(`[capture] assertion gate: ${passed}/${scenes.length} scenarios passed`);
  if (allFailures.length) {
    console.log('[capture] FAILURES:');
    for (const f of allFailures) console.log('  - ' + f);
  }
  fs.writeFileSync(
    path.join(OUT, 'gate-summary.json'),
    JSON.stringify(
      {
        scenarios: scenes.length,
        passed,
        failures: allFailures,
        generatedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
  const failed = allFailures.length > 0;
  console.log(failed ? '[capture] DONE FAIL — non-zero exit' : '[capture] DONE ok');
  app.exit(failed ? 1 : 0);
});
