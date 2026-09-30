// Headless end-to-end tests for the web client (docs/) against itself and the real Electron app.
//
//   bash tests/headless/run.sh node tools/web-e2e.mjs [a b c d e]      (default: all)
//
//   a  desktop creates a room + goes live      -> browser joins by code, watches, frames render
//   b  browser creates a room + shares (canvas) -> desktop joins by code, watches
//   c  240 fps: browser sender (canvas, maxFramerate 240) -> browser viewer renders >= 200 fps
//   d  wrong password (same room part, other secret) never sees the room
//   f  browser <-> browser through the real UI: tile overlay, fullscreen, blocked note, settings validation, stop
//   e  page loads under a sub-path (/docs/) without console errors
//
// Everything runs inside tests/headless/run.sh (private sway + Xwayland); browsers are headless Chromium.
// Options (--key=value, or env WEB_E2E_SHOTS / WEB_E2E_CHROMIUM / C_W C_H C_KBPS C_CODEC C_FPS / D_WAIT_MS):
//   --shots=<dir> screenshots   --chromium=<path> other Chromium binary   --w= --h= --kbps= --codec= --fps= (test c)   --wait=<ms> (test d)
import { chromium } from '../tests/node_modules/@playwright/test/index.mjs';
import { launchApp, createRoomUI, joinRoomUI, shareScreenUI, animateDamage, watchViaUI, countFrames, inv, until, sleep, isIgnoredError } from '../tests/e2e/helpers.mjs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Be nice to whoever is using the machine (e.g. gaming): every child inherits this.
try { os.setPriority(0, 10); } catch { /* ignore */ }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// tests/headless/run.sh runs us under `env -i`, so options come as --key=value arguments (env vars work when run without the wrapper).
const OPT = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
process.argv = process.argv.filter((a, i) => i < 2 || !a.startsWith('--'));
const opt = (k, env, dflt) => OPT[k] ?? process.env[env] ?? dflt;
const SHOTS = opt('shots', 'WEB_E2E_SHOTS', path.join(os.tmpdir(), 'p2p-web-e2e-shots'));
fs.mkdirSync(SHOTS, { recursive: true });

// Hard rule: no sound. --mute-audio; plus headless means no window on the user's display.
const BROWSER_ARGS = ['--mute-audio', '--no-first-run', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
// Uncapped compositor, so requestVideoFrameCallback can report > 60 presented frames per second.
const UNCAPPED = ['--disable-gpu-vsync', '--disable-frame-rate-limit', ...(opt('xargs', 'WEB_E2E_ARGS', '') ? opt('xargs', 'WEB_E2E_ARGS', '').split(',') : [])];

// ---------------------------------------------------------------------------
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const servers = [];
async function serve(dir) {
  const port = await freePort();
  const p = spawn('python3', ['-m', 'http.server', '--bind', '127.0.0.1', String(port), '-d', dir], { stdio: 'ignore' });
  servers.push(p);
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await sleep(100); } }
  return `http://127.0.0.1:${port}`;
}

const browsers = [];
async function launchBrowser(extra = []) {
  const b = await chromium.launch({ headless: true, ...(opt('channel', 'WEB_E2E_CHANNEL') ? { channel: opt('channel', 'WEB_E2E_CHANNEL') } : {}), args: [...BROWSER_ARGS, ...extra], ...(opt('chromium', 'WEB_E2E_CHROMIUM') ? { executablePath: opt('chromium', 'WEB_E2E_CHROMIUM') } : {}) });
  browsers.push(b);
  return b;
}

// Headless Chromium presents at a fixed 60 Hz (rAF and requestVideoFrameCallback are both capped, even with
// --disable-frame-rate-limit; measured). A real 240 Hz display is emulated by driving the compositor ourselves:
// --enable-begin-frame-control + CDP HeadlessExperimental.beginFrame at `hz`. Nothing in the page changes; frames
// the decoder produces are presented whenever a BeginFrame arrives, exactly as on a fast display.
const BFC_ARGS = ['--enable-begin-frame-control', '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout', '--disable-threaded-animation'];
const NO_DISPLAY = opt('nodisplay', 'C_NODISPLAY', '0') === '1';
async function startBeginFrames(ctx, page, hz) {
  const cdp = await ctx.newCDPSession(page);
  let stop = false, frames = 0;
  const t0 = performance.now();
  (async () => {
    let next = performance.now();
    while (!stop) {
      await cdp.send('HeadlessExperimental.beginFrame', { interval: 1000 / hz, noDisplayUpdates: NO_DISPLAY && frames % 8 !== 0 }).then(() => frames++).catch(() => {});
      next += 1000 / hz;
      const d = next - performance.now();
      if (d > 1) await sleep(d); else if (d < -50) next = performance.now();
    }
  })();
  return { cdp, rate: () => +((frames * 1000) / (performance.now() - t0)).toFixed(0), stop: () => { stop = true; } };
}

