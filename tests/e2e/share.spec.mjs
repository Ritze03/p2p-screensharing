// Main flow with two real app instances + real screen capture (headless X11 by default):
//   criterion 3 (viewer receives+renders frames), 4 (wrong password), 5 (codec/fps/bitrate on the sender),
//   6 (hardware encoder), 8 (dropped features gone; no console errors create/join/share/view/pop out).
import { test, expect } from '@playwright/test';
import {
  launchApp, createRoomUI, joinRoomUI, waitPaired, shareScreenUI, animateDamage, watchViaUI, countFrames,
  senderInfo, inv, until, sleep, collectUiText, droppedHits, realErrors, ignoredErrors,
} from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

let A, B, C, code, roomId;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  A = await launchApp('A');
  B = await launchApp('B');
  ({ code, roomId } = await createRoomUI(A, 'e2e room'));
  const bRoom = await joinRoomUI(B, code);
  expect(bRoom).toBe(roomId); // same share code -> same room id
  await waitPaired(A, B, roomId);
  // the creator's room name reaches the joiner through hello (joiner's own card sends no name)
  await until(async () => (await inv(B, 'list_saved_rooms'))[0]?.name === 'e2e room', 20_000, 'B shows the creator\'s room name');
});

test.afterAll(async () => {
  for (const w of [A, B, C]) await w?.close();
});

