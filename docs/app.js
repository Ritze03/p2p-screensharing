// P2P Screensharing - web client. One page, plain ES modules, no build step.
// All networking lives in ./p2p/core.js (a copy of the desktop app's backend; see tools/sync-web.sh),
// so share codes and rooms are interchangeable with the Electron app.
import { createBackend, supportedCodecs } from './p2p/core.js';

const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const isFirefox = /firefox/i.test(navigator.userAgent);
const secure = window.isSecureContext && !!window.RTCPeerConnection && !!globalThis.crypto?.subtle;

// ?testCapture=canvas swaps getDisplayMedia for a canvas stream (headless tests only, see test-capture.js).
const testGdm = qs.get('testCapture') === 'canvas' ? (await import('./test-capture.js')).canvasGetDisplayMedia(qs) : undefined;
const canShare = secure && (!!testGdm || !!navigator.mediaDevices?.getDisplayMedia);

const backend = createBackend({ captureAudio: !isFirefox, ...(testGdm ? { getDisplayMedia: testGdm } : {}) });
window.__P2P_BACKEND__ = backend; // same debug handle as the desktop app (tests)
window.P2P = backend.P2P;
const { invoke, listen, P2P } = backend;

const UNREACHABLE_TEXT = 'Direct connection blocked — this network needs a TURN relay (Settings → TURN)';
const TURN_URL_SHAPE = /^turns?:\S+$/i;

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
let rooms = []; // list_saved_rooms
let selected = null; // roomId
const details = new Map(); // roomId -> room_detail (joined rooms only)
let activeStreams = []; // list_active_streams
const unreachable = new Map(); // roomId -> Map(peerId -> name)
const tiles = new Map(); // "roomId/owner/sid" -> tile record
const myStats = new Map(); // destination_id -> stats

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
const ICONS = {
  fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z',
};
function svgIcon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]);
  s.append(p);
  return s;
}
const errText = (e) => String((e && e.message) || e);

let msgTimer = 0;
function showError(e) {
  const box = $('msg');
  box.textContent = errText(e);
  box.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => (box.hidden = true), 8000);
}
/** Run an async UI action; surface errors in the banner. */
const act = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    showError(e);
  }
};

let refreshTimer = 0;
function schedule() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = 0;
    refresh().catch((e) => console.warn('[web] refresh failed', e));
  }, 40);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const i = $('room-code');
    i.select();
    document.execCommand('copy'); // clipboard API unavailable (insecure context / permissions)
  }
  const old = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = old), 1200);
}

// ---------------------------------------------------------------------------
// rendering: rooms, room card
// ---------------------------------------------------------------------------
let refreshing = false;
let dirty = false;
async function refresh() {
  if (refreshing) { dirty = true; return; } // one refresh at a time; a request during one re-runs it
  refreshing = true;
  try {
    do {
      dirty = false;
      const list = await invoke('list_saved_rooms');
      const next = new Map();
      await Promise.all(list.filter((r) => r.state === 'joined').map(async (r) => next.set(r.roomId, await invoke('room_detail', { roomId: r.roomId }))));
      activeStreams = await invoke('list_active_streams');
      rooms = list;
      details.clear();
      for (const [k, v] of next) details.set(k, v);
      if (!rooms.some((r) => r.roomId === selected)) selected = (rooms.find((r) => r.state === 'joined') || rooms[0] || {}).roomId || null;
      renderRooms();
      renderRoom();
      syncTiles();
    } while (dirty);
  } finally {
    refreshing = false;
  }
}

function renderRooms() {
  $('rooms-list').replaceChildren(
    ...rooms.map((r) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(r.roomId === selected), onclick: () => { selected = r.roomId; renderRooms(); renderRoom(); } },
        h('span', { class: 'dot' + (r.state === 'joined' ? ' live' : '') }),
        h('span', { text: r.name }))),
  );
}