/** New isolated page (own localStorage) that records console errors. */
async function openPage(browser, url, name, { bfcHz = 0, viewport = { width: 1280, height: 800 }, init } = {}) {
  const ctx = await browser.newContext({ viewport });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const bf = bfcHz ? await startBeginFrames(ctx, page, bfcHz) : null;
  const errors = [], ignored = [], bad = [];
  page.on('pageerror', (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') { const t = `[${name}] console.error: ${m.text()}`; (isIgnoredError(t) ? ignored : errors).push(t); } });
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  await page.goto(url);
  await page.evaluate(() => window.__P2P_BACKEND__.ready);
  return { page, ctx, name, errors, ignored, bad, bf };
}

// Under begin-frame control Playwright's "stable" actionability check can stall; click through the DOM there.
const click = (w, sel) => (w.bf ? w.page.evaluate((s) => document.querySelector(s).click(), sel) : w.page.click(sel));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const webCreate = async (w, name = 'web room') => {
  await w.page.fill('#create-name', name);
  await click(w, '#create-form button');
  return until(() => w.page.inputValue('#room-code'), 10_000, `${w.name}: share code shown`);
};
const webJoin = async (w, code) => {
  await w.page.fill('#join-code', code);
  await click(w, '#join-form button');
  await until(() => w.page.$eval('#room-state', (e) => e.textContent === 'Connected'), 10_000, `${w.name}: joined`);
};
const webMembers = (w) => w.page.$$eval('#members li .grow', (l) => l.map((e) => e.textContent));

/** Wait until a stream row shows up in the room card, press Watch, wait for the <video> to have frames. */
async function webWatch(w, ms = 90_000) {
  await until(() => w.page.$('#streams button'), ms, `${w.name}: stream row in room card`);
  await click(w, '#streams button');
  await until(() => w.page.evaluate(() => document.querySelector('.tile video')?.videoWidth > 0), 60_000, `${w.name}: tile video has frames (videoWidth > 0)`);
}

/** Frames presented by the tile <video> (rVFC) and the decoder's view (inbound-rtp) over `ms`. */
async function measure(page, ms) {
  return page.evaluate(async (ms) => {
    const v = document.querySelector('.tile video');
    const inbound = async () => {
      let o = null;
      for (const r of window.__P2P_BACKEND__._debug.rooms.values()) {
        for (const pc of Object.values(r.tr?.getPeers?.() || {})) (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') o = s; });
      }
      return o && { framesDecoded: o.framesDecoded, framesReceived: o.framesReceived, framesDropped: o.framesDropped, bytes: o.bytesReceived, fps: o.framesPerSecond, w: o.frameWidth, h: o.frameHeight, decoder: o.decoderImplementation, ts: o.timestamp, jb: o.jitterBufferDelay / Math.max(1, o.jitterBufferEmittedCount) };
    };
    let n = 0, p0 = null, p1 = null;
    const cb = (_now, md) => { n++; if (p0 == null) p0 = md.presentedFrames; p1 = md.presentedFrames; v.requestVideoFrameCallback(cb); };
    const q0 = v.getVideoPlaybackQuality();
    const a = await inbound();
    const t0 = performance.now();
    v.requestVideoFrameCallback(cb);
    await new Promise((r) => setTimeout(r, ms));
    const secs = (performance.now() - t0) / 1000;
    const presented = n;
    const b = await inbound();
    const q1 = v.getVideoPlaybackQuality();
    return {
      seconds: +secs.toFixed(2), presentedFrames: presented, presentedFps: +(presented / secs).toFixed(1),
      // rVFC metadata.presentedFrames: frames submitted to the compositor (callbacks can coalesce when a display is slower than the stream)
      submittedFps: p0 == null ? 0 : +(((p1 - p0) / secs)).toFixed(1), playbackQuality: { total: q1.totalVideoFrames - q0.totalVideoFrames, dropped: q1.droppedVideoFrames - q0.droppedVideoFrames },
      decodedFps: b && a ? +(((b.framesDecoded - a.framesDecoded) * 1000) / (b.ts - a.ts)).toFixed(1) : null,
      reportedFps: b && b.fps, dropped: b && b.framesDropped, size: b && `${b.w}x${b.h}`, decoder: b && b.decoder, kbps: b && a ? Math.round(((b.bytes - a.bytes) * 8) / (b.ts - a.ts)) : null,
      overlay: document.querySelector('.tile-stats')?.textContent, paused: v.paused, videoWidth: v.videoWidth,
    };
  }, ms);
}

const senderStats = (page) => page.evaluate(async () => {
  const out = [];
  for (const d of window.__P2P_BACKEND__._debug.destinations.values()) {
    for (const r of d.senders.values()) {
      const p = r.sender.getParameters();
      (await r.sender.getStats()).forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') out.push({ fps: s.framesPerSecond, framesEncoded: s.framesEncoded, enc: s.encoderImplementation, limit: s.qualityLimitationReason, w: s.frameWidth, h: s.frameHeight, maxFramerate: p.encodings[0].maxFramerate, maxBitrate: p.encodings[0].maxBitrate, codec: p.codecs?.[0]?.mimeType });
      });
    }
  }
  return out;
});

/** Screenshot of a page whose compositor we drive ourselves (begin-frame control): ask the BeginFrame for it. */
async function shotBfc(w, name) {
  if (!w.bf) return shot(w.page, name);
  w.bf.stop();
  await sleep(100);
  for (let i = 0; i < 3; i++) await w.bf.cdp.send('HeadlessExperimental.beginFrame', {}).catch(() => {});
  const r = await w.bf.cdp.send('HeadlessExperimental.beginFrame', { screenshot: { format: 'png' } });
  const f = path.join(SHOTS, name);
  fs.writeFileSync(f, Buffer.from(r.screenshotData || '', 'base64'));
  return f;
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name), fullPage: true }).then(() => path.join(SHOTS, name));

