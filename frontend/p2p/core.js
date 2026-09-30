// core.js - browser-only P2P backend core (no Electron, no Node APIs).
//
// Implements the GUI command/event surface documented in
// .claude/teamlead/plan/gui-contract.md on top of Trystero (vendored) and
// Chromium-native WebRTC. The Electron GUI reaches it through tauri-shim.js;
// the future GitHub-Pages client can import this file directly.
//
//   import { createBackend } from './core.js';
//   const b = createBackend();            // idempotent-safe: create ONE per page
//   await b.invoke('create_room', { name: 'Movie night' });
//   b.listen('presence-updated', ({ payload }) => ...);
//   b.P2P.getStream(roomId, owner, streamId)   // MediaStream for <video>.srcObject
//
// Model
//   room        = Trystero room derived from a share code (sharecode.js).
//   capture     = one getDisplayMedia MediaStream. "Staged" until it goes live.
//   destination = (capture, room). Owns a CLONE of the capture's tracks, so
//                 contentHint/stop are per destination and one capture can be
//                 fanned out to several rooms. destination_id doubles as the
//                 announced stream_id in its room.
//   Upload is only spent on watchers: the sharer announces its streams to the
//   room ('streams' action) and calls room.addStream(clone, {target}) only for
//   peers that sent a 'watch' request.
//
// Wire protocol (Trystero actions, all JSON):
//   hello   {name, room}           presence; room = the sender's room name ('' if it
//                                  has none of its own) — an unnamed joiner adopts it
//   streams [{stream_id,label,width,height,kind,audio}]   FULL list of the
//                                  sender's streams in this room (replace semantics)
//   watch   {sid, on}              viewer -> sharer
//   media   room.addStream(..., {metadata:{sid}}) -> viewer's onPeerStream(stream, peer, {sid})
//
// Peer-unreachable ("direct connection blocked") detection, and its limits:
//   Trystero keeps ~20 pre-warmed RTCPeerConnections in ONE offer pool shared by
//   all rooms and created from the first joined room's config, so a PC cannot be
//   tied to a room at construction. We therefore (1) map PCs of ACTIVE peers to
//   (room, peer) via room.getPeers() and watch their ICE 'failed', and (2) treat
//   Trystero's onJoinError "could not connect to peer <id> after exchanging SDP"
//   (fires ~23 s after the answer) as the signal for peers that never became
//   active. Unnamed pool PCs that fail are ignored. Consequence: TURN settings
//   only reach the offer pool when it is rebuilt (all rooms left, or app restart).

import { joinRoom as trysteroJoinRoom, selfId as trysteroSelfId } from '../vendor/trystero.mjs';
import { APP_ID, generateShareCode, parseShareCode, deriveRoom, SHARE_CODE_ERROR } from './sharecode.js';

export { APP_ID, generateShareCode, parseShareCode, deriveRoom, SHARE_CODE_ERROR };

const KEY_SETTINGS = 'p2p.settings';
const KEY_ROOMS = 'p2p.savedRooms';
const KEY_DEFAULTS = 'p2p.streamDefaults';

const MIME = { h264: 'video/h264', vp9: 'video/vp9', av1: 'video/av1', h265: 'video/h265' };
const CODEC_ORDER = ['h264', 'vp9', 'av1', 'h265'];

// preset -> track.contentHint + RTCRtpSendParameters.degradationPreference.
const PRESETS = {
  low_latency: { hint: 'motion', degr: 'maintain-framerate' },
  gaming: { hint: 'motion', degr: 'maintain-framerate' },
  balanced: { hint: '', degr: 'balanced' },
  quality: { hint: 'detail', degr: 'maintain-resolution' },
};
const normPreset = (p) => {
  const k = String(p ?? '').replace(/-/g, '_');
  return PRESETS[k] ? k : 'balanced';
};

const HARDCODED_DEFAULTS = { framerate: 60, bitrate_kbps: 8000, codec: 'h264', preset: 'balanced', share_audio: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const posInt = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 100000) : 0);

// ---------------------------------------------------------------------------
// Codec preference plumbing shared by every RTCPeerConnection Trystero makes.
// ---------------------------------------------------------------------------

/** track -> codec name; read by HookPC.addTrack (set right before addStream). */
const trackCodec = new WeakMap();
/** pc -> [{ entry, peerId }] for ACTIVE peers (filled in onPeerJoin). */
const pcOwner = new WeakMap();
/** track -> kbps; read by HookPC.addTrack to derive the BWE hints for the negotiation. */
const trackBitrate = new WeakMap();
let iceHook = null;
let HookPC = null;

export function supportedCodecs() {
  try {
    const mimes = new Set(RTCRtpSender.getCapabilities('video').codecs.map((c) => c.mimeType.toLowerCase()));
    const out = CODEC_ORDER.filter((c) => mimes.has(MIME[c]));
    return out.length ? out : ['h264'];
  } catch {
    return ['h264'];
  }
}

function orderedCodecs(name) {
  const all = RTCRtpSender.getCapabilities('video').codecs;
  const pref = all.filter((c) => c.mimeType.toLowerCase() === MIME[name]);
  return pref.length ? [...pref, ...all.filter((c) => !pref.includes(c))] : all;
}

/**
 * Give the sender's bandwidth estimator a sane starting point. Chromium starts every call at ~300 kbps
 * and only then ramps (~8%/s), which at share start means ~30 s of OpenH264 at 480p-720p. x-google-start-bitrate /
 * x-google-min-bitrate on the video codecs of the REMOTE description (that is the description libwebrtc builds its
 * send codecs from) start the estimate at half the configured bitrate (max 6 Mbps) and stop it from collapsing
 * below min(10%, 1 Mbps). The real upper limit stays sender.setParameters({maxBitrate}).
 */
function mungeVideoSdp(sdp, kbps) {
  const params = `x-google-start-bitrate=${Math.round(Math.min(kbps * 0.5, 6000))};x-google-min-bitrate=${Math.round(Math.min(kbps * 0.1, 1000))}`;
  const skip = ['rtx', 'red', 'ulpfec', 'flexfec-03'];
  return sdp
    .split(/\r\n(?=m=)/)
    .map((sec) => {
      if (!sec.startsWith('m=video') || /\r\na=(sendonly|inactive)/.test(sec)) return sec;
      const lines = sec.split('\r\n');
      const names = new Map(); // payload type -> codec name
      for (const l of lines) {
        const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
        if (m) names.set(m[1], m[2].toLowerCase());
      }
      const ok = (pt) => names.has(pt) && !skip.includes(names.get(pt));
      const out = [];
      for (const l of lines) {
        const f = /^a=fmtp:(\d+) /.exec(l);
        const r = /^a=rtpmap:(\d+) /.exec(l);
        out.push(f && ok(f[1]) ? `${l};${params}` : l);
        if (r && ok(r[1]) && !lines.some((x) => x.startsWith(`a=fmtp:${r[1]} `))) out.push(`a=fmtp:${r[1]} ${params}`); // e.g. VP8 has no fmtp line
      }
      return out.join('\r\n');
    })
    .join('\r\n');
}