function renderRoom() {
  const r = rooms.find((x) => x.roomId === selected);
  $('room-card').hidden = !r;
  if (!r) return;
  const joined = r.state === 'joined';
  $('room-title').textContent = r.name;
  const pill = $('room-state');
  pill.textContent = joined ? 'Connected' : 'Not connected';
  pill.classList.toggle('live', joined);
  $('room-code').value = r.code;
  $('room-error').hidden = !r.error;
  $('room-error').textContent = r.error || '';

  const un = unreachable.get(r.roomId);
  const note = $('unreachable');
  note.hidden = !(joined && un && un.size);
  if (!note.hidden) note.replaceChildren(h('b', { text: [...un.values()].join(', ') }), document.createTextNode(UNREACHABLE_TEXT));

  $('room-actions').replaceChildren(
    ...(joined
      ? [h('button', { class: 'btn btn-secondary', type: 'button', text: 'Leave', onclick: act(() => leave(r)) })]
      : [
          h('button', { class: 'btn btn-primary', type: 'button', text: 'Reconnect', onclick: act(() => join(r.code, r.name)) }),
          h('button', { class: 'btn btn-secondary', type: 'button', text: 'Forget', onclick: act(async () => { await invoke('forget_room', { roomId: r.roomId }); schedule(); }) }),
        ]),
  );

  const d = details.get(r.roomId) || { members: [], streams: [], watched: [] };
  $('members').replaceChildren(
    ...d.members.map((m) => h('li', {}, h('span', { class: 'grow', text: m.display_name }), m.conn_id === P2P.selfId ? h('span', { class: 'meta', text: 'you' }) : null)),
  );
  const nameOf = (id) => d.members.find((m) => m.conn_id === id)?.display_name || id;
  const watching = (s) => d.watched.some((w) => w.owner === s.owner && w.stream_id === s.stream_id);
  $('streams').replaceChildren(
    ...d.streams.map((s) => {
      const on = watching(s);
      return h('li', {},
        h('span', { class: 'grow', text: `${nameOf(s.owner)} — ${s.label}` }),
        h('span', { class: 'meta', text: s.width && s.height ? `${s.width}×${s.height}${s.audio ? ' ♪' : ''}` : '' }),
        h('button', { class: 'btn btn-sm ' + (on ? 'btn-on' : 'btn-secondary'), type: 'button', 'aria-pressed': String(on), text: on ? 'Watching' : 'Watch',
          onclick: act(async () => { await invoke('toggle_watch', { roomId: r.roomId, owner: s.owner, streamId: s.stream_id }); schedule(); }) }));
    }),
  );
  $('streams-empty').hidden = d.streams.length > 0 || !joined;

  $('share-panel').hidden = !(canShare && joined);
  renderMyShares(r);
}

function renderMyShares(r) {
  const mine = activeStreams.filter((s) => s.roomId === r.roomId);
  $('my-shares').replaceChildren(
    ...mine.map((s) => {
      const st = myStats.get(s.destination_id);
      const meta = st ? `${Math.round(st.sent_fps)} fps · ${(st.bitrate_kbps / 1000).toFixed(1)} Mbps · ${st.watchers} watching` : s.state;
      return h('li', {},
        h('span', { class: 'dot ' + (s.state === 'live' ? 'live' : 'prog') }),
        h('span', { class: 'grow', text: 'Your screen' }),
        h('span', { class: 'meta', text: `${s.width || '?'}×${s.height || '?'} · ${meta}` }),
        h('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'Stop', onclick: act(async () => { await invoke('stop_destination', { destinationId: s.destination_id }); schedule(); }) }));
    }),
  );
}

// ---------------------------------------------------------------------------
// join / create / leave
// ---------------------------------------------------------------------------
async function join(code, name) {
  const res = await invoke('join_room', { code, name });
  await invoke('set_room_auto_connect', { roomId: res.roomId, autoConnect: true });
  selected = res.roomId;
  await refresh();
}
async function leave(r) {
  await invoke('set_room_auto_connect', { roomId: r.roomId, autoConnect: false });
  await invoke('leave_room', { roomId: r.roomId });
  await refresh();
}
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    await join($('join-code').value);
    $('join-code').value = '';
  })();
});
$('create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    const res = await invoke('create_room', { name: $('create-name').value });
    await invoke('set_room_auto_connect', { roomId: res.roomId, autoConnect: true });
    selected = res.roomId;
    $('create-name').value = '';
    await refresh();
  })();
});
$('copy-code').addEventListener('click', (e) => copyText($('room-code').value, e.currentTarget));

