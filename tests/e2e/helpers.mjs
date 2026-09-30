// Shared helpers for the e2e specs. Everything drives the REAL app
// (electron/main.js + frontend/) through Playwright's _electron; no app code
// is modified or mocked. Only test-side scaffolding lives here.
import { _electron } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const ELECTRON_BIN = path.join(ROOT, 'electron', 'node_modules', 'electron', 'dist', 'electron');
// P2P_E2E_MAIN: run the suite against a patched copy of main.js.
export const MAIN_JS = process.env.P2P_E2E_MAIN || path.join(ROOT, 'electron', 'main.js');

// Set by tests/headless/run.sh (default for `npm test`); absent with P2P_E2E_DISPLAY=real (`npm run test:display`).
export const HEADLESS = process.env.P2P_E2E_HEADLESS === '1';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** poll fn until truthy (exceptions count as "not yet"); throws 'timeout: <what>' */
export async function until(fn, ms, what) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error(`timeout after ${ms}ms: ${what}${last ? ` (last error: ${last.message})` : ''}`);
}

// Console/page errors that are environmental, not app bugs. Listed in the report.
//  - public Nostr relays that are down / rate-limiting (koru.bitcointxoko.org answers 502)
//  - any WebSocket handshake/connection failure to a relay (wss://...)
export const IGNORED_ERRORS = [
  /koru\.bitcointxoko/i,
  /WebSocket connection to 'wss?:\/\/[^']*' failed/i,
  /wss?:\/\/\S+.*(502|503|429|ERR_|failed|refused)/i,
  /Failed to load resource: net::ERR_/i, // relay http fallbacks / offline fonts
];
export const isIgnoredError = (t) => IGNORED_ERRORS.some((re) => re.test(t));

/**
 * Launch one real app instance with its own fresh user-data-dir.
 * opts.initScript: JS source run in every page of this instance before app scripts
 *                  (used only for test spies / relay-only ICE policy, see specs).
 * Returns { app, page, name, errors, ignored, dir, popups, close() }.
 */
