// Criterion 1 (launch: no sidecar, no server, P2P shim) and the static half of
// criterion 8 (dropped features are gone from the UI).
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchApp, ROOT, ELECTRON_BIN, sleep, collectUiText, droppedHits } from './helpers.mjs';

let A;
test.beforeAll(async () => {
  // `npm start` in electron/ == `electron .`  ->  launch with the electron/ dir as the app (package.json "main").
  A = await launchApp('launch', { appPath: path.join(ROOT, 'electron') });
  await sleep(1500);
});
test.afterAll(async () => { await A?.close(); });

const psTable = () => execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => { const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/); return { pid: +m[1], ppid: +m[2], args: m[3] }; });
const descendants = (rootPid) => {
  const all = psTable(); const out = []; const q = [rootPid];
  while (q.length) { const p = q.shift(); for (const c of all.filter((x) => x.ppid === p)) { out.push(c); q.push(c.pid); } }
  return out;
};

test('criterion 1: app launches; window.__TAURI__ is the P2P shim; window.P2P and __P2P_BACKEND__ exist', async () => {
  const g = await A.page.evaluate(async () => ({
    url: location.href,
    tauri: typeof window.__TAURI__,
    coreKeys: Object.keys(window.__TAURI__?.core || {}),
    eventKeys: Object.keys(window.__TAURI__?.event || {}),
    p2p: typeof window.P2P,
    p2pKeys: Object.keys(window.P2P || {}),
    backend: typeof window.__P2P_BACKEND__,
    backendKeys: Object.keys(window.__P2P_BACKEND__ || {}),
    codecs: await window.__TAURI__.core.invoke('supported_codecs'),
    hasSelfId: typeof window.P2P?.selfId === 'string' && window.P2P.selfId.length > 0,
    title: document.title,
  }));
  expect(g.url).toMatch(/^file:\/\/.*\/frontend\/index\.html/); // served from disk, not from a localhost server
  expect(g.tauri).toBe('object');
  expect(g.coreKeys).toEqual(['invoke']);
  expect(g.eventKeys).toEqual(['listen']);
  expect(g.p2p).toBe('object');
  expect(g.p2pKeys).toEqual(expect.arrayContaining(['getStream', 'onStream', 'getStreams', 'selfId', 'generateShareCode', 'parseShareCode', 'supportedCodecs']));
  expect(g.backend).toBe('object');
  expect(g.backendKeys).toEqual(expect.arrayContaining(['invoke', 'listen', 'P2P', '_debug']));
  expect(g.hasSelfId).toBe(true);
  expect(g.codecs).toEqual(expect.arrayContaining(['h264']));
  // the shim really routes to the in-page P2P core: an unknown command is rejected by it
  await expect(A.page.evaluate(() => window.__TAURI__.core.invoke('definitely_not_a_command'))).rejects.toThrow(/Unknown command/);
  // GUI is up (not the GUI's own mock fallback): sidebar + rooms list rendered
  await expect(A.page.locator('#nav .nav-btn')).toHaveCount(3);
});

test('criterion 1: no process other than Electron\'s own, no localhost HTTP server', async () => {
  const mainPid = await A.app.evaluate(() => process.pid);
  const kids = descendants(mainPid);
  expect(kids.length).toBeGreaterThan(0); // renderer / gpu / utility (sanity: ps parsing works)
  // every descendant is the Electron binary itself (chromium subprocesses re-exec it)
  const foreign = kids.filter((k) => !k.args.startsWith(ELECTRON_BIN));
  expect(foreign, `non-Electron child processes: ${JSON.stringify(foreign)}`).toEqual([]);
  // nothing that looks like a sidecar / server
  const suspicious = kids.filter((k) => /(^|\/)(node|cargo|tauri|python\d?|server|ffmpeg|sidecar)(\s|$)/i.test(k.args.split(' ')[0].split('/').pop()));
  expect(suspicious).toEqual([]);
  // no TCP listeners owned by the app's process tree (a localhost HTTP server would show up here)
  const pids = new Set([mainPid, ...kids.map((k) => k.pid)]);
  const listeners = execFileSync('ss', ['-H', '-ltnp'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((l) => [...l.matchAll(/pid=(\d+)/g)].some((m) => pids.has(+m[1])));
  // Playwright itself opens Chromium's remote-debugging + Node inspector ports on the main
  // process (they answer /json/version). Anything else listening is the app's own server.
  const isHarnessPort = async (l) => {
    const port = l.match(/127\.0\.0\.1:(\d+)\s/)?.[1];
    if (!port) return false;
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
      return !!j["Protocol-Version"]; // CDP / node inspector
    } catch { return false; }
  };
  const appListeners = [];
  for (const l of listeners) if (!(await isHarnessPort(l))) appListeners.push(l);
  expect(listeners.length).toBeLessThanOrEqual(2); // only the harness' debug ports
  expect(appListeners, `app-owned listening TCP sockets: ${appListeners.join('\n')}`).toEqual([]);
  // and the main process itself was started as plain `electron <app>` (main = electron/main.js)
  const mainArgs = psTable().find((p) => p.pid === mainPid).args;
  expect(mainArgs.startsWith(ELECTRON_BIN)).toBe(true);
});

test('criterion 8: dropped features (D9) are absent from every tab', async () => {
  const text = await collectUiText(A.page);
  expect(droppedHits(text), 'dropped feature(s) visible in the UI').toEqual([]);
  // settings tab contains only display name + TURN (no server address, no jitter/presentation fields)
  await A.page.click('#nav >> text=Settings');
  const inputs = await A.page.evaluate(() => [...document.querySelectorAll('#settings-root input')].map((i) => i.getAttribute('aria-label') || i.className));
  expect(inputs.join('|')).toMatch(/TURN URL/);
  expect(inputs.join('|')).not.toMatch(/server|jitter|presentation/i);
});

test('criterion 8: no console errors on plain launch and tab navigation', async () => {
  for (const tab of ['View', 'Settings', 'Stream Control']) await A.page.click(`#nav >> text=${tab}`);
  await sleep(500);
  expect(A.errors).toEqual([]);
});