// ---------------------------------------------------------------------------
// "Direct connection blocked": peer_unreachable sets, peer_connected / peer_left clear
// ---------------------------------------------------------------------------
function peerUnreachable(p) {
  if (!p || p.roomId == null || p.peerId == null) return;
  if (!unreachable.has(p.roomId)) unreachable.set(p.roomId, new Map());
  unreachable.get(p.roomId).set(p.peerId, p.peerName || String(p.peerId));
  renderRoom();
}
function peerConnected(p) {
  const m = p && unreachable.get(p.roomId);
  if (!m) return;
  m.delete(p.peerId);
  if (!m.size) unreachable.delete(p.roomId);
  renderRoom();
}
listen('peer_unreachable', ({ payload }) => peerUnreachable(payload));
listen('peer_connected', ({ payload }) => peerConnected(payload));
listen('peer_left', ({ payload }) => peerConnected(payload));
window.WebClient = { peerUnreachable, peerConnected }; // console/test hook, like the desktop app's Shell.peerUnreachable
const openSettings = () => $('settings-dlg').showModal();
$('unreachable').addEventListener('click', openSettings);
$('unreachable').addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openSettings()));

for (const ev of ['room-connected', 'room-disconnected', 'presence-updated', 'destination-state-changed', 'staged-capture-changed']) listen(ev, schedule);
listen('room-connect-failed', ({ payload: p }) => {
  if (p && p.kind !== 'wrong-password' && p.error) showError(p.error);
  schedule();
});

// ---------------------------------------------------------------------------
// share screen (desktop browsers only)
// ---------------------------------------------------------------------------
const FPS_OPTIONS = [15, 30, 60];
const shareState = { fps: 60, kbps: 8000, codec: 'h264', preset: 'balanced' };

async function initShareControls() {
  if (!canShare) return;
  const d = await invoke('get_start_stream_defaults');
  shareState.fps = FPS_OPTIONS.includes(d.framerate) ? d.framerate : 60;
  shareState.kbps = Math.min(20000, Math.max(500, d.bitrate_kbps));
  shareState.codec = d.codec;
  shareState.preset = d.preset;

  const seg = $('fps-seg');
  const paint = () => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.fps) === shareState.fps)));
  for (const f of FPS_OPTIONS) seg.append(h('button', { type: 'button', 'data-fps': String(f), text: String(f), onclick: () => { shareState.fps = f; paint(); } }));
  paint();

  const br = $('bitrate');
  br.value = shareState.kbps;
  const showBr = () => ($('bitrate-val').textContent = `${(Number(br.value) / 1000).toFixed(1)} Mbps`);
  br.addEventListener('input', () => { shareState.kbps = Number(br.value); showBr(); });
  showBr();

  $('preset').value = shareState.preset;
  $('preset').addEventListener('change', () => (shareState.preset = $('preset').value));

  const codecs = supportedCodecs();
  $('codec').replaceChildren(...codecs.map((c) => h('option', { value: c, text: c.toUpperCase() })));
  $('codec').value = codecs.includes(shareState.codec) ? shareState.codec : codecs[0];
  shareState.codec = $('codec').value;
  $('codec').addEventListener('change', () => (shareState.codec = $('codec').value));
  $('codec').hidden = $('codec-label').hidden = codecs.length < 2;

  $('audio-row').hidden = isFirefox;
  $('share-hint').textContent = isFirefox ? 'Firefox cannot capture audio.' : 'System audio is only offered by some browsers/platforms (for example a Chrome tab or Windows screen).';
  $('share-btn').addEventListener('click', act(startShare));
}

async function startShare() {
  const r = rooms.find((x) => x.roomId === selected);
  if (!r || r.state !== 'joined') throw new Error('Join a room first.');
  const btn = $('share-btn');
  btn.disabled = true;
  const p = { framerate: shareState.fps, bitrateKbps: shareState.kbps, codec: shareState.codec, preset: shareState.preset, shareAudio: $('audio').checked && !isFirefox };
  let captureId = null;
  try {
    await invoke('set_start_stream_defaults', p); // also seeds the capture frame rate
    ({ captureId } = await invoke('stage_video_share')); // opens the browser's screen picker (needs this click)
    await invoke('go_live', { captureId, roomId: r.roomId, ...p });
    const staged = (await invoke('list_active_streams')).find((s) => s.capture_id === captureId);
    if (p.shareAudio && staged && !staged.audio) $('share-hint').textContent = 'No audio track was provided for this capture; sharing video only.';
  } catch (e) {
    if (captureId != null) await invoke('stop_share', { captureId }).catch(() => {});
    if (e && e.name === 'NotAllowedError') return; // picker cancelled
    throw e;
  } finally {
    btn.disabled = false;
    schedule();
  }
}