// ---------------------------------------------------------------------------
const results = {};
const cleanups = [];
const record = (id, ok, info) => { results[id] = { ok, ...info }; console.log(`\n=== TEST ${id}: ${ok ? 'PASS' : 'FAIL'} ===\n${JSON.stringify(info, null, 1)}`); };

const tests = {
  async a(ctx) {
    // desktop creates + goes live; browser joins by code and watches
    const A = await launchApp('A'); cleanups.push(() => A.close());
    const { code } = await createRoomUI(A, 'desktop room');
    const br = await launchBrowser(UNCAPPED);
    const W = await openPage(br, ctx.docs, 'webview');
    await webJoin(W, code);
    await shareScreenUI(A);
    await animateDamage(A.page);
    await webWatch(W);
    const m = await measure(W.page, 5000);
    const png = await shot(W.page, 'a-browser-watches-desktop.png');
    const members = await webMembers(W);
    const ok = m.presentedFrames > 30 && m.videoWidth > 0 && W.errors.length === 0;
    record('a', ok, { code: code.slice(0, 6) + '-…', members, measure: m, screenshot: png, errors: W.errors, ignored: W.ignored.length, desktopErrors: A.errors });
  },

  async b(ctx) {
    // browser creates + shares canvas at 60 fps via the real UI; desktop joins by code and watches
    const br = await launchBrowser(UNCAPPED);
    const W = await openPage(br, `${ctx.docs}/?testCapture=canvas`, 'websharer');
    const code = await webCreate(W, 'web room');
    const A = await launchApp('D'); cleanups.push(() => A.close());
    const roomId = await joinRoomUI(A, code);
    await until(async () => (await inv(A, 'room_detail', { roomId })).members.length >= 2, 90_000, 'desktop sees web as member');
    await until(async () => (await webMembers(W)).length >= 2, 90_000, 'web sees desktop as member');
    await W.page.click('#fps-seg button[data-fps="60"]');
    await W.page.click('#share-btn');
    await until(() => W.page.$('#my-shares li'), 20_000, 'own share listed');
    await until(async () => (await inv(A, 'room_detail', { roomId })).streams.length, 60_000, 'desktop sees the web stream');
    await watchViaUI(A);
    const v = await countFrames(A.page, '#view-root video', 5000);
    const inb = await A.page.evaluate(async () => {
      let o = null;
      for (const r of window.__P2P_BACKEND__._debug.rooms.values()) for (const pc of Object.values(r.tr?.getPeers?.() || {})) (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') o = { decoded: s.framesDecoded, w: s.frameWidth, h: s.frameHeight, fps: s.framesPerSecond }; });
      return o;
    });
    await sleep(1500);
    const snd = await senderStats(W.page);
    const myShare = await W.page.$eval('#my-shares li', (e) => e.textContent);
    const png = await shot(W.page, 'b-browser-shares.png');
    const shotA = await A.page.screenshot({ path: path.join(SHOTS, 'b-desktop-watches-browser.png') }).then(() => path.join(SHOTS, 'b-desktop-watches-browser.png'));
    const ok = v.frames > 50 && inb && inb.decoded > 0 && W.errors.length === 0;
    record('b', ok, { desktopFrames5s: v, desktopInbound: inb, sender: snd, myShare, screenshots: [png, shotA], errors: W.errors, ignored: W.ignored.length, desktopErrors: A.errors });
  },

  async c() {
    // 240 fps: canvas sender with encoder maxFramerate 240, browser viewer must render >= 200 fps
    const W_ = Number(opt('w', 'C_W', 854)), H_ = Number(opt('h', 'C_H', 480));
    const kbps = Number(opt('kbps', 'C_KBPS', 20000)), codec = opt('codec', 'C_CODEC', 'h264'), fps = Number(opt('fps', 'C_FPS', 240));
    const sb = await launchBrowser(UNCAPPED);
    const bfcHz = Number(opt('bfc', 'C_BFC', 800)); // 0 = leave the headless 60 Hz compositor alone
    const vb = await launchBrowser(bfcHz ? BFC_ARGS : UNCAPPED);
    const S = await openPage(sb, `${(await ctxDocs())}/?testCapture=canvas&testFps=${fps}&testW=${W_}&testH=${H_}`, 'sender240');
    const V = await openPage(vb, await ctxDocs(), 'viewer240', { bfcHz, viewport: { width: Number(opt('vw', 'C_VW', 640)), height: Number(opt('vh', 'C_VH', 500)) } });
    log('c: pages open');
    const code = await webCreate(S, 'fps room');
    log('c: room created');
    await webJoin(V, code);
    log('c: viewer joined');
    await until(async () => (await webMembers(S)).length >= 2, 90_000, 'sender sees viewer');
    const roomId = await S.page.evaluate(async () => (await window.__P2P_BACKEND__.invoke('list_saved_rooms'))[0].roomId);
    const goLive = await S.page.evaluate(async ([roomId, fps, kbps, codec]) => {
      const b = window.__P2P_BACKEND__;
      const p = { framerate: fps, bitrateKbps: kbps, codec, preset: 'low_latency', shareAudio: false };
      await b.invoke('set_start_stream_defaults', p);
      const { captureId } = await b.invoke('stage_video_share');
      await b.invoke('go_live', { captureId, roomId, ...p });
      return captureId;
    }, [roomId, fps, kbps, codec]);
    log('c: live, watching');
    await webWatch(V);
    log('c: tile has frames');
    await sleep(8000); // let the bandwidth estimate ramp
    const raf = await V.page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
    const m = await measure(V.page, 8000);
    m.viewerRafFpsDuringRun = raf;
    m.compositorBeginFramesPerSec = V.bf ? V.bf.rate() : 'n/a (browser default 60 Hz)';
    const snd = await senderStats(S.page);
    if (V.bf) V.bf.stop();
    const png = await shotBfc(V, 'c-240fps-viewer.png');
    const ok = m.decodedFps >= 200 && m.reportedFps >= 200 && m.presentedFps >= 200;
    record('c', ok, { params: { w: W_, h: H_, kbps, codec, fps }, goLive, viewer: m, sender: snd, screenshot: png, errors: [...S.errors, ...V.errors], ignored: S.ignored.length + V.ignored.length });
  },

  async d() {
    // same room part, different secret: Z must never see X (positive control: Y with the right code does)
    const br = await launchBrowser();
    const url = await ctxDocs();
    const X = await openPage(br, url, 'X'), Y = await openPage(br, url, 'Y'), Z = await openPage(br, url, 'Z');
    const codeA = await webCreate(X, 'secret room');
    const codeB = await X.page.evaluate(async (a) => {
      const m = await import('./p2p/sharecode.js');
      const p = m.parseShareCode(a);
      const other = m.parseShareCode(m.generateShareCode());
      return m.buildShareCode(p.roomPart, other.secret);
    }, codeA);
    const same = codeA.split('-')[0] === codeB.split('-')[0] && codeA !== codeB;
    await webJoin(Y, codeA);
    await until(async () => (await webMembers(X)).length >= 2, 90_000, 'X sees Y (right code)');
    await webJoin(Z, codeB);
    await sleep(Number(opt('wait', 'D_WAIT_MS', 30_000)));
    const mx = await webMembers(X), my = await webMembers(Y), mz = await webMembers(Z);
    const ok = same && mx.length === 2 && my.length === 2 && mz.length === 1;
    record('d', ok, { sameRoomPartDifferentSecret: same, membersX: mx, membersY: my, membersZ: mz, waitedMs: Number(opt('wait', 'D_WAIT_MS', 30_000)) });
  },

  async f(ctx) {
    // browser <-> browser through the real UI at 60 fps: tile overlay, fullscreen, unreachable note, settings, stop
    const sb = await launchBrowser(UNCAPPED), vb = await launchBrowser(UNCAPPED);
    const S = await openPage(sb, `${ctx.docs}/?testCapture=canvas`, 'sharer');
    const V = await openPage(vb, ctx.docs, 'viewer');
    const code = await webCreate(S, 'ui room');
    await webJoin(V, code);
    await until(async () => (await webMembers(S)).length >= 2, 90_000, 'sharer sees viewer');
    const checks = {};
    await S.page.click('#fps-seg button[data-fps="60"]');
    await S.page.click('#share-btn');
    await until(() => S.page.$('#my-shares li'), 20_000, 'own share listed');
    await webWatch(V);
    await sleep(3000);
    const m = await measure(V.page, 4000);
    checks.overlayFromStats = /^\d+ fps · \d+×\d+ · [\d.]+ Mbps$/.test(m.overlay || '');
    checks.frames60 = m.presentedFps > 40;
    // controls: no audio track -> volume/mute hidden; fullscreen by button and by double click
    checks.noAudioControlsHidden = await V.page.$eval('.tile-bar input[type=range]', (e) => e.hidden);
    await V.page.hover('.tile');
    await V.page.click('.tile .tbtn[title="Fullscreen"]');
    checks.fullscreenByButton = await until(() => V.page.evaluate(() => document.fullscreenElement?.classList.contains('tile')), 5000, 'fullscreen via button');
    await V.page.evaluate(() => document.exitFullscreen());
    await until(() => V.page.evaluate(() => !document.fullscreenElement), 5000, 'exit fullscreen');
    await V.page.dblclick('.tile video');
    checks.fullscreenByDblclick = await until(() => V.page.evaluate(() => document.fullscreenElement?.classList.contains('tile')), 5000, 'fullscreen via dblclick');
    await V.page.evaluate(() => document.exitFullscreen());
    const png = await shot(V.page, 'f-viewer-live-tile.png');
    const shotS = await shot(S.page, 'f-sharer.png');
    // "Direct connection blocked" note
    const peer = await V.page.evaluate(async () => (await window.__P2P_BACKEND__.invoke('room_detail', { roomId: (await window.__P2P_BACKEND__.invoke('list_saved_rooms'))[0].roomId })).members.find((x) => x.conn_id !== window.P2P.selfId));
    const roomId = await V.page.evaluate(async () => (await window.__P2P_BACKEND__.invoke('list_saved_rooms'))[0].roomId);
    await V.page.evaluate(([roomId, p]) => window.WebClient.peerUnreachable({ roomId, peerId: p.conn_id, peerName: p.display_name }), [roomId, peer]);
    checks.unreachableShown = await V.page.$eval('#unreachable', (e) => !e.hidden && /Direct connection blocked/.test(e.textContent));
    const shotU = await shot(V.page, 'f-unreachable-note.png');
    await V.page.evaluate(([roomId, p]) => window.WebClient.peerConnected({ roomId, peerId: p.conn_id }), [roomId, peer]);
    checks.unreachableClearedOnConnected = await V.page.$eval('#unreachable', (e) => e.hidden);
    // settings validation (all three TURN fields or none)
    const save = async (name, url, user, pass) => {
      await V.page.click('#settings-btn');
      await V.page.fill('#set-name', name); await V.page.fill('#set-url', url); await V.page.fill('#set-user', user); await V.page.fill('#set-pass', pass);
      await V.page.click('#settings-form button[type=submit]');
      await sleep(200);
      const status = await V.page.$eval('#set-status', (e) => e.textContent);
      await V.page.evaluate(() => document.getElementById('settings-dlg').close());
      return status;
    };
    checks.turnUrlOnlyRejected = /needs both a username and a password/.test(await save('Viewer', 'turn:turn.example.com:3478', '', ''));
    checks.turnBadUrlRejected = /should look like turn:/.test(await save('Viewer', 'http://x', 'u', 'p'));
    checks.turnUserOnlyRejected = /only used together/.test(await save('Viewer', '', 'u', ''));
    checks.settingsSaved = (await save('Viewer', '', '', '')) === 'Saved';
    checks.nameShownToPeer = await until(async () => (await webMembers(S)).includes('Viewer'), 10_000, 'sharer sees the new display name');
    // unwatch from the tile
    await V.page.click('.tile .tbtn[title="Stop watching"]');
    checks.tileRemovedOnUnwatch = await until(() => V.page.evaluate(() => !document.querySelector('.tile')), 10_000, 'tile removed');
    await V.page.click('#streams button');
    await until(() => V.page.$('.tile video'), 10_000, 'tile back');
    // sharer stops -> stream row and tile disappear on the viewer
    await S.page.click('#my-shares button');
    checks.tileGoneWhenSharerStops = await until(() => V.page.evaluate(() => !document.querySelector('.tile') && !document.querySelector('#streams li')), 20_000, 'viewer loses the stream');
    const ok = Object.values(checks).every(Boolean) && S.errors.length === 0 && V.errors.length === 0;
    record('f', ok, { checks, measure: m, screenshots: [png, shotS, shotU], errors: [...S.errors, ...V.errors] });
  },

  async e(ctx) {
    // served from the project root: page lives at /docs/ (a sub-path); all URLs must be relative
    const br = await launchBrowser();
    const W = await openPage(br, `${ctx.root}/docs/`, 'subpath');
    const code = await webCreate(W, 'subpath room');
    await W.page.click('#settings-btn');
    const dlg = await W.page.$eval('#settings-dlg', (d) => d.open);
    await sleep(3000);
    const png = await shot(W.page, 'e-subpath.png');
    const fontsOk = await W.page.evaluate(() => document.fonts.check('14px Geist') && document.fonts.check('12px "Geist Mono"'));
    const shareShown = await W.page.$eval('#share-panel', (e) => !e.hidden);
    // a browser without getDisplayMedia (mobile): no Share panel, everything else still works
    const M = await openPage(br, `${ctx.root}/docs/`, 'mobile', { init: 'delete MediaDevices.prototype.getDisplayMedia;', viewport: { width: 390, height: 800 } });
    await webCreate(M, 'mobile room');
    const mobile = { getDisplayMediaType: await M.page.evaluate(() => typeof navigator.mediaDevices.getDisplayMedia), sharePanelHidden: await M.page.$eval('#share-panel', (e) => e.hidden), roomCardShown: await M.page.$eval('#room-card', (e) => !e.hidden), noHorizontalScroll: await M.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth) };
    const pngM = await shot(M.page, 'e-mobile-no-share.png');
    const ok = W.errors.length === 0 && W.bad.length === 0 && M.errors.length === 0 && !!code && dlg && shareShown && mobile.sharePanelHidden && mobile.roomCardShown && mobile.noHorizontalScroll;
    record('e', ok, { mobile, sharePanelShownOnDesktop: shareShown, mobileErrors: M.errors, screenshotMobile: pngM, url: `${ctx.root}/docs/`, http4xx: W.bad, settingsDialogOpens: dlg, fontsLoaded: fontsOk, screenshot: png, errors: W.errors, ignoredRelayNoise: W.ignored });
  },
};

let docsUrl, rootUrl;
const ctxDocs = async () => docsUrl;

(async () => {
  docsUrl = await serve(path.join(ROOT, 'docs'));
  rootUrl = await serve(ROOT);
  const want = process.argv.slice(2);
  const ids = want.length ? want : Object.keys(tests);
  for (const id of ids) {
    try {
      await tests[id]({ docs: docsUrl, root: rootUrl });
    } catch (e) {
      record(id, false, { error: String((e && e.stack) || e).replace(/Browser logs:[\s\S]*?\n\s+at /, '[browser logs trimmed]\n    at ').slice(0, 1500) });
    }
    for (const c of cleanups.splice(0)) await c().catch(() => {});
    for (const b of browsers.splice(0)) await b.close().catch(() => {});
  }
})().finally(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  for (const b of browsers.splice(0)) await b.close().catch(() => {});
  for (const s of servers) s.kill();
  console.log('\nSUMMARY', JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok ? 'PASS' : 'FAIL']))));
  process.exit(Object.values(results).every((r) => r.ok) ? 0 : 1);
});