export async function launchApp(name, opts = {}) {
  const dir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), `p2p-e2e-${name}-`));
  const app = await _electron.launch({
    executablePath: ELECTRON_BIN,
    args: [opts.appPath || MAIN_JS, `--user-data-dir=${dir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
      // headless (tests/headless/run.sh): run as an X11 client of the private sway's Xwayland, so getDisplayMedia
      // uses X11 capture and no xdg-desktop-portal / share picker is involved.
      ...(HEADLESS ? ['--ozone-platform=x11'] : [])],
  });
  const inst = { app, name, dir, errors: [], ignored: [], popups: [] };
  const watch = (page, tag) => {
    page.on('pageerror', (e) => inst.errors.push(`[${tag}] pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = `[${tag}] console.error: ${m.text()}`;
      (isIgnoredError(t) ? inst.ignored : inst.errors).push(t);
    });
  };
  if (opts.initScript) await app.context().addInitScript(opts.initScript);
  const page = await app.firstWindow();
  inst.page = page;
  watch(page, name);
  app.on('window', (w) => { if (w !== page) { inst.popups.push(w); watch(w, `${name}:popup`); } });
  if (opts.initScript) await page.reload(); // make sure the init script ran before app scripts
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.evaluate(() => window.__P2P_BACKEND__.ready);
  // call log (mutating commands only) for failure diagnostics
  await page.evaluate(() => {
    const be = window.__P2P_BACKEND__; const orig = be.invoke; window.__calls = [];
    be.invoke = (n, a) => { if (!/^(list_|get_|room_detail|supported_codecs)/.test(n)) window.__calls.push([Math.round(performance.now()), n, a]); return orig(n, a); };
  });
  inst.close = async () => { try { await app.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  return inst;
}

/** window.__TAURI__.core.invoke inside the instance */
export const inv = (w, n, a) => w.page.evaluate(([n, a]) => window.__TAURI__.core.invoke(n, a), [n, a]);

/** Create a room through the real UI; resolves { code, roomId } (code read from .share-code-input). */
export async function createRoomUI(w, roomName = 'e2e room') {
  const { page } = w;
  await page.click('#add-room-card .mode-toggle-btn:has-text("Create")').catch(async () => {
    await page.click('#add-room-btn');
    await page.click('#add-room-card .mode-toggle-btn:has-text("Create")');
  });
  await page.fill('#add-room-card input', roomName);
  await page.click('#add-room-card .btn-primary');
  const code = await until(() => page.inputValue('.share-code-input'), 8000, 'share code shown');
  await page.click('#add-room-card .btn-primary:has-text("Done")');
  const roomId = await until(async () => (await inv(w, 'list_saved_rooms'))[0]?.roomId, 8000, 'room saved');
  return { code, roomId };
}

/** Join a room through the real UI (paste code into the add-room card). */
export async function joinRoomUI(w, code) {
  const { page } = w;
  if (!(await page.isVisible('#add-room-card'))) await page.click('#add-room-btn');
  await page.fill('#add-room-card input', code);
  await page.click('#add-room-card .btn-primary');
  return until(async () => (await inv(w, 'list_saved_rooms'))[0]?.roomId, 8000, 'joined room saved');
}

export const memberCount = async (w, roomId) => (await inv(w, 'room_detail', { roomId })).members.length;

/** Wait until both sides see each other (signalling over public relays: slow). */
export async function waitPaired(A, B, roomId, ms = 90_000) {
  await until(async () => (await memberCount(A, roomId)) >= 2, ms, 'A sees B in room_detail.members');
  await until(async () => (await memberCount(B, roomId)) >= 2, 30_000, 'B sees A in room_detail.members');
}

/**
 * Share screen via the real UI: click "Share screen", wait for the staged capture card
 * (headless: X11 capture of the private sway's Xwayland; on the real display: Wayland portal capture,
 * approved by the auto share picker), then "Go live".
 * `beforeGoLive(page)` may tweak the staged card (codec/fps/bitrate) first.
 */
export async function shareScreenUI(w, beforeGoLive) {
  const { page } = w;
  await page.click('text=Share screen');
  // "Go live" exists (disabled) while the card is STARTING; the card re-renders when the capture becomes ready,
  // so only touch the controls once it is enabled.
  await until(() => page.$('.dest-go-live-btn:not([disabled])'), 30_000, 'staged capture ready (.dest-go-live-btn enabled)');
  if (beforeGoLive) await beforeGoLive(page);
  await page.click('.dest-go-live-btn');
}

/**
 * Wayland/portal capture is damage-driven: a static desktop yields 1-6 fps (X11 capture in the headless
 * session delivers frames regardless; this is harmless there). Animate a small element in the sharer's
 * own window (it is on the captured monitor).
 * Test scaffolding only - not app behaviour.
 */
export async function animateDamage(page) {
  await page.evaluate(() => {
    if (window.__damage) return;
    const d = document.createElement('div');
    d.id = '__e2e_damage';
    d.style.cssText = 'position:fixed;left:0;bottom:0;width:120px;height:40px;z-index:99999;pointer-events:none';
    document.body.appendChild(d);
    let n = 0;
    window.__damage = setInterval(() => { d.style.background = `hsl(${(n += 15) % 360} 80% 50%)`; }, 16);
  });
}

/** Watch the first available live stream of `roomId` from B through the real UI (room panel -> Watch -> View tab). */
export async function watchViaUI(B, timeout = 45_000) {
  const { page } = B;
  await page.click('.room-caret');
  const watchSel = '#room-panel .room-panel-members-section:has-text("Live streams") button[title="Watch"]';
  await until(() => page.$(watchSel), 15_000, 'Watch button in room panel');
  await page.click(watchSel);
  await page.click('.room-panel-close').catch(() => {});
  await page.click('#nav >> text=View').catch(() => {});
  await until(() => page.$('#view-root video'), 15_000, 'tile <video> in View tab');
  await until(() => page.evaluate(() => document.querySelector('#view-root video')?.videoWidth > 0), timeout, 'viewer <video> videoWidth > 0');
}

/** Count frames the <video> presents over `ms` (requestVideoFrameCallback). */
export const countFrames = (page, sel, ms) => page.evaluate(([sel, ms]) => new Promise((res) => {
  const v = document.querySelector(sel);
  let n = 0;
  const cb = () => { n++; v.requestVideoFrameCallback(cb); };
  v.requestVideoFrameCallback(cb);
  setTimeout(() => res({ frames: n, w: v.videoWidth, h: v.videoHeight, paused: v.paused }), ms);
}), [sel, ms]);

/** Outbound video RTCRtpSender(s) of A's live destination(s), described (parameters + stats). */
export const senderInfo = (page) => page.evaluate(async () => {
  const out = [];
  for (const d of window.__P2P_BACKEND__._debug.destinations.values()) {
    for (const r of d.senders.values()) {
      const p = r.sender.getParameters();
      const stats = [];
      (await r.sender.getStats()).forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') stats.push({ encoderImplementation: s.encoderImplementation, powerEfficientEncoder: s.powerEfficientEncoder, framesEncoded: s.framesEncoded, frameWidth: s.frameWidth, frameHeight: s.frameHeight, bytesSent: s.bytesSent }); });
      const codecs = p.codecs || [];
      out.push({ enc: p.encodings[0], codec0: codecs[0]?.mimeType, codecs: codecs.map((c) => c.mimeType), contentHint: d.videoTrack?.contentHint, stats: stats[0] });
    }
  }
  return out;
});

/** Assert-friendly console-error report. */
export function realErrors(...insts) { return insts.flatMap((i) => i.errors); }
export function ignoredErrors(...insts) { return insts.flatMap((i) => i.ignored); }

/** Dropped features (decision D9) that must not be visible anywhere in the UI. */
export const DROPPED = {
  'bandwidth allocator': /bandwidth|allocat/i,
  'transfer between rooms': /transfer/i,
  'jitter buffer setting': /jitter/i,
  'presentation mode setting': /presentation/i,
  'per-app audio source picker': /audio source|per-app|application audio|app audio|select (an )?application/i,
  'server address field': /server (address|url|host)|sidecar|localhost|127\.0\.0\.1/i,
};

/** Visible text + labels/placeholders/titles of every tab and the sidebar, in the page's CURRENT state. */
export async function collectUiText(page) {
  const chunks = [];
  for (const tab of ['Stream Control', 'View', 'Settings']) {
    await page.click(`#nav >> text=${tab}`);
    await sleep(250);
    chunks.push(await page.evaluate(() => {
      const panel = [...document.querySelectorAll('.tab-panel')].find((p) => !p.hidden);
      const attrs = [...panel.querySelectorAll('[aria-label],[placeholder],[title]')].map((e) => [e.getAttribute('aria-label'), e.placeholder, e.title].filter(Boolean).join(' '));
      const opts = [...panel.querySelectorAll('option, .dd-option')].map((o) => o.textContent);
      return `${panel.innerText}\n${attrs.join('\n')}\n${opts.join('\n')}`;
    }));
  }
  if (!(await page.isVisible('#add-room-card'))) await page.click('#add-room-btn');
  chunks.push(await page.evaluate(() => document.querySelector('.sidebar').innerText));
  return chunks.join('\n');
}
export const droppedHits = (text) => Object.entries(DROPPED).filter(([, re]) => re.test(text)).map(([n]) => n);