// ---------------------------------------------------------------------------
// watching: tiles
// ---------------------------------------------------------------------------
const tileKey = (roomId, owner, sid) => `${roomId}/${owner}/${sid}`;

function makeTile(key, roomId, owner, sid) {
  const video = h('video', { autoplay: '', playsinline: '' });
  video.autoplay = true;
  video.playsInline = true;
  const name = h('span', { class: 'grow' });
  const stats = h('span', { class: 'tile-stats' });
  const wait = h('div', { class: 'tile-wait', text: 'Connecting…' });
  const muteBtn = h('button', { class: 'tbtn', type: 'button', title: 'Mute / unmute', 'aria-label': 'Mute or unmute' });
  const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume' });
  const fsBtn = h('button', { class: 'tbtn', type: 'button', title: 'Fullscreen', 'aria-label': 'Fullscreen' }, svgIcon('fullscreen'));
  const closeBtn = h('button', { class: 'tbtn', type: 'button', title: 'Stop watching', 'aria-label': 'Stop watching' }, svgIcon('close'));
  const unmute = h('button', { class: 'btn btn-primary tile-unmute', type: 'button', text: 'Click to unmute', hidden: '' });
  const el = h('figure', { class: 'tile', 'data-key': key },
    video, wait, unmute,
    h('div', { class: 'tile-top' }, name, stats),
    h('div', { class: 'tile-bar' }, muteBtn, vol, h('span', { class: 'grow' }), fsBtn, closeBtn));
  const t = { key, roomId, owner, sid, el, video, name, stats, wait, muteBtn, vol, unmute, stream: null };

  const paintMute = () => {
    muteBtn.replaceChildren(svgIcon(video.muted || video.volume === 0 ? 'mute' : 'volume'));
    unmute.hidden = !t.needsUnmute || !video.muted;
  };
  t.paintMute = paintMute;
  muteBtn.addEventListener('click', () => { video.muted = !video.muted; t.needsUnmute = false; paintMute(); });
  unmute.addEventListener('click', () => { video.muted = false; t.needsUnmute = false; paintMute(); video.play().catch(() => {}); });
  vol.addEventListener('input', () => { video.volume = Number(vol.value); if (video.volume > 0 && video.muted) video.muted = false; paintMute(); });
  const toggleFs = () => {
    if (document.fullscreenElement === el) return document.exitFullscreen();
    const fs = el.requestFullscreen ? el.requestFullscreen() : video.webkitEnterFullscreen && video.webkitEnterFullscreen();
    if (fs && fs.catch) fs.catch((e) => showError(e));
  };
  fsBtn.addEventListener('click', toggleFs);
  video.addEventListener('dblclick', toggleFs);
  closeBtn.addEventListener('click', act(async () => {
    await invoke('toggle_watch', { roomId, owner, streamId: sid });
    schedule();
  }));
  el.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && el.classList.add('touch'));
  video.addEventListener('playing', () => (wait.hidden = true));
  paintMute();
  return t;
}

async function attach(t, stream) {
  if (t.stream === stream) return;
  t.stream = stream;
  const v = t.video;
  v.srcObject = stream;
  const hasAudio = stream.getAudioTracks().length > 0;
  t.vol.hidden = t.muteBtn.hidden = !hasAudio;
  stream.addEventListener('addtrack', () => {
    const a = stream.getAudioTracks().length > 0;
    t.vol.hidden = t.muteBtn.hidden = !a;
  });
  try {
    await v.play();
  } catch {
    // Autoplay with sound needs a gesture: fall back to muted playback and offer an unmute button.
    v.muted = true;
    t.needsUnmute = hasAudio;
    await v.play().catch(() => {});
  }
  t.paintMute();
}