function getHookPC() {
  if (HookPC) return HookPC;
  HookPC = class HookPC extends RTCPeerConnection {
    constructor(cfg) {
      super(cfg);
      this.addEventListener('iceconnectionstatechange', () => iceHook && iceHook(this));
    }
    setRemoteDescription(desc, ...rest) {
      // Only PCs that carry one of our video tracks get the bitrate hints (see mungeVideoSdp).
      // Hint = the highest CURRENT bitrate among our live video senders (it follows edit_destination lowering it).
      let kbps = 0;
      try {
        for (const s of this.getSenders()) if (s.track && s.track.kind === 'video' && s.track.readyState === 'live') kbps = Math.max(kbps, trackBitrate.get(s.track) || 0);
      } catch {
        /* pc closed */
      }
      kbps = kbps || this.__p2pKbps;
      if (kbps && desc && desc.sdp) desc = { type: desc.type, sdp: mungeVideoSdp(desc.sdp, kbps) };
      return super.setRemoteDescription(desc, ...rest);
    }
    addTrack(track, ...streams) {
      if (track.kind === 'video' && trackBitrate.has(track)) this.__p2pKbps = trackBitrate.get(track);
      const sender = super.addTrack(track, ...streams);
      const codec = track.kind === 'video' ? trackCodec.get(track) : null;
      if (codec) {
        try {
          const tr = this.getTransceivers().find((t) => t.sender === sender);
          if (tr) tr.setCodecPreferences(orderedCodecs(codec));
        } catch (e) {
          console.warn('[p2p] setCodecPreferences failed', e);
        }
      }
      return sender;
    }
  };
  return HookPC;
}

// ---------------------------------------------------------------------------