test('criterion 3: two instances join the same code; viewer receives and renders video frames', async () => {
  // A shares through the real UI (H.264 / 90 fps / 6000 kbps / gaming chosen on the staged card)
  await shareScreenUI(A, async (page) => {
    await page.click('.dest-tuning-toggle .mode-toggle-btn:has-text("H.264")');
    await page.click('.dest-tuning-toggle .mode-toggle-btn:has-text("Gaming")');
    await page.click('.dest-framerate-select');
    await page.click('.dd-option:has-text("90 fps")');
    await page.evaluate(() => {
      const s = document.querySelector('.dest-bitrate-slider');
      s.value = 6000;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // the card shows what we picked (catches clicks lost to a re-render)
    await expect(page.locator('.dest-tuning-toggle .mode-toggle-btn-active').first()).toHaveText('H.264');
    await expect(page.locator('.dest-framerate-select')).toContainText('90 fps');
    await expect(page.locator('.dest-bitrate-value')).toHaveText('6000 kbps');
  });
  await animateDamage(A.page); // Wayland delivers frames only on damage
  await until(async () => (await inv(B, 'room_detail', { roomId })).streams.length, 30_000, 'B sees A\'s stream in room_detail');
  await watchViaUI(B);
  const v = await countFrames(B.page, '#view-root video', 4000);
  expect(v.w).toBeGreaterThan(0);
  expect(v.h).toBeGreaterThan(0);
  expect(v.frames, `frames presented in 4 s: ${JSON.stringify(v)}`).toBeGreaterThan(20);
  // the receiving side's own stats agree that media flows
  const inbound = await B.page.evaluate(async () => {
    const out = [];
    for (const r of window.__P2P_BACKEND__._debug.rooms.values()) {
      for (const pc of Object.values(r.tr?.getPeers?.() || {})) (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') out.push({ framesDecoded: s.framesDecoded, framesReceived: s.framesReceived }); });
    }
    return out;
  });
  expect(inbound.some((s) => s.framesDecoded > 0)).toBe(true);
});

// The outbound encoder starts as software OpenH264 for the first ~7 s (WebRTC ramps 480x270 -> 1080p) and
// then the VA-API encoder takes over, so poll instead of sampling once.
const hwEncoderOn = (page) => until(async () => {
  const [i] = await senderInfo(page);
  return i?.stats?.framesEncoded > 0 && i.stats.encoderImplementation === 'VaapiVideoEncodeAccelerator' ? i : null;
}, 30_000, 'outbound-rtp encoderImplementation == VaapiVideoEncodeAccelerator');

test('criterion 6: outbound encoder is hardware (VaapiVideoEncodeAccelerator for H.264)', async () => {
  const info = await hwEncoderOn(A.page);
  expect(info.stats.powerEfficientEncoder).toBe(true);
  expect(info.stats.encoderImplementation).not.toMatch(/libvpx|OpenH264|libaom/i);
});

// On failure, attach sender/stream/viewer state so flaky runs are diagnosable.
async function diag() {
  const safe = async (f) => { try { return await f(); } catch (e) { return `ERR ${e.message}`; } };
  return JSON.stringify({
    senders: await safe(() => senderInfo(A.page)),
    active: await safe(() => inv(A, 'list_active_streams')),
    bDetail: await safe(() => inv(B, 'room_detail', { roomId })),
    bVideo: await safe(() => B.page.evaluate(() => { const v = document.querySelector('#view-root video'); return v ? { w: v.videoWidth, rs: v.readyState } : null; })),
    bSaved: await safe(() => inv(B, 'list_saved_rooms')),
    aCalls: await safe(() => A.page.evaluate(() => window.__calls)),
    aErrors: A.errors, bErrors: B.errors,
  }, null, 1);
}

test('criterion 5: chosen codec, max fps and bitrate are applied to the outbound sender', async () => {
  test.info().annotations.push({ type: 'note', description: 'diag attached on failure' });
  try { await crit5(); } catch (e) { e.message += `\n--- diag ---\n${await diag()}`; throw e; }
});

async function crit5() {
  // (a) values picked in the UI before Go live
  const [s0] = await senderInfo(A.page);
  expect(s0.codec0).toMatch(/H264/i);
  expect(s0.enc.maxFramerate).toBe(90);
  expect(s0.enc.maxBitrate).toBe(6_000_000);
  // (b) live edits (edit_destination is what the card's Apply does): VP9 / 60 fps / 5000 kbps
  const edit = async (over) => {
    const cur = (await inv(A, 'list_active_streams'))[0];
    await inv(A, 'edit_destination', { destinationId: cur.destination_id, framerate: cur.framerate, bitrateKbps: cur.bitrate_kbps, codec: cur.codec, preset: cur.preset, ...over });
  };
  await edit({ codec: 'vp9', framerate: 60, bitrateKbps: 5000 });
  const vp9 = await until(async () => {
    const [i] = await senderInfo(A.page);
    return i && /VP9/i.test(i.codec0) && i.enc.maxFramerate === 60 && i.enc.maxBitrate === 5_000_000 ? i : null;
  }, 20_000, 'sender reports VP9 / 60 fps / 5 Mbps');
  expect(vp9.codec0).toMatch(/VP9/i);
  // (c) back to H.264 with max fps 120 and 4000 kbps
  await edit({ codec: 'h264', framerate: 120, bitrateKbps: 4000, preset: 'quality' });
  const h264 = await until(async () => {
    const [i] = await senderInfo(A.page);
    return i && /H264/i.test(i.codec0) && i.enc.maxFramerate === 120 && i.enc.maxBitrate === 4_000_000 && i.stats?.framesEncoded > 0 ? i : null;
  }, 30_000, 'sender reports H264 / 120 fps / 4 Mbps');
  expect(h264.enc.maxFramerate).toBe(120);
  // the viewer keeps receiving after the codec round trip
  await until(async () => (await countFrames(B.page, '#view-root video', 2000)).frames > 10, 30_000, 'viewer frames advance after codec round trip');
}

test('criterion 6: hardware encoder is used again after switching codec VP9 -> H.264', async () => {
  const info = await hwEncoderOn(A.page);
  expect(info.stats.encoderImplementation).toBe('VaapiVideoEncodeAccelerator');
});

test('criterion 4: same room part + wrong password never sees the peers or the stream', async () => {
  const mark = { A: A.errors.length, B: B.errors.length };
  const listenFailed = (w) => w.page.evaluate(() => { window.__failed = []; return window.__TAURI__.event.listen('room-connect-failed', (e) => window.__failed.push(e.payload)); });
  await listenFailed(A);
  await listenFailed(B);
  C = await launchApp('C');
  // build a code with A's room part and a different secret (28-char part)
  const wrongCode = await C.page.evaluate(async ([code]) => {
    const m = await import(new URL('p2p/sharecode.js', location.href).href);
    const p = m.parseShareCode(code);
    const q = m.parseShareCode(m.generateShareCode());
    return m.buildShareCode(p.roomPart, q.secret);
  }, [code]);
  expect(wrongCode).not.toBe(code);
  await listenFailed(C);
  const cRoom = await joinRoomUI(C, wrongCode);
  expect(cRoom).toBe(roomId); // room id is derived from the room part only
  // Evidence that the intruder and the room's peers really met: somebody (C, or A/B when they receive C's offer)
  // reports "incorrect room password". Discovery over public Nostr relays is slow/variable, so allow up to 100 s.
  const t0 = Date.now();
  const who = await until(async () => {
    for (const w of [C, A, B]) if (await w.page.evaluate(() => window.__failed.some((f) => /incorrect room password/i.test(f.error || '')))) return w.name;
    return null;
  }, 100_000, 'room-connect-failed "incorrect room password" on C, A or B');
  console.log(`  (wrong-password error event on ${who} after ${Math.round((Date.now() - t0) / 1000)} s)`);
  await sleep(20_000);
  const d = await inv(C, 'room_detail', { roomId });
  const selfId = await C.page.evaluate(() => window.P2P.selfId);
  expect(d.members.map((m) => m.conn_id)).toEqual([selfId]); // only itself
  expect(d.streams).toEqual([]);
  expect(d.watched).toEqual([]);
  const peers = await C.page.evaluate((id) => Object.keys(window.__P2P_BACKEND__._debug.rooms.get(id).tr?.getPeers?.() || {}), roomId);
  expect(peers).toEqual([]);
  expect(await C.page.evaluate(() => window.P2P.getStreams().length)).toBe(0);
  // ...and the real room is unaffected: A and B still see exactly each other, A still live
  expect(await inv(A, 'room_detail', { roomId }).then((x) => x.members.length)).toBe(2);
  expect(await inv(B, 'room_detail', { roomId }).then((x) => x.members.length)).toBe(2);
  expect((await inv(A, 'list_active_streams')).length).toBe(1);
  await C.close();
  C = null;
  // Expected side effect of the intruder: legitimate peers also receive its (undecryptable) offers, and the GUI
  // logs those as console.error("room-connect-failed ... incorrect room password"). Not an error of the flows under test.
  for (const w of [A, B]) {
    const fresh = w.errors.splice(mark[w.name]);
    for (const e of fresh) (/room-connect-failed.*incorrect room password/i.test(e) ? w.ignored : w.errors).push(e);
  }
});

test('pop-out: viewer window renders the stream from the opener; closing restores the tile', async () => {
  const popupP = B.app.waitForEvent('window', { timeout: 20_000 });
  await B.page.click('#nav >> text=View');
  await B.page.hover('#view-root .media-tile');
  await B.page.click('.media-tile-popout-btn[title="Pop out"]');
  const popup = await popupP;
  await popup.waitForLoadState('domcontentloaded');
  await until(() => popup.evaluate(() => document.querySelector('video')?.videoWidth > 0), 30_000, 'popup <video> videoWidth > 0');
  const f = await countFrames(popup, 'video', 3000);
  expect(f.frames, JSON.stringify(f)).toBeGreaterThan(10);
  await popup.click('.viewer-exit-btn');
  await until(() => B.page.evaluate(() => !document.querySelector('.media-tile-held') && !!document.querySelector('#view-root video')), 10_000, 'held slot released, tile video back');
  await until(() => B.page.evaluate(() => document.querySelector('#view-root video')?.videoWidth > 0), 15_000, 'tile video renders again');
});

test('criterion 8: dropped features absent while sharing (A) and viewing (B)', async () => {
  for (const w of [A, B]) expect(droppedHits(await collectUiText(w.page)), `${w.name}: dropped feature visible`).toEqual([]);
  // live card: per-share controls are codec/preset/fps/bitrate/audio-on-off only
  await A.page.click('#nav >> text=Stream Control');
  const card = await A.page.innerText('.dest-card');
  expect(card).not.toMatch(/jitter|bandwidth|transfer|presentation|source/i);
});

test('viewer leaves while watching (confirm modal), then sharer stops the share', async () => {
  // Leaving a room you are watching in asks for confirmation
  await B.page.click('.room-row-action-btn[title="Leave room"]');
  await expect(B.page.locator('.leave-modal')).toBeVisible();
  await expect(B.page.locator('.leave-modal')).toContainText(/watching 1 stream/i);
  await B.page.click('.leave-modal .btn-danger-solid:has-text("Leave room")');
  await until(async () => (await inv(B, 'list_saved_rooms'))[0]?.state === 'disconnected', 10_000, 'B room disconnected after confirmed Leave');
  await until(() => B.page.evaluate(() => !document.querySelector('#view-root video')), 10_000, 'B tile gone after leaving');
  // A's share stops through the UI
  await A.page.click('#nav >> text=Stream Control');
  await A.page.click('.dest-actions button:has-text("Stop")');
  await until(async () => (await inv(A, 'list_active_streams')).length === 0, 15_000, 'A has no active streams after Stop');
});

test('criterion 8: no console errors while creating, joining, sharing, viewing, popping out', async () => {
  const errs = realErrors(A, B);
  expect(errs, `console/page errors:\n${errs.join('\n')}`).toEqual([]);
  const ign = [...new Set(ignoredErrors(A, B).map((e) => e.replace(/^\[\w+\] /, '').slice(0, 140)))];
  console.log(`  (ignored ${ignoredErrors(A, B).length} env/expected console errors:\n    ${ign.join('\n    ')})`);
});