function syncTiles() {
  const want = new Map();
  for (const [roomId, d] of details) {
    for (const w of d.watched) {
      const key = tileKey(roomId, w.owner, w.stream_id);
      const s = d.streams.find((x) => x.owner === w.owner && x.stream_id === w.stream_id);
      const who = d.members.find((m) => m.conn_id === w.owner)?.display_name || w.owner;
      want.set(key, { roomId, owner: w.owner, sid: w.stream_id, title: `${who} — ${s ? s.label : 'Screen'}` });
    }
  }
  for (const [key, t] of tiles) {
    if (!want.has(key)) {
      t.video.srcObject = null;
      t.el.remove();
      tiles.delete(key);
    }
  }
  for (const [key, w] of want) {
    let t = tiles.get(key);
    if (!t) {
      t = makeTile(key, w.roomId, w.owner, w.sid);
      tiles.set(key, t);
      $('tiles').append(t.el);
    }
    t.name.textContent = w.title;
    const stream = P2P.getStream(w.roomId, w.owner, w.sid);
    if (stream) attach(t, stream);
  }
  $('tiles-empty').hidden = tiles.size > 0;
}

P2P.onStream(({ roomId, owner, stream_id, stream }) => {
  const t = tiles.get(tileKey(roomId, owner, stream_id));
  if (t) attach(t, stream);
  else schedule();
});
P2P.onStreamRemoved(({ roomId, owner, stream_id }) => {
  const t = tiles.get(tileKey(roomId, owner, stream_id));
  if (t) {
    t.stream = null;
    t.video.srcObject = null;
    t.wait.hidden = false;
  }
  schedule();
});

// Stats arrive about once a second from the backend; the overlay is updated from the event only (never per frame).
listen('stream-stats-updated', ({ payload }) => {
  const seen = new Set();
  for (const w of payload.watched || []) {
    const key = tileKey(w.roomId, w.owner, w.stream_id);
    seen.add(key);
    const t = tiles.get(key);
    if (!t) continue;
    const res = w.width && w.height ? ` · ${w.width}×${w.height}` : '';
    t.stats.textContent = `${Math.round(w.fps)} fps${res} · ${(w.bitrate_kbps / 1000).toFixed(1)} Mbps`;
  }
  for (const [key, t] of tiles) if (!seen.has(key)) t.stats.textContent = '';
  myStats.clear();
  for (const d of payload.destinations || []) myStats.set(d.destination_id, d);
  const r = rooms.find((x) => x.roomId === selected);
  if (r) renderMyShares(r);
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
const setStatus = (text, err) => {
  $('set-status').textContent = text;
  $('set-status').classList.toggle('err', !!err);
};
$('settings-btn').addEventListener('click', act(async () => {
  const s = await invoke('get_settings');
  $('set-name').value = s.displayName;
  $('set-url').value = s.turnUrl;
  $('set-user').value = s.turnUsername;
  $('set-pass').value = s.turnPassword;
  setStatus('');
  openSettings();
}));
$('set-close').addEventListener('click', () => $('settings-dlg').close());
$('settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    const url = $('set-url').value.trim();
    const user = $('set-user').value.trim();
    const pass = $('set-pass').value;
    // Same rules as the desktop Settings tab: a TURN URL needs a username and password (all three or none).
    if (url && !TURN_URL_SHAPE.test(url)) return setStatus('The URL should look like turn:host:3478 (or turns:…).', true);
    if (url && (!user || !pass)) return setStatus('A TURN URL needs both a username and a password.', true);
    if (!url && (user || pass)) return setStatus('Username and password are only used together with a TURN URL.', true);
    try {
      await invoke('set_settings', { displayName: $('set-name').value.trim(), turnUrl: url, turnUsername: user, turnPassword: pass });
      setStatus('Saved');
      schedule();
    } catch (err) {
      setStatus(`Could not save: ${errText(err)}`, true);
    }
  })();
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
if (!secure) {
  const n = $('env-note');
  n.hidden = false;
  n.textContent = 'This page needs a secure context (https:// or localhost) and WebRTC support. Open it over https.';
}
try {
  const hash = location.hash.slice(1);
  if (hash) $('join-code').value = decodeURIComponent(hash);
} catch { /* ignore */ }

await backend.ready;
await initShareControls();
await refresh();