function makeStore(storage) {
  let s = storage;
  if (!s) {
    try {
      s = globalThis.localStorage;
    } catch {
      s = null;
    }
  }
  return {
    get(key, fallback) {
      try {
        const raw = s && s.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, val) {
      try {
        if (s) s.setItem(key, JSON.stringify(val));
      } catch (e) {
        console.warn('[p2p] could not persist', key, e);
      }
    },
  };
}

/**
 * @param {object} [opts]
 * @param {Storage}  [opts.storage]        localStorage-like (default: localStorage)
 * @param {RTCConfiguration} [opts.rtcConfig]  extra RTCConfiguration WITHOUT iceServers (e.g. iceTransportPolicy for tests)
 * @param {boolean}  [opts.captureAudio=true]  ask for audio in getDisplayMedia (falls back to video-only)
 * @param {boolean}  [opts.autoConnect=true]   join saved rooms flagged auto_connect on startup
 * @param {Function} [opts.getDisplayMedia]    override (tests)
 */
export function createBackend(opts = {}) {
  const store = makeStore(opts.storage);
  const joinRoom = opts.joinRoom || trysteroJoinRoom;
  const gdm = opts.getDisplayMedia || ((c) => navigator.mediaDevices.getDisplayMedia(c));
  const myId = trysteroSelfId;
  const captureAudio = opts.captureAudio !== false;

  // ---- events ------------------------------------------------------------
  const listeners = new Map();
  function emit(name, payload) {
    for (const cb of [...(listeners.get(name) || [])]) {
      try {
        cb({ payload });
      } catch (e) {
        console.error('[p2p] listener error', name, e);
      }
    }
  }
  function listen(name, cb) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return Promise.resolve(() => listeners.get(name)?.delete(cb));
  }

  // ---- settings / defaults ------------------------------------------------
  const settings = { displayName: '', turnUrl: '', turnUsername: '', turnPassword: '' };
  for (const [k, v] of Object.entries(store.get(KEY_SETTINGS, {}))) if (typeof v === 'string' && k in settings) settings[k] = v;
  const defaults = { ...HARDCODED_DEFAULTS, ...store.get(KEY_DEFAULTS, {}) };
  const current = { ...defaults }; // process-wide values the set_* setters write and go_live reads

  const myName = () => settings.displayName.trim() || 'You';
  const wireName = () => settings.displayName.trim(); // empty => peers show "Guest xxxx"
  const turnConfig = () => {
    // A TURN entry without credentials makes Chromium throw InvalidAccessError on every RTCPeerConnection: ignore it.
    const url = settings.turnUrl.trim();
    if (!url || !settings.turnUsername || !settings.turnPassword) return null;
    return [{ urls: url, username: settings.turnUsername, credential: settings.turnPassword }];
  };

  // ---- state --------------------------------------------------------------
  /** roomId -> entry */
  const rooms = new Map();
  const captures = new Map();
  const destinations = new Map();
  let captureSeq = 0;
  let destSeq = 0;

  const persistRooms = () =>
    store.set(KEY_ROOMS, [...rooms.values()].map((r) => ({ roomId: r.roomId, code: r.code, name: r.name, named: r.named, auto_connect: r.auto_connect })));

  const getRoom = (roomId) => {
    const r = rooms.get(roomId);
    if (!r) throw new Error('Unknown room.');
    return r;
  };
  const joinedRoom = (roomId) => {
    const r = getRoom(roomId);
    if (r.state !== 'joined' || !r.tr) throw new Error('You are not connected to that room.');
    return r;
  };
  const argRoomId = (a) => a.roomId ?? a.roomHandle;
  const helloMsg = (entry) => ({ name: wireName(), room: entry.named ? entry.name : '' });
  const nameOf = (entry, peerId) => entry.members.get(peerId)?.name || `Guest ${String(peerId).slice(0, 4)}`;
  const roomDests = (roomId) => [...destinations.values()].filter((d) => d.roomId === roomId);
  const capDests = (captureId) => [...destinations.values()].filter((d) => d.captureId === captureId);

  // ---- rooms ----------------------------------------------------------------
  // `named`: the room has a real name (given at create/join, renamed, or
  // adopted from a peer's hello) rather than the "Room <id>" placeholder.
  function newEntry({ roomId, code, name, named, auto_connect }) {
    return {
      roomId, code, name, named: !!named, auto_connect: !!auto_connect,
      state: 'disconnected', tr: null, acts: {}, error: null, lastErrAt: 0,
      members: new Map(), // peerId -> {name}
      remote: new Map(), // peerId -> [{stream_id,label,width,height,kind,audio}]
      watching: new Set(), // "owner:sid"
      incoming: new Map(), // "owner:sid" -> MediaStream
    };
  }

  /** One connect at a time per room (joinByCode and auto-connect can race); a second caller shares the first's result. */
  function connectRoom(entry) {
    if (entry.connecting) return entry.connecting;
    const p = connectRoomOnce(entry).finally(() => {
      if (entry.connecting === p) entry.connecting = null;
    });
    entry.connecting = p;
    return p;
  }

  async function connectRoomOnce(entry) {
    if (entry.state === 'joined') return;
    const { password } = await deriveRoom(entry.code);
    const turn = turnConfig();
    let tr;
    try {
      tr = joinRoom(
        {
          appId: APP_ID,
          password,
          rtcPolyfill: getHookPC(),
          ...(turn ? { turnConfig: turn } : {}),
          ...(opts.rtcConfig ? { rtcConfig: opts.rtcConfig } : {}),
        },
        entry.roomId,
        { onJoinError: (d) => onJoinError(entry, d) },
      );
    } catch (e) {
      entry.state = 'disconnected';
      entry.error = String(e && e.message ? e.message : e);
      emit('room-connect-failed', { roomId: entry.roomId, error: entry.error });
      throw e;
    }
    entry.tr = tr;
    entry.state = 'joined';
    entry.error = null;
    wireRoom(entry);
    emit('room-connected', { roomId: entry.roomId });
  }

  function onJoinError(entry, d) {
    const msg = String((d && d.error) || 'join error');
    if (d && d.peerId && /could not connect to peer/i.test(msg)) {
      emit('peer_unreachable', { roomId: entry.roomId, peerId: d.peerId, peerName: nameOf(entry, d.peerId) });
      return;
    }
    const now = Date.now();
    if (/incorrect (room )?password/i.test(msg)) {
      // Someone with the right room id but a wrong password knocking: not a failure of OUR join. Emit (tagged) but keep entry.error clean.
      if (now - (entry.lastWrongPwAt || 0) < 10000) return;
      entry.lastWrongPwAt = now;
      emit('room-connect-failed', { roomId: entry.roomId, error: msg, peerId: d && d.peerId, kind: 'wrong-password' });
      return;
    }
    if (msg === entry.error && now - entry.lastErrAt < 10000) return;
    entry.error = msg;
    entry.lastErrAt = now;
    console.warn('[p2p] join error', entry.roomId, msg);
    emit('room-connect-failed', { roomId: entry.roomId, error: msg, peerId: d && d.peerId });
  }

  const safeSend = (action, data, target) => {
    try {
      const p = action.send(data, target ? { target } : {});
      if (p && p.catch) p.catch((e) => console.warn('[p2p] send failed', e));
    } catch (e) {
      console.warn('[p2p] send failed', e);
    }
  };

  function wireRoom(entry) {
    const tr = entry.tr;
    const hello = tr.makeAction('hello');
    const streams = tr.makeAction('streams');
    const watch = tr.makeAction('watch');
    entry.acts = { hello, streams, watch };

    hello.onMessage = (d, { peerId }) => {
      const m = entry.members.get(peerId) || { name: '' };
      m.name = str(d && d.name, 40);
      entry.members.set(peerId, m);
      const roomName = str(d && d.room, 60).trim();
      if (!entry.named && roomName) {
        entry.name = roomName;
        entry.named = true;
        persistRooms();
      }
      emit('presence-updated', { roomId: entry.roomId });
    };
    streams.onMessage = (list, { peerId }) => setRemoteStreams(entry, peerId, list);
    watch.onMessage = (d, { peerId }) => handleWatch(entry, peerId, d);

    tr.onPeerJoin = (peerId) => {
      if (!entry.members.has(peerId)) entry.members.set(peerId, { name: '' });
      const pc = tr.getPeers()[peerId];
      if (pc) {
        const l = pcOwner.get(pc) || [];
        l.push({ entry, peerId });
        pcOwner.set(pc, l);
      }
      safeSend(hello, helloMsg(entry), peerId);
      const mine = streamList(entry);
      if (mine.length) safeSend(streams, mine, peerId);
      emit('presence-updated', { roomId: entry.roomId });
      emit('peer_connected', { roomId: entry.roomId, peerId, peerName: nameOf(entry, peerId) });
    };
    tr.onPeerLeave = (peerId) => {
      entry.members.delete(peerId);
      emit('peer_left', { roomId: entry.roomId, peerId });
      setRemoteStreams(entry, peerId, []);
      for (const d of roomDests(entry.roomId)) {
        d.watchers.delete(peerId);
        d.senders.delete(peerId);
      }
      emit('presence-updated', { roomId: entry.roomId });
    };
    tr.onPeerStream = (stream, peerId, meta) => {
      const sid = meta && meta.sid;
      if (!Number.isInteger(sid)) return;
      const key = `${peerId}:${sid}`;
      if (!entry.watching.has(key)) return; // unwatched while in flight
      entry.incoming.set(key, stream);
      emit('p2p-stream', { roomId: entry.roomId, owner: peerId, stream_id: sid, stream });
    };
  }

  function setRemoteStreams(entry, peerId, list) {
    const clean = (Array.isArray(list) ? list : []).slice(0, 16).flatMap((s) =>
      s && Number.isInteger(s.stream_id)
        ? [{ stream_id: s.stream_id, label: str(s.label, 60) || 'Screen', width: posInt(s.width), height: posInt(s.height), kind: 'video', audio: !!s.audio }]
        : [],
    );
    if (clean.length) entry.remote.set(peerId, clean);
    else entry.remote.delete(peerId);
    const alive = new Set(clean.map((s) => `${peerId}:${s.stream_id}`));
    for (const key of [...entry.watching]) {
      if (key.startsWith(peerId + ':') && !alive.has(key)) dropWatch(entry, key);
    }
    emit('presence-updated', { roomId: entry.roomId });
  }

  function dropWatch(entry, key) {
    entry.watching.delete(key);
    watchedPrev.delete(`${entry.roomId}/${key}`);
    if (entry.incoming.delete(key)) {
      const i = key.lastIndexOf(':');
      emit('p2p-stream-removed', { roomId: entry.roomId, owner: key.slice(0, i), stream_id: Number(key.slice(i + 1)) });
    }
  }

  async function leaveRoom(entry) {
    for (const d of roomDests(entry.roomId)) removeDestination(d);
    for (const key of [...entry.watching]) dropWatch(entry, key);
    const tr = entry.tr;
    entry.tr = null;
    entry.state = 'disconnected';
    entry.members.clear();
    entry.remote.clear();
    try {
      if (tr) await tr.leave();
    } catch (e) {
      console.warn('[p2p] leave failed', e);
    }
    emit('room-disconnected', { roomId: entry.roomId });
  }

  async function joinByCode(code, name, { create = false } = {}) {
    const parsed = parseShareCode(code); // throws the user-facing message
    const { roomId } = await deriveRoom(parsed);
    let entry = rooms.get(roomId);
    if (entry && entry.code !== parsed.code) {
      if (entry.state === 'joined') {
        throw new Error('You are already in a room with the same room ID but a different password. Leave it first.');
      }
      entry = null; // replace stale saved room that shares the room part
    }
    if (!entry) {
      const given = str(name, 60).trim();
      entry = newEntry({ roomId, code: parsed.code, name: given || `Room ${roomId}`, named: !!given && given !== `Room ${roomId}`, auto_connect: false });
      rooms.set(roomId, entry);
    } else if (name && !create) {
      // A reconnect passes the saved name back, which may be the "Room <id>" placeholder: that is not a real name.
      const given = str(name, 60).trim();
      if (given && given !== `Room ${roomId}`) {
        entry.name = given;
        entry.named = true;
      }
    }
    persistRooms();
    if (entry.state !== 'joined') await connectRoom(entry);
    return { roomId, code: entry.code, name: entry.name };
  }

  function streamList(entry) {
    return roomDests(entry.roomId)
      .filter((d) => d.state !== 'failed')
      .map((d) => ({
        stream_id: d.id, label: d.label, width: d.width, height: d.height, kind: 'video',
        audio: !!(d.audioTrack && captures.get(d.captureId)?.shareAudio),
      }));
  }
  function announce(roomId) {
    const entry = rooms.get(roomId);
    if (entry && entry.tr && entry.acts.streams) safeSend(entry.acts.streams, streamList(entry));
  }

  // ---- watching (viewer side) --------------------------------------------
  async function toggleWatch(roomId, owner, streamId) {
    const entry = joinedRoom(roomId);
    const sid = Number(streamId);
    const key = `${owner}:${sid}`;
    if (entry.watching.has(key)) {
      dropWatch(entry, key);
      safeSend(entry.acts.watch, { sid, on: false }, owner);
    } else {
      if (!(entry.remote.get(owner) || []).some((s) => s.stream_id === sid)) throw new Error('That stream is no longer available.');
      entry.watching.add(key);
      safeSend(entry.acts.watch, { sid, on: true }, owner);
    }
    emit('presence-updated', { roomId });
  }

  // ---- sharing (sender side) ------------------------------------------------
  function handleWatch(entry, peerId, d) {
    if (!d || !Number.isInteger(d.sid)) return;
    const dest = destinations.get(d.sid);
    if (!dest || dest.roomId !== entry.roomId || dest.state === 'failed') return;
    if (d.on) {
      dest.watchers.add(peerId);
      serial(dest, () => startSending(dest, peerId));
    } else {
      dest.watchers.delete(peerId);
      serial(dest, () => stopSending(dest, peerId));
    }
  }

  const serial = (dest, fn) => (dest.queue = dest.queue.then(fn).catch((e) => console.warn('[p2p] send queue', e)));

  async function startSending(dest, peerId) {
    const entry = rooms.get(dest.roomId);
    if (!entry || !entry.tr || dest.senders.has(peerId) || !dest.watchers.has(peerId) || !destinations.has(dest.id)) return;
    trackCodec.set(dest.videoTrack, dest.codec);
    trackBitrate.set(dest.videoTrack, dest.bitrate_kbps);
    try {
      await Promise.all(entry.tr.addStream(dest.stream, { target: peerId, metadata: { sid: dest.id } }));
    } catch (e) {
      console.warn('[p2p] addStream failed', e);
      dest.watchers.delete(peerId);
      return;
    }
    if (!registerSender(dest, peerId)) registerSenderLater(dest, peerId);
  }

  /** Find the RTCRtpSender carrying dest's track on the peer's PC and start configuring it. false = not there (yet). */
  function registerSender(dest, peerId) {
    if (dest.senders.has(peerId)) return true;
    const entry = rooms.get(dest.roomId);
    const pc = entry && entry.tr && entry.tr.getPeers()[peerId];
    const sender = pc && pc.getSenders().find((s) => s.track === dest.videoTrack);
    if (!sender) return false;
    dest.senders.set(peerId, { sender, pc, codec: dest.codec, prevBytes: null, prevTs: 0 });
    emit('destination-state-changed', { destinationId: dest.id });
    applyWithRetry(dest, peerId);
    return true;
  }

  /** The sender was not findable right after addStream: keep looking (up to 20 s) instead of leaving the stream unconfigured. */
  async function registerSenderLater(dest, peerId) {
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (destinations.get(dest.id) !== dest || !dest.watchers.has(peerId)) return;
      if (registerSender(dest, peerId)) return;
    }
    console.warn('[p2p] no RTCRtpSender found for peer', peerId, 'stream', dest.id);
  }

  async function stopSending(dest, peerId) {
    const entry = rooms.get(dest.roomId);
    dest.senders.delete(peerId);
    try {
      if (entry && entry.tr && entry.tr.getPeers()[peerId]) entry.tr.removeStream(dest.stream, { target: peerId });
    } catch (e) {
      console.warn('[p2p] removeStream failed', e);
    }
  }

  /** Apply framerate/bitrate/degradation/codec to one sender. false = not negotiated yet. Throws on real errors. */
  async function applyToSender(dest, rec) {
    const p = rec.sender.getParameters();
    if (!p.encodings || !p.encodings.length) return false;
    const enc = p.encodings[0];
    enc.maxFramerate = dest.framerate;
    enc.maxBitrate = dest.bitrate_kbps * 1000;
    // Always pin the codec when it was negotiated (not only on change): the setCodecPreferences order alone is not binding.
    const c = (p.codecs || []).find((x) => x.mimeType.toLowerCase() === MIME[dest.codec]);
    if (c) enc.codec = c;
    else if (!(p.codecs || []).length) return false; // codecs not known yet
    else if (rec.codec !== dest.codec) throw new Error(`Codec ${dest.codec} was not negotiated with this viewer.`);
    p.degradationPreference = PRESETS[dest.preset].degr;
    trackBitrate.set(dest.videoTrack, dest.bitrate_kbps);
    rec.applying = true;
    try {
      try {
        await rec.sender.setParameters(p);
        rec.noDegr = false;
      } catch (e) {
        if (rec.codec !== dest.codec) throw e;
        delete p.degradationPreference; // older Chromium builds may reject it
        await rec.sender.setParameters(p);
        rec.noDegr = true;
      }
    } finally {
      rec.applying = false;
    }
    rec.codec = dest.codec;
    return true;
  }

  async function applyWithRetry(dest, peerId) {
    let last = null;
    for (let i = 0; i < 40; i++) {
      const rec = dest.senders.get(peerId);
      if (!rec) return;
      try {
        if (await applyToSender(dest, rec)) return;
      } catch (e) {
        last = e;
      }
      await sleep(500);
    }
    console.warn('[p2p] could not configure the sender after 20 s (the 1 s reconcile keeps trying)', dest.id, peerId, last || '(never negotiated)');
  }

  /** True if the sender's live parameters differ from what the destination wants. */
  function senderDrifted(dest, rec) {
    const p = rec.sender.getParameters();
    const enc = p.encodings && p.encodings[0];
    if (!enc) return false; // not negotiated yet: applyWithRetry / next tick
    if (enc.maxFramerate !== dest.framerate || enc.maxBitrate !== dest.bitrate_kbps * 1000) return true;
    const want = (p.codecs || []).find((x) => x.mimeType.toLowerCase() === MIME[dest.codec]);
    if (want && (!enc.codec || enc.codec.mimeType.toLowerCase() !== MIME[dest.codec])) return true;
    return !rec.noDegr && p.degradationPreference !== undefined && p.degradationPreference !== PRESETS[dest.preset].degr;
  }

  let reconciling = false;
  /** Re-apply codec/bitrate/fps/degradation on any sender that drifted from the destination's values (runs on the 1 s tick). */
  async function reconcileSenders() {
    if (reconciling) return;
    reconciling = true;
    try {
      for (const dest of [...destinations.values()]) {
        if (dest.state !== 'live') continue; // edit_destination owns the sender while rebuilding
        for (const rec of [...dest.senders.values()]) {
          if (rec.applying) continue;
          try {
            if (senderDrifted(dest, rec)) {
              if (rec.reconciled !== dest.id + ':' + dest.codec + ':' + dest.bitrate_kbps + ':' + dest.framerate + ':' + dest.preset) console.warn('[p2p] sender drifted from the requested settings, re-applying', dest.id);
              rec.reconciled = dest.id + ':' + dest.codec + ':' + dest.bitrate_kbps + ':' + dest.framerate + ':' + dest.preset;
              await applyToSender(dest, rec);
            }
          } catch (e) {
            console.warn('[p2p] reconcile failed', dest.id, e);
          }
        }
      }
    } finally {
      reconciling = false;
    }
  }

  const applyContentHint = (dest) => {
    try {
      dest.videoTrack.contentHint = PRESETS[dest.preset].hint;
    } catch {
      /* unsupported */
    }
  };

  // Capture rate is fixed when a display capture is created: applyConstraints({frameRate}) on a live
  // display track does NOT change it (measured, Electron 43.7.7 / Wayland portal: stayed 60 after
  // asking 120). So a change of the wanted rate re-captures and swaps the new track into every
  // destination (sender.replaceTrack: same SSRC, no renegotiation, viewers keep receiving).
  // Linux/Wayland tops out near 90 fps; above that ask for at most 120 so Chromium's poll timer
  // does not run at 240 for nothing. The encoder maxFramerate is still the user's choice.
  const IS_LINUX = /linux/i.test((typeof navigator !== 'undefined' && ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform)) || '');
  const captureFpsFor = (fps) => (IS_LINUX && fps > 90 ? Math.min(fps, 120) : fps);
  const captureConstraint = (fps) => ({ frameRate: { ideal: fps, max: fps } });

  /** Make the capture run at the rate its destinations (plus `extra`) need. Re-captures when it differs; throws if that fails. */
  function ensureCaptureFps(cap, extra = 0) {
    cap.fpsLock = (cap.fpsLock || Promise.resolve()).catch(() => {}).then(async () => {
      const want = captureFpsFor(Math.max(extra, ...capDests(cap.id).map((d) => d.framerate)));
      if (!want || want === cap.fps || cap.stopped || !captures.has(cap.id)) return;
      await recapture(cap, want);
    });
    return cap.fpsLock;
  }

  async function captureVideo(fps) {
    const stream = await gdm({ video: captureConstraint(fps), audio: false });
    for (const t of stream.getAudioTracks()) t.stop();
    const vt = stream.getVideoTracks()[0];
    if (!vt) throw new Error('No video track was captured.');
    return vt;
  }

  // stop_share / leave_room / the system can end the capture at ANY await below: after each one, re-check and
  // stop whatever track was just created, otherwise the screen capture outlives the share (privacy).
  async function recapture(cap, fps) {
    const gone = () => cap.stopped || !captures.has(cap.id);
    let vt = await captureVideo(fps);
    if (gone()) {
      vt.stop();
      return;
    }
    const sameSource = (a, b) => {
      const x = a.getSettings().deviceId;
      return !!x && x === b.getSettings().deviceId;
    };
    if (sameSource(vt, cap.videoTrack)) {
      // Chromium reuses an already-open capture device (same device id) and keeps ITS frame rate
      // (measured: a 60 request next to a live 30 capture still ran 30, even after the first track
      // was stopped, as long as any clone lived). Release every track of the source, then capture again.
      vt.stop();
      const prev = cap.fps;
      for (const d of capDests(cap.id)) {
        for (const rec of d.senders.values()) await rec.sender.replaceTrack(null).catch(() => {});
        d.videoTrack.stop();
      }
      cap.videoTrack.stop();
      if (gone()) return;
      try {
        vt = await captureVideo(fps);
      } catch (e) {
        if (gone()) return;
        try {
          vt = await captureVideo(prev); // keep the share alive at the old rate
          fps = prev;
        } catch {
          stopCapture(cap);
          throw e;
        }
      }
      if (gone()) {
        vt.stop();
        return;
      }
    }
    const old = cap.videoTrack;
    cap.videoTrack = vt;
    cap.fps = fps;
    Object.assign(cap, trackInfo(vt));
    cap.stream.removeTrack(old);
    cap.stream.addTrack(vt);
    vt.addEventListener('ended', () => onCaptureEnded(cap));
    await Promise.all(capDests(cap.id).map((d) => serial(d, () => swapDestinationTrack(d, vt))));
    old.stop();
    if (gone()) vt.stop(); // stopCapture ran meanwhile (vt is in cap.stream, so this is belt and braces)
  }

  /** Give a destination a fresh clone of the new capture track and swap it into every sender. */
  async function swapDestinationTrack(dest, vt) {
    if (destinations.get(dest.id) !== dest || vt.readyState === 'ended') return;
    const old = dest.videoTrack;
    const nt = vt.clone();
    trackCodec.set(nt, dest.codec);
    trackBitrate.set(nt, dest.bitrate_kbps);
    const failed = [];
    for (const [peerId, rec] of [...dest.senders]) {
      try {
        await rec.sender.replaceTrack(nt);
      } catch (e) {
        console.warn('[p2p] replaceTrack failed, re-adding stream', e);
        failed.push([peerId, rec]);
      }
    }
    if (destinations.get(dest.id) !== dest) {
      nt.stop(); // destination was removed during the awaits; nt is not in dest.stream, so removeDestination never saw it
      return;
    }
    dest.stream.removeTrack(old);
    dest.stream.addTrack(nt);
    dest.videoTrack = nt;
    Object.assign(dest, trackInfo(nt));
    applyContentHint(dest);
    old.stop();
    for (const [peerId, rec] of failed) {
      dest.senders.delete(peerId);
      try {
        rec.pc.removeTrack(rec.sender);
      } catch {
        /* pc gone */
      }
      await startSending(dest, peerId);
    }
  }

  function trackInfo(track) {
    const s = track.getSettings ? track.getSettings() : {};
    return { width: posInt(s.width), height: posInt(s.height) };
  }

  function createDestination(cap, roomId, params, id) {
    const vt = cap.videoTrack.clone();
    const at = cap.audioTrack ? cap.audioTrack.clone() : null;
    if (at) at.enabled = cap.shareAudio;
    const dest = {
      id: id ?? ++destSeq, captureId: cap.id, roomId,
      stream: new MediaStream(at ? [vt, at] : [vt]), videoTrack: vt, audioTrack: at,
      state: 'live', pending: null, errorText: null,
      framerate: params.framerate, bitrate_kbps: params.bitrate_kbps, codec: params.codec, preset: normPreset(params.preset),
      label: cap.label, ...trackInfo(cap.videoTrack),
      watchers: new Set(), senders: new Map(), queue: Promise.resolve(), editQueue: Promise.resolve(),
    };
    applyContentHint(dest);
    destinations.set(dest.id, dest);
    cap.everLive = true;
    return dest;
  }

  function removeDestination(dest) {
    for (const peerId of [...dest.senders.keys()]) stopSending(dest, peerId);
    dest.watchers.clear();
    destinations.delete(dest.id);
    for (const t of dest.stream.getTracks()) t.stop();
    announce(dest.roomId);
    const cap = captures.get(dest.captureId);
    if (cap && capDests(cap.id).length === 0) stopCapture(cap, { quiet: true });
    emit('destination-state-changed', { destinationId: dest.id });
  }

  function stopCapture(cap, { quiet = false } = {}) {
    if (cap.stopped) return;
    cap.stopped = true; // checked by recapture / stage_video_share after their awaits
    captures.delete(cap.id);
    for (const d of capDests(cap.id)) removeDestination(d);
    if (cap.stream) for (const t of cap.stream.getTracks()) t.stop();
    if (cap.videoTrack) cap.videoTrack.stop();
    if (cap.audioTrack) cap.audioTrack.stop();
    if (cap.silenceCleanup) cap.silenceCleanup();
    if (!quiet) emit('destination-state-changed', {});
    emit('staged-capture-changed', {});
  }

  const audioAvailable = (cap) => !!cap.audioTrack;

  /** Best effort: warn if a captured audio track stays digital silence for 6 s. */
  function watchSilence(cap) {
    if (cap.silenceChecked || !cap.audioTrack) return;
    cap.silenceChecked = true;
    let ctx = null;
    let clone = null;
    let timer = null;
    // Stops the clone too: a live clone keeps the audio loopback capture alive after the share ended.
    const cleanup = () => {
      if (timer) clearInterval(timer);
      timer = null;
      cap.silenceCleanup = null;
      if (clone) clone.stop();
      if (ctx) ctx.close().catch(() => {});
    };
    try {
      ctx = new AudioContext();
      clone = cap.audioTrack.clone();
      const an = ctx.createAnalyser();
      ctx.createMediaStreamSource(new MediaStream([clone])).connect(an);
      const buf = new Float32Array(an.fftSize);
      const t0 = Date.now();
      let peak = 0;
      cap.silenceCleanup = cleanup;
      timer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        for (const x of buf) peak = Math.max(peak, Math.abs(x));
        const done = peak > 1e-4 || Date.now() - t0 > 6000;
        if (!done) return;
        cleanup();
        if (peak <= 1e-4 && !cap.stopped) {
          cap.audioSilent = true;
          emit('destination-state-changed', {});
        }
      }, 250);
    } catch {
      cleanup(); // no AudioContext: skip
    }
  }

  async function requestCapture(fps) {
    const video = captureConstraint(fps);
    if (captureAudio) {
      try {
        return await gdm({ video, audio: true });
      } catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) throw e;
      }
    }
    return gdm({ video, audio: false });
  }

  function onCaptureEnded(cap) {
    if (!captures.has(cap.id)) return;
    console.info('[p2p] capture ended by the system/browser', cap.id);
    stopCapture(cap);
  }

  // ---- validation ------------------------------------------------------------
  function checkFramerate(v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 240) throw new Error('Framerate must be a whole number between 1 and 240.');
    return n;
  }
  function checkBitrate(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 100 || n > 200000) throw new Error('Bitrate must be between 100 and 200000 kbps.');
    return Math.round(n);
  }
  function checkCodec(v) {
    const c = String(v || '').toLowerCase();
    if (!supportedCodecs().includes(c)) throw new Error(`The ${c.toUpperCase() || 'selected'} codec is not available on this machine.`);
    return c;
  }
  const saneCodec = (c) => (supportedCodecs().includes(c) ? c : supportedCodecs()[0]);

  async function editDestination(dest, next) {
    if (destinations.get(dest.id) !== dest) throw new Error('That stream no longer exists.');
    const destinationId = dest.id;
    const old = { framerate: dest.framerate, bitrate_kbps: dest.bitrate_kbps, codec: dest.codec, preset: dest.preset };
    const prevState = dest.state; // read inside the lock: a queued edit never records another edit's 'rebuilding'
    dest.state = 'rebuilding';
    emit('destination-state-changed', { destinationId });
    try {
      Object.assign(dest, next);
      applyContentHint(dest);
      const cap = captures.get(dest.captureId);
      if (cap) await ensureCaptureFps(cap);
      if (destinations.get(dest.id) !== dest) throw new Error('That stream no longer exists.');
      for (const [peerId, rec] of [...dest.senders]) {
        try {
          if (!(await applyToSender(dest, rec))) applyWithRetry(dest, peerId);
        } catch (e) {
          if (rec.codec === dest.codec) throw e;
          console.warn('[p2p] live codec switch failed, re-adding stream', e);
          await stopSending(dest, peerId);
          dest.watchers.add(peerId);
          await serial(dest, () => startSending(dest, peerId));
        }
      }
    } catch (e) {
      Object.assign(dest, old);
      applyContentHint(dest);
      dest.state = prevState;
      emit('destination-state-changed', { destinationId });
      throw e;
    }
    dest.state = 'live';
    emit('destination-state-changed', { destinationId });
  }

  // ---- commands ----------------------------------------------------------------
  const cmd = {
    // Rooms
    async list_saved_rooms() {
      return [...rooms.values()].map((r) => ({
        roomId: r.roomId, room_handle: r.roomId, code: r.code, name: r.name, state: r.state,
        auto_connect: r.auto_connect, error: r.error,
        active_stream_count: [...r.remote.values()].reduce((n, l) => n + l.length, 0) + roomDests(r.roomId).length,
      }));
    },
    async create_room({ name } = {}) {
      return joinByCode(generateShareCode(), name, { create: true });
    },
    async join_room({ code, name } = {}) {
      return joinByCode(code, name);
    },
    async leave_room(a = {}) {
      const r = getRoom(argRoomId(a));
      if (r.state !== 'disconnected') await leaveRoom(r);
    },
    async forget_room(a = {}) {
      const r = getRoom(argRoomId(a));
      if (r.state !== 'disconnected') await leaveRoom(r);
      rooms.delete(r.roomId);
      persistRooms();
      emit('room-disconnected', { roomId: r.roomId });
    },
    async rename_room({ roomId, roomHandle, newName } = {}) {
      const r = getRoom(roomId ?? roomHandle);
      const n = str(newName, 60).trim();
      if (n) { r.name = n; r.named = true; }
      persistRooms();
      emit('presence-updated', { roomId: r.roomId });
    },
    async set_room_auto_connect({ roomId, roomHandle, autoConnect } = {}) {
      getRoom(roomId ?? roomHandle).auto_connect = !!autoConnect;
      persistRooms();
    },
    async room_detail(a = {}) {
      const r = getRoom(argRoomId(a));
      if (r.state !== 'joined') return { members: [], streams: [], watched: [] };
      const members = [{ conn_id: myId, display_name: myName() }];
      for (const id of r.members.keys()) members.push({ conn_id: id, display_name: nameOf(r, id) });
      const streams = [];
      for (const [owner, list] of r.remote) {
        for (const s of list) streams.push({ owner, stream_id: s.stream_id, kind: 'Video', label: s.label, width: s.width, height: s.height, audio: !!s.audio });
      }
      const watched = [...r.watching].map((k) => {
        const i = k.lastIndexOf(':');
        return { owner: k.slice(0, i), stream_id: Number(k.slice(i + 1)) };
      });
      return { members, streams, watched };
    },
    async toggle_watch(a = {}) {
      await toggleWatch(argRoomId(a), a.owner, a.streamId);
    },

    // Streams
    async list_active_streams() {
      return [...destinations.values()].map((d) => {
        const cap = captures.get(d.captureId);
        return {
          destination_id: d.id, capture_id: d.captureId, roomId: d.roomId, room_handle: d.roomId, kind: 'video',
          state: d.state, senders: d.senders.size, width: d.width, height: d.height, framerate: d.framerate, bitrate_kbps: d.bitrate_kbps,
          audio: !!(d.audioTrack && cap && cap.shareAudio), codec: d.codec, preset: d.preset, pending: d.pending,
          ...(d.errorText ? { errorText: d.errorText } : {}),
          ...(cap && cap.audioSilent && cap.shareAudio ? { audioWarning: 'System audio looks silent (nothing was playing, or this platform cannot capture it).' } : {}),
        };
      });
    },
    async list_staged_captures() {
      return [...captures.values()].filter((c) => !c.everLive).map((c) => ({
        capture_id: c.id, state: c.state, width: c.width, height: c.height,
        framerate: current.framerate, bitrate_kbps: current.bitrate_kbps, codec: saneCodec(current.codec), preset: current.preset,
        share_audio: c.shareAudio, audio_available: audioAvailable(c), supported_codecs: supportedCodecs(),
      }));
    },
    async supported_codecs() {
      return supportedCodecs();
    },
    async get_start_stream_defaults() {
      return { ...defaults, codec: saneCodec(defaults.codec) };
    },
    async set_start_stream_defaults({ framerate, bitrateKbps, codec, preset, shareAudio } = {}) {
      Object.assign(defaults, {
        framerate: checkFramerate(framerate), bitrate_kbps: checkBitrate(bitrateKbps), codec: String(codec || 'h264').toLowerCase(),
        preset: normPreset(preset), share_audio: !!shareAudio,
      });
      Object.assign(current, defaults);
      store.set(KEY_DEFAULTS, defaults);
    },
    async stage_video_share() {
      const cap = {
        id: ++captureSeq, state: 'starting', stream: null, videoTrack: null, audioTrack: null, label: 'Screen',
        width: 0, height: 0, fps: 0, shareAudio: !!current.share_audio, everLive: false,
      };
      captures.set(cap.id, cap);
      emit('staged-capture-changed', {});
      try {
        cap.fps = captureFpsFor(checkFramerate(current.framerate));
        cap.stream = await requestCapture(cap.fps);
        if (cap.stopped) {
          // stop_share hit the still-starting capture while the picker was open
          for (const t of cap.stream.getTracks()) t.stop();
          throw new Error('The capture was cancelled.');
        }
        cap.videoTrack = cap.stream.getVideoTracks()[0];
        if (!cap.videoTrack) throw new Error('No video track was captured.');
        cap.audioTrack = cap.stream.getAudioTracks()[0] || null;
      } catch (e) {
        captures.delete(cap.id);
        if (cap.stream) for (const t of cap.stream.getTracks()) t.stop();
        emit('staged-capture-changed', {});
        throw e;
      }
      Object.assign(cap, trackInfo(cap.videoTrack));
      if (cap.videoTrack.label && !/^(screen|window|web-contents-media-stream):/i.test(cap.videoTrack.label)) cap.label = str(cap.videoTrack.label, 60);
      cap.videoTrack.addEventListener('ended', () => onCaptureEnded(cap));
      cap.state = 'ready';
      emit('staged-capture-changed', {});
      return { captureId: cap.id };
    },
    async set_framerate({ fps } = {}) {
      current.framerate = checkFramerate(fps);
      // Staged captures re-capture lazily in go_live (each capture re-opens the system screen picker).
    },
    async set_bitrate({ kbps } = {}) {
      current.bitrate_kbps = checkBitrate(kbps);
    },
    async set_codec({ codec } = {}) {
      current.codec = checkCodec(codec);
    },
    async set_preset({ preset } = {}) {
      current.preset = normPreset(preset);
    },
    // framerate/bitrateKbps/codec/preset are optional per-call values (the staged card's); omitted => the process-wide current.*.
    async go_live({ captureId, roomId, shareAudio, framerate, bitrateKbps, codec, preset } = {}) {
      const cap = captures.get(captureId);
      if (!cap || cap.state !== 'ready') throw new Error('That capture is not ready.');
      joinedRoom(roomId);
      cap.shareAudio = !!shareAudio && audioAvailable(cap);
      const params = {
        framerate: checkFramerate(framerate ?? current.framerate), bitrate_kbps: checkBitrate(bitrateKbps ?? current.bitrate_kbps),
        codec: checkCodec(codec ?? current.codec), preset: normPreset(preset ?? current.preset),
      };
      try {
        await ensureCaptureFps(cap, params.framerate);
      } catch (e) {
        console.warn('[p2p] could not re-capture at the new frame rate, going live with the current capture', e);
      }
      // The re-capture can fail for good (capture stopped) or the user can stop/leave meanwhile: never go live on a dead capture.
      if (cap.stopped || !captures.has(cap.id)) throw new Error('The capture ended before it could go live.');
      joinedRoom(roomId);
      createDestination(cap, roomId, params);
      if (cap.shareAudio) watchSilence(cap);
      announce(roomId);
      emit('destination-state-changed', {});
      emit('staged-capture-changed', {});
    },
    async start_destination({ captureId, roomId, framerate, bitrateKbps, codec, preset } = {}) {
      const cap = captures.get(captureId);
      if (!cap || cap.state !== 'ready') throw new Error('That capture is no longer running.');
      joinedRoom(roomId);
      if (roomDests(roomId).some((d) => d.captureId === captureId)) throw new Error('This screen is already shared to that room.');
      const src = capDests(captureId)[0];
      const base = src
        ? { framerate: src.framerate, bitrate_kbps: src.bitrate_kbps, codec: src.codec, preset: src.preset }
        : { framerate: current.framerate, bitrate_kbps: current.bitrate_kbps, codec: current.codec, preset: current.preset };
      const params = {
        framerate: checkFramerate(framerate ?? base.framerate), bitrate_kbps: checkBitrate(bitrateKbps ?? base.bitrate_kbps),
        codec: checkCodec(codec ?? base.codec), preset: normPreset(preset ?? base.preset),
      };
      if (params.framerate !== cap.fps) {
        try {
          await ensureCaptureFps(cap, params.framerate);
        } catch (e) {
          console.warn('[p2p] could not re-capture at the new frame rate, using the current capture', e);
        }
        if (cap.stopped || !captures.has(cap.id)) throw new Error('That capture is no longer running.');
        joinedRoom(roomId);
        if (roomDests(roomId).some((d) => d.captureId === captureId)) throw new Error('This screen is already shared to that room.');
      }
      createDestination(cap, roomId, params);
      announce(roomId);
      emit('destination-state-changed', {});
    },
    async stop_share({ captureId } = {}) {
      const cap = captures.get(captureId);
      if (cap) stopCapture(cap);
    },
    async stop_destination({ destinationId } = {}) {
      const d = destinations.get(destinationId);
      if (d) removeDestination(d);
    },
    async retry_destination({ destinationId } = {}) {
      const dest = destinations.get(destinationId);
      const cap = dest && captures.get(dest.captureId);
      if (!dest || !cap) throw new Error('That stream can no longer be retried; start a new share.');
      joinedRoom(dest.roomId);
      const watchers = [...dest.watchers];
      for (const peerId of [...dest.senders.keys()]) await stopSending(dest, peerId);
      for (const t of dest.stream.getTracks()) t.stop();
      const fresh = createDestination(cap, dest.roomId, dest, dest.id);
      fresh.pending = null;
      for (const peerId of watchers) {
        fresh.watchers.add(peerId);
        serial(fresh, () => startSending(fresh, peerId));
      }
      announce(dest.roomId);
      emit('destination-state-changed', {});
    },
    async edit_destination({ destinationId, framerate, bitrateKbps, codec, preset } = {}) {
      const dest = destinations.get(destinationId);
      if (!dest) throw new Error('That stream no longer exists.');
      const next = {
        framerate: checkFramerate(framerate), bitrate_kbps: checkBitrate(bitrateKbps), codec: checkCodec(codec), preset: normPreset(preset),
      };
      // Edits of one destination run one after another. A separate chain from dest.queue on purpose: the body awaits
      // ensureCaptureFps -> swapDestinationTrack, which is itself queued on dest.queue (waiting for it from inside would deadlock).
      const run = (dest.editQueue = dest.editQueue.catch(() => {}).then(() => editDestination(dest, next)));
      return run;
    },
    async set_share_audio({ captureId, enabled } = {}) {
      const cap = captures.get(captureId);
      if (!cap) throw new Error('That share no longer exists.');
      if (enabled && !audioAvailable(cap)) throw new Error('No audio could be captured for this share (the system did not provide an audio track).');
      cap.shareAudio = !!enabled;
      for (const d of capDests(captureId)) {
        if (d.audioTrack) d.audioTrack.enabled = cap.shareAudio;
        announce(d.roomId);
      }
      if (cap.shareAudio) watchSilence(cap);
      emit('destination-state-changed', {});
    },

    // Settings
    async get_settings() {
      return { ...settings };
    },
    async set_settings(partial = {}) {
      const prevName = settings.displayName;
      const merged = { ...settings };
      for (const [k, v] of Object.entries(partial)) if (k in merged && typeof v === 'string') merged[k] = v;
      if (merged.turnUrl.trim() && (!merged.turnUsername || !merged.turnPassword)) {
        throw new Error('A TURN server needs both a username and a password. Fill in all three fields (or clear the URL).');
      }
      Object.assign(settings, merged);
      store.set(KEY_SETTINGS, settings);
      if (settings.displayName !== prevName) {
        for (const r of rooms.values()) if (r.tr) safeSend(r.acts.hello, helloMsg(r));
        emit('presence-updated', {});
      }
    },
  };

  async function invoke(name, args) {
    await ready;
    const fn = cmd[name];
    if (!fn) throw new Error(`Unknown command: ${name}`);
    return fn(args || {});
  }

  // ---- ICE failure -> peer_unreachable -------------------------------------------
  iceHook = (pc) => {
    const owners = pcOwner.get(pc);
    if (!owners) return;
    const state = pc.iceConnectionState;
    for (const { entry, peerId } of owners) {
      if (entry.tr === null) continue;
      if (state === 'failed') emit('peer_unreachable', { roomId: entry.roomId, peerId, peerName: nameOf(entry, peerId) });
      else if (state === 'connected' || state === 'completed') emit('peer_connected', { roomId: entry.roomId, peerId, peerName: nameOf(entry, peerId) });
    }
  };

  // ---- stats (about once a second) ---------------------------------------------------
  const watchedPrev = new Map();
  let ticking = false;

  async function senderStats(rec) {
    const report = await rec.sender.getStats();
    let out = null;
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
    });
    if (!out) return null;
    const codecMime = out.codecId && report.get(out.codecId) ? report.get(out.codecId).mimeType : '';
    const src = out.mediaSourceId ? report.get(out.mediaSourceId) : null;
    let kbps = 0;
    if (rec.prevBytes != null && out.timestamp > rec.prevTs) kbps = ((out.bytesSent - rec.prevBytes) * 8) / (out.timestamp - rec.prevTs);
    rec.prevBytes = out.bytesSent;
    rec.prevTs = out.timestamp;
    return {
      sent_fps: out.framesPerSecond || 0, captured_fps: (src && src.framesPerSecond) || 0, kbps,
      encoder: out.encoderImplementation || '', codec: codecMime.replace(/^video\//i, '').toLowerCase(),
      width: out.frameWidth || 0, height: out.frameHeight || 0, limit: out.qualityLimitationReason || 'none',
      power_efficient: !!out.powerEfficientEncoder,
    };
  }

  async function destinationStats(dest) {
    const per = (await Promise.all([...dest.senders.values()].map((r) => senderStats(r).catch(() => null)))).filter(Boolean);
    const max = (k) => per.reduce((m, p) => Math.max(m, p[k]), 0);
    const first = per.find((p) => p.encoder) || per[0];
    return {
      destination_id: dest.id, captured_fps: max('captured_fps'), sent_fps: max('sent_fps'), bitrate_kbps: Math.round(max('kbps')),
      upload_kbps: Math.round(per.reduce((n, p) => n + p.kbps, 0)),
      encoder: first ? first.encoder : '', codec: first ? first.codec : dest.codec,
      power_efficient: first ? first.power_efficient : false, quality_limit: first ? first.limit : 'none',
      width: first ? first.width : dest.width, height: first ? first.height : dest.height,
      watchers: dest.watchers.size, peers: per.length,
    };
  }

  async function watchedStats(entry, key, stream) {
    const i = key.lastIndexOf(':');
    const owner = key.slice(0, i);
    const pc = entry.tr && entry.tr.getPeers()[owner];
    const vt = stream.getVideoTracks()[0];
    const rx = pc && vt && pc.getReceivers().find((r) => r.track === vt);
    if (!rx) return null;
    let inb = null;
    (await rx.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s;
    });
    if (!inb) return null;
    const pk = `${entry.roomId}/${key}`;
    const prev = watchedPrev.get(pk);
    const kbps = prev && inb.timestamp > prev.ts ? Math.round(((inb.bytesReceived - prev.bytes) * 8) / (inb.timestamp - prev.ts)) : 0;
    watchedPrev.set(pk, { bytes: inb.bytesReceived, ts: inb.timestamp });
    const fps = inb.framesPerSecond || 0;
    return {
      roomId: entry.roomId, room_handle: entry.roomId, owner, stream_id: Number(key.slice(i + 1)),
      fps, received_fps: fps, bitrate_kbps: kbps, received_bitrate_kbps: kbps,
      width: inb.frameWidth || 0, height: inb.frameHeight || 0, decoder: inb.decoderImplementation || '',
    };
  }

  async function statsTick() {
    reconcileSenders();
    if (ticking) return;
    const live = [...destinations.values()].filter((d) => d.state === 'live' || d.state === 'rebuilding');
    const incoming = [];
    for (const r of rooms.values()) for (const [k, s] of r.incoming) incoming.push([r, k, s]);
    if (!live.length && !incoming.length) return;
    ticking = true;
    try {
      const [ds, ws] = await Promise.all([
        Promise.all(live.map((d) => destinationStats(d).catch(() => null))),
        Promise.all(incoming.map(([r, k, s]) => watchedStats(r, k, s).catch(() => null))),
      ]);
      emit('stream-stats-updated', { destinations: ds.filter(Boolean), watched: ws.filter(Boolean) });
    } finally {
      ticking = false;
    }
  }
  const statsTimer = setInterval(statsTick, 1000);

  // ---- startup ---------------------------------------------------------------------------
  const ready = (async () => {
    for (const s of store.get(KEY_ROOMS, [])) {
      try {
        const p = parseShareCode(s.code);
        const { roomId } = await deriveRoom(p);
        if (roomId !== s.roomId || rooms.has(roomId)) continue; // mock/foreign/corrupt entries are dropped
        rooms.set(roomId, newEntry({ roomId, code: p.code, name: str(s.name, 60) || `Room ${roomId}`, named: s.named ?? (!!s.name && s.name !== `Room ${roomId}`), auto_connect: s.auto_connect }));
      } catch {
        /* drop invalid entry */
      }
    }
    persistRooms();
    if (opts.autoConnect !== false) {
      for (const r of rooms.values()) {
        if (r.auto_connect) connectRoom(r).catch((e) => console.warn('[p2p] auto-connect failed', r.roomId, e));
      }
    }
  })();

  // ---- API for view.js / viewer.js -----------------------------------------------------------
  const P2P = {
    APP_ID,
    selfId: myId,
    /** MediaStream for a watched stream, or null (not watched / not arrived yet). */
    getStream(roomId, owner, streamId) {
      const r = rooms.get(roomId ?? '');
      return (r && r.incoming.get(`${owner}:${Number(streamId)}`)) || null;
    },
    /** cb({roomId, owner, stream_id, stream}) whenever a watched stream arrives. Returns unsubscribe. */
    onStream(cb) {
      let un = () => {};
      listen('p2p-stream', ({ payload }) => cb(payload)).then((u) => (un = u));
      return () => un();
    },
    /** cb({roomId, owner, stream_id}) when a watched stream goes away. Returns unsubscribe. */
    onStreamRemoved(cb) {
      let un = () => {};
      listen('p2p-stream-removed', ({ payload }) => cb(payload)).then((u) => (un = u));
      return () => un();
    },
    /** All currently received streams: [{roomId, owner, stream_id, stream}] */
    getStreams() {
      const out = [];
      for (const r of rooms.values()) {
        for (const [k, stream] of r.incoming) {
          const i = k.lastIndexOf(':');
          out.push({ roomId: r.roomId, owner: k.slice(0, i), stream_id: Number(k.slice(i + 1)), stream });
        }
      }
      return out;
    },
    supportedCodecs,
    generateShareCode,
    parseShareCode,
  };

  return {
    invoke, listen, ready, P2P,
    /** Testing/debug: live view of internals. */
    // Share codes are the room passwords: hand out room entries WITHOUT `code`, and no TURN credentials.
    _debug: {
      get rooms() {
        return new Map([...rooms].map(([id, r]) => [id, { ...r, code: undefined }]));
      },
      captures, destinations, current,
    },
    destroy() {
      clearInterval(statsTimer);
    },
  };
}
