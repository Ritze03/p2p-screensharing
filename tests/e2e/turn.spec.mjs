// Criterion 7: a TURN server entered in Settings reaches the peer connection config;
// an unreachable peer shows the "direct connection blocked" state.
import { test, expect } from '@playwright/test';
import { launchApp, createRoomUI, joinRoomUI, until, sleep, realErrors } from './helpers.mjs';

// Test-side spies injected before any app script runs (no app code is modified):
//  - record every RTCPeerConnection the app creates (so we can read the live getConfiguration())
const SPY_PCS = `(() => { const O = window.RTCPeerConnection; window.__pcs = [];
  window.RTCPeerConnection = class extends O { constructor(c, ...r) { super(c, ...r); window.__pcs.push(this); } }; })()`;
//  - additionally force iceTransportPolicy:'relay' (with no TURN configured no path exists => "direct connection blocked").
//    The app only accepts rtcConfig via createBackend(opts), which the shim does not expose, so this is the test hook.
const FORCE_RELAY = `(() => { const O = window.RTCPeerConnection; window.__pcs = [];
  window.RTCPeerConnection = class extends O { constructor(c, ...r) { super({ ...(c || {}), iceTransportPolicy: 'relay' }, ...r); window.__pcs.push(this); } }; })()`;

const iceServers = (page) => page.evaluate(() => window.__pcs.map((pc) => ({ policy: pc.getConfiguration().iceTransportPolicy, servers: pc.getConfiguration().iceServers })));
const urlsOf = (cfgs) => cfgs.flatMap((c) => c.servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])));

const UNREACHABLE_TEXT = 'Direct connection blocked — this network needs a TURN relay (Settings → TURN)';

test('criterion 7: TURN server (URL/user/password) from Settings reaches every peer connection config', async () => {
  const T = await launchApp('T', { initScript: SPY_PCS });
  const N = await launchApp('N', { initScript: SPY_PCS }); // negative control: no TURN configured
  try {
    // TURN must be set before the first join (Trystero's offer pool is global and uses the first room's config)
    await T.page.click('#nav >> text=Settings');
    await T.page.fill('input[aria-label="TURN URL"]', 'turn:turn.e2e.invalid:3478');
    await T.page.fill('input[aria-label="TURN username"]', 'e2e-user');
    await T.page.fill('input[aria-label="TURN password"]', 'e2e-pass');
    await T.page.click('.settings-actions .btn:has-text("Save")');
    await expect(T.page.locator('.settings-save-status')).toHaveText(/Saved/i);
    await T.page.click('#nav >> text=Stream Control');
    await createRoomUI(T);
    await createRoomUI(N);

    const cfgs = await until(async () => { const c = await iceServers(T.page); return c.length >= 1 ? c : null; }, 30_000, 'peer connections created after joining');
    for (const c of cfgs) {
      const turn = c.servers.filter((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
      expect(turn, JSON.stringify(c.servers)).toHaveLength(1);
      expect(turn[0]).toMatchObject({ urls: ['turn:turn.e2e.invalid:3478'], username: 'e2e-user', credential: 'e2e-pass' });
      expect(c.servers.some((s) => [].concat(s.urls).some((u) => /^stun:/.test(u))), 'default STUN servers are kept next to TURN').toBe(true);
    }
    // negative control
    const ncfgs = await until(async () => { const c = await iceServers(N.page); return c.length >= 1 ? c : null; }, 30_000, 'control peer connections');
    expect(urlsOf(ncfgs).filter((u) => /^turns?:/.test(u))).toEqual([]);
    expect(realErrors(T, N)).toEqual([]);
  } finally { await T.close(); await N.close(); }
});

test('criterion 7: an unreachable peer shows "Direct connection blocked" (relay-only, no TURN)', async () => {
  const A = await launchApp('A');
  const B = await launchApp('B', { initScript: FORCE_RELAY });
  try {
    const { code } = await createRoomUI(A, 'blocked room');
    await joinRoomUI(B, code);
    // Trystero reports "could not connect to peer" ~23 s after the answer (or ICE fails earlier)
    const note = B.page.locator('.room-unreachable');
    await expect(note.first()).toBeVisible({ timeout: 90_000 });
    await expect(note.first().locator('.room-unreachable-msg')).toHaveText(UNREACHABLE_TEXT);
    expect(await B.page.evaluate(() => window.__pcs.every((pc) => pc.getConfiguration().iceTransportPolicy === 'relay'))).toBe(true);
    // the note is a shortcut to Settings (TURN)
    await note.first().click();
    await expect(B.page.locator('.tab-panel[data-tab="Settings"]')).toBeVisible();
    await expect(B.page.locator('input[aria-label="TURN URL"]')).toBeVisible();
    // it is reported for the peer, not as an app error
    expect(realErrors(A, B)).toEqual([]);
  } finally { await A.close(); await B.close(); }
});
