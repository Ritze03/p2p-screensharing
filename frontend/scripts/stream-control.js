// stream-control.js — Stream Control tab content: the ACTIVE SHARES grid (one
// card per outgoing destination, i.e. a screen capture sent into one room,
// plus staged "not live yet" captures) and the "Share screen" entry point.
//
// Every backend touchpoint below is a small `async function` calling
// `window.__TAURI__.core.invoke(...)` — the seam the P2P backend
// (p2p/tauri-shim.js) installs.
//
// Command surface used here:
//   list_saved_rooms, list_active_streams, list_staged_captures,
//   supported_codecs, get_start_stream_defaults, set_start_stream_defaults,
//   stage_video_share, set_framerate, set_bitrate, set_codec, set_preset,
//   go_live, stop_share, edit_destination, set_share_audio, stop_destination,
//   retry_destination, start_destination.
//
// Encoder settings (framerate / bitrate / codec / preset) and the audio on/off
// flag are the only knobs: `edit_destination` takes a full edit, and the
// process-wide `set_*` setters seed the *next* staged capture.

(function () {
  "use strict";

  const { el, icon, card, destinationCard, renderEmptyState } = window.Components;

  // ---------------------------------------------------------------------
  // Data touchpoints
  // ---------------------------------------------------------------------

  const { invoke } = window.__TAURI__.core;

  // [{ id: roomId, name }] — joined rooms only (the pickers' options).
  let joinedRooms = [];
  // `capture_id` groups destinations sharing one screen capture, for
  // fan-out's "disable rooms this capture already feeds" rule.
  let dests = [];
  // Staged captures — running, not yet sent anywhere ("Go live" not pressed).
  let stagedCaptures = [];
  // Which codecs this machine can encode (`supported_codecs`); feeds every
  // card's Codec pill switch so it can grey out unusable options. Defaults to
  // the conservative `["h264"]` until the real fetch resolves.
  let supportedCodecs = ["h264"];

  function pendingRoleText(pending) {
    return pending === "fan_out" ? "Also sending here…" : null;
  }

  function roomName(roomId) {
    const room = joinedRooms.find((r) => r.id === roomId);
    return room ? room.name : String(roomId);
  }

  async function fetchJoinedRooms() {
    const rows = await invoke("list_saved_rooms");
    return rows.filter((r) => r.state === "joined").map((r) => ({ id: r.roomId, name: r.name }));
  }

  async function fetchSupportedCodecs() {
    return await invoke("supported_codecs");
  }

  async function fetchActiveDestinations() {
    const rows = await invoke("list_active_streams");
    rows.forEach((d) => {
      d.pendingRoleText = pendingRoleText(d.pending);
    });
    return rows;
  }

  async function fetchStagedCaptures() {
    return await invoke("list_staged_captures");
  }

  async function applyDestinationEdit(destinationId, patch) {
    const dest = dests.find((d) => d.destination_id === destinationId);
    const edit = dest ? getDestEdit(dest) : Object.assign({ bitrateKbps: 3000, framerate: 30, codec: "h264", preset: "balanced", error: null }, patch);
    // Audio is a per-capture flag with its own command; everything else goes
    // out together as one full `edit_destination`.
    const { shareAudio, ...encoderPatch } = patch;
    Object.assign(edit, encoderPatch);
    if (dest) destEditState.set(destinationId, edit);

    if (shareAudio !== undefined && dest) await setShareAudio(dest, shareAudio, edit);
    if (Object.keys(encoderPatch).length === 0) return;

    try {
      await invoke("edit_destination", {
        destinationId,
        framerate: edit.framerate,
        bitrateKbps: edit.bitrateKbps,
        codec: edit.codec,
        preset: edit.preset,
      });
      edit.error = null;
    } catch (e) {
      // A live re-configuration can legitimately fail (e.g. the new codec is
      // rejected) — surface it on the card instead of swallowing it.
      edit.error = String(e);
    }
    // Mirror what was applied onto the local row so the card's readouts agree
    // with its controls: a bitrate-only change never fires
    // `destination-state-changed`, so nothing else would refresh them.
    if (dest && !edit.error) {
      dest.bitrate_kbps = edit.bitrateKbps;
      dest.framerate = edit.framerate;
      dest.codec = edit.codec;
      dest.preset = edit.preset;
    }
    render();
  }

  /** Share-audio on/off for a live capture (all of its destinations). */
  async function setShareAudio(dest, enabled, edit) {
    try {
      await invoke("set_share_audio", { captureId: dest.capture_id, enabled });
      if (edit) edit.error = null;
    } catch (e) {
      if (edit) edit.error = String(e);
      render();
      return;
    }
    dests.filter((d) => d.capture_id === dest.capture_id).forEach((d) => (d.audio = enabled));
    render();
  }

  async function stopDestination(destinationId) {
    // Drop this destination's client-side maps right away rather than waiting
    // for the next render pass — destination ids are never reused, so
    // leaving them would be a slow leak.
    destStalledSince.delete(destinationId);
    destEditState.delete(destinationId);
    destSparkHistory.delete(destinationId);
    await invoke("stop_destination", { destinationId });
  }

  /** "Retry" on a failed destination card: tears the dead branch down and
   * brings a fresh one up in the same room off the same capture. */
  async function retryDestination(dest) {
    await invoke("retry_destination", { destinationId: dest.destination_id });
  }

  /** "Also send to…": the new destination starts with the source card's
   * current (buffered) values, sent explicitly so they override the backend's
   * process-wide ones. */
  async function fanoutDestination(srcDest, targetRoomId) {
    const edit = getDestEdit(srcDest);
    await invoke("start_destination", {
      captureId: srcDest.capture_id,
      roomId: targetRoomId,
      framerate: edit.framerate,
      bitrateKbps: edit.bitrateKbps,
      codec: edit.codec,
      preset: edit.preset,
    });
  }

  /** "Share screen" clicked: start the staged half of the "Go live" flow — a
   * real capture (the OS/browser picker appears here) that is not sent
   * anywhere until the staged card's own "Go live". */
  async function stageVideoShare() {
    setStageError(null);
    try {
      // Seed the process-wide "next capture" settings from the last-used
      // values, so a new staged card opens on what "Go live" last used.
      const defaults = await fetchStartStreamDefaults();
      if (defaults) {
        await invoke("set_framerate", { fps: defaults.fps });
        await invoke("set_bitrate", { kbps: defaults.bitrateKbps });
        await invoke("set_codec", { codec: defaults.codec });
        await invoke("set_preset", { preset: defaults.preset });
      }
      await invoke("stage_video_share");
      stagedCaptures = await fetchStagedCaptures();
      render();
    } catch (e) {
      // Dismissing the screen picker is the user's own choice, not an error:
      // nothing to show (the old app behaved the same).
      if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) return;
      setStageError(`Couldn't start the screen capture: ${e && e.message ? e.message : e}`);
    }
  }

  /** The persisted last-used values (`get_start_stream_defaults`): seeds a new
   * staged card's edit buffer. */
  async function fetchStartStreamDefaults() {
    const d = await invoke("get_start_stream_defaults");
    if (!d) return null;
    return {
      fps: d.framerate,
      bitrateKbps: d.bitrate_kbps,
      codec: d.codec,
      preset: d.preset,
      shareAudio: !!d.share_audio,
    };
  }

  // captureId -> { bitrateKbps, framerate, codec, preset, shareAudio, roomId,
  // error }. Local edit buffer for a staged card's controls (same "caller
  // keeps the state, card renders from the buffer" shape as `destEditState`);
  // `roomId` — which room "Go live" will use — has nowhere else to live until
  // "Go live" is pressed.
  const stagedEditState = new Map();

  function getStagedEdit(staged) {
    let s = stagedEditState.get(staged.capture_id);
    if (!s) {
      s = {
        bitrateKbps: staged.bitrate_kbps,
        framerate: staged.framerate,
        codec: staged.codec,
        preset: staged.preset || "balanced",
        shareAudio: !!staged.share_audio,
        roomId: null,
        error: null,
      };
      stagedEditState.set(staged.capture_id, s);
    }
    // A staged card's room may have been left since; fall back to the first
    // joined room rather than "Go live"-ing into one that no longer exists.
    if (!joinedRooms.some((r) => r.id === s.roomId)) s.roomId = joinedRooms.length > 0 ? joinedRooms[0].id : null;
    return s;
  }

  /** Framerate / bitrate / codec / preset / audio changed on a staged card.
   * Writes through the process-wide setters (the capture reads those), *not*
   * `set_start_stream_defaults` — persisting happens once, at "Go live". */
  async function applyStagedTuning(captureId, staged, patch) {
    const edit = getStagedEdit(staged);
    Object.assign(edit, patch);
    try {
      if ("framerate" in patch) await invoke("set_framerate", { fps: edit.framerate });
      if ("bitrateKbps" in patch) await invoke("set_bitrate", { kbps: edit.bitrateKbps });
      if ("codec" in patch) await invoke("set_codec", { codec: edit.codec });
      if ("preset" in patch) await invoke("set_preset", { preset: edit.preset });
      // `shareAudio` is local until "Go live" (sent with `go_live`).
      edit.error = null;
    } catch (e) {
      edit.error = String(e);
    }
    render();
  }

  /** Room picker changed on a staged card — purely local until "Go live". */
  function setStagedRoom(captureId, roomId) {
    const s = stagedEditState.get(captureId);
    if (s) s.roomId = roomId;
    render();
  }

  /** "Go live" clicked: attach the staged capture to the picked room, then
   * persist the card's settings as the new "last used" defaults. */
  async function goLive(captureId, staged) {
    const edit = getStagedEdit(staged);
    if (edit.roomId == null) return;
    try {
      // The card's own values go with the call (they override the backend's
      // process-wide ones, which a second staged capture may have reseeded).
      await invoke("go_live", {
        captureId,
        roomId: edit.roomId,
        shareAudio: edit.shareAudio,
        framerate: edit.framerate,
        bitrateKbps: edit.bitrateKbps,
        codec: edit.codec,
        preset: edit.preset,
      });
    } catch (e) {
      edit.error = String(e);
      render();
      return;
    }
    try {
      await invoke("set_start_stream_defaults", {
        framerate: edit.framerate,
        bitrateKbps: edit.bitrateKbps,
        codec: edit.codec,
        preset: edit.preset,
        shareAudio: edit.shareAudio,
      });
    } catch (e) {
      console.error("failed to save start-stream defaults", e);
    }
    stagedEditState.delete(captureId);
    stagedCaptures = await fetchStagedCaptures();
    dests = await fetchActiveDestinations();
    // Seed the new destination's edit buffer from the staged card, so its
    // controls show what was actually picked. `go_live` attaches exactly one
    // destination per call, so `capture_id` is unambiguous.
    for (const dest of dests) {
      if (dest.capture_id === captureId) {
        destEditState.set(dest.destination_id, {
          bitrateKbps: edit.bitrateKbps,
          framerate: edit.framerate,
          codec: edit.codec,
          preset: edit.preset,
          error: null,
        });
      }
    }
    render();
  }

  /** "Cancel" on a staged card: tear the capture down before it ever sent
   * anything. */
  async function cancelStagedCapture(captureId) {
    stagedEditState.delete(captureId);
    await invoke("stop_share", { captureId });
    stagedCaptures = await fetchStagedCaptures();
    render();
  }

  // ---------------------------------------------------------------------
  // Render — targeted reconciliation, not `innerHTML = ""` + full rebuild.
  //
  // Every `presence-updated` / `destination-state-changed` event used to wipe
  // and rebuild every card, and a click landing between a node's removal and
  // its replacement's listener attach was silently dropped. Here each
  // destination card keeps its DOM node (and listeners) across `render()`
  // unless a cheap signature of the data it displays changed; unchanged cards
  // are *moved* into place (a no-op if already there), never recreated.
  // ---------------------------------------------------------------------

  let gridEl = null;
  let activeSharesCardEl = null;
  let activeSharesGridEl = null;
  let activeSharesBodySig = null;
  const destCardEls = new Map(); // destination_id -> { el, sig }
  const stagedCardEls = new Map(); // capture_id -> { el, sig }
  // destination_id -> ms epoch first observed 'stalled' (no DTO carries a
  // "since" timestamp, so it's tracked client-side).
  const destStalledSince = new Map();

  function getStalledSince(dest) {
    if (dest.state !== "stalled") {
      destStalledSince.delete(dest.destination_id);
      return null;
    }
    if (!destStalledSince.has(dest.destination_id)) destStalledSince.set(dest.destination_id, Date.now());
    return destStalledSince.get(dest.destination_id);
  }
  // destination_id -> { bitrateKbps, framerate, codec, preset, error }. The
  // edit buffer every control of a live card renders from (the destination
  // row lags behind live edits — see `destinationCard`'s doc comment).
  const destEditState = new Map();
  // destination_id -> number[] (last SPARK_BARS `sent_fps` samples), built from
  // the stats stream purely to feed the card's inline sparkline.
  const destSparkHistory = new Map();
  const SPARK_BARS = 6;

  function getDestEdit(dest) {
    let s = destEditState.get(dest.destination_id);
    if (!s) {
      s = {
        bitrateKbps: dest.bitrate_kbps,
        framerate: dest.framerate,
        codec: dest.codec || "h264",
        preset: dest.preset || "balanced",
        error: null,
      };
      destEditState.set(dest.destination_id, s);
    }
    return s;
  }

  // The framerates the Framerate picker offers, plus this card's own current
  // rate if it somehow isn't one of them (a clamped or older stream must still
  // be shown truthfully rather than silently snapped to a neighbour).
  const FRAMERATE_OPTIONS = [15, 30, 60, 90, 120, 144, 165, 240];
  // Wayland/PipeWire screen capture tops out around 90 fps (xdph timer floor), whatever is
  // requested; higher options stay selectable (encoder cap, other platforms' streams).
  const IS_LINUX = /linux/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "");
  const FPS_HINT = "~90 max on this system";
  /** Fills the empty cell next to a card's Framerate dropdown with the Linux capture-limit hint. */
  function withFramerateHint(card) {
    if (!IS_LINUX || !card) return card;
    const select = card.querySelector(".dest-framerate-select");
    const dd = select && select.closest(".dd");
    const cell = dd && dd.nextElementSibling;
    if (cell && !cell.textContent) {
      cell.textContent = FPS_HINT;
      cell.className = "dest-fps-hint";
      cell.style.cssText = "font-size:10px;white-space:nowrap;color:var(--text-faint)";
      cell.title = "Screen capture on Linux/Wayland reaches about 90 fps at most; higher settings only raise the encoder cap.";
    }
    return card;
  }
  function framerateOptionsFor(editState) {
    if (!editState) return FRAMERATE_OPTIONS;
    const current = Number(editState.framerate);
    if (!current || FRAMERATE_OPTIONS.includes(current)) return FRAMERATE_OPTIONS;
    return FRAMERATE_OPTIONS.concat([current]).sort((a, b) => a - b);
  }

  /** Reconciles `parent`'s children to exactly `children` (falsy entries
   * dropped), reusing/moving existing nodes instead of recreating them —
   * `insertBefore`/`appendChild` on a node already in the right place is a
   * no-op, so an unchanged child never loses its listeners or an in-flight
   * click. */
  function syncChildren(parent, children) {
    const wanted = children.filter(Boolean);
    wanted.forEach((child, i) => {
      if (parent.children[i] !== child) parent.insertBefore(child, parent.children[i] || null);
    });
    while (parent.children.length > wanted.length) parent.removeChild(parent.lastChild);
  }

  function render() {
    const root = document.getElementById("stream-control-root");
    if (!root) return;
    if (!gridEl) {
      gridEl = el("div", { className: "sc-grid" });
      root.appendChild(gridEl);
    }
    syncChildren(gridEl, [updateActiveSharesCard()]);
  }

  // ---------------------------------------------------------------------
  // Active shares card — keyed per-destination reconciliation.
  // ---------------------------------------------------------------------

  // Ghost row ("Share screen" / "Share another screen") — built once and
  // cached so it is *moved* (never recreated) into whichever card variant
  // (`empty`/`list`) is currently live.
  let activeSharesGhostEl = null;
  let ghostLabelEl = null;
  let stageErrorEl = null;

  function buildGhostRows() {
    if (activeSharesGhostEl) return activeSharesGhostEl;
    const wrap = el("div", { className: "sc-ghost-rows" });

    // Starts a real, staged capture right away (the screen picker appears) and
    // lets it render as its own card in the grid; nothing is sent to any room
    // until that card's "Go live".
    const screenRow = el("div", {
      className: "sc-ghost-row",
      attrs: { role: "button", tabindex: "0" },
      onClick: () => stageVideoShare(),
    });
    screenRow.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        stageVideoShare();
      }
    });
    screenRow.appendChild(icon("cast", "sc-ghost-row-icon sc-ghost-row-icon-accent"));
    ghostLabelEl = el("span", { text: "Share screen" });
    screenRow.appendChild(ghostLabelEl);
    wrap.appendChild(screenRow);

    stageErrorEl = el("div", { className: "dest-edit-error sc-stage-error", attrs: { hidden: "" } });
    wrap.appendChild(stageErrorEl);

    activeSharesGhostEl = wrap;
    return wrap;
  }

  function setStageError(msg) {
    buildGhostRows();
    stageErrorEl.textContent = msg || "";
    stageErrorEl.hidden = !msg;
  }

  function updateActiveSharesCard() {
    buildGhostRows();
    const hasAny = dests.length > 0 || stagedCaptures.length > 0;
    ghostLabelEl.textContent = hasAny ? "Share another screen" : "Share screen";

    if (!hasAny) {
      destCardEls.clear();
      stagedCardEls.clear();
      if (!activeSharesCardEl || activeSharesBodySig !== "empty") {
        activeSharesCardEl = card(
          "ACTIVE SHARES",
          [
            renderEmptyState("Share your screen below to see it here.", null, null, {
              icon: "cast",
              headline: "No active shares yet",
            }),
          ],
          { className: "sc-active-shares-card" }
        );
        activeSharesCardEl.appendChild(activeSharesGhostEl);
        activeSharesBodySig = "empty";
        activeSharesGridEl = null;
      }
      return activeSharesCardEl;
    }

    if (!activeSharesCardEl || activeSharesBodySig === "empty") {
      activeSharesCardEl = card("ACTIVE SHARES", [], { className: "sc-active-shares-card" });
      activeSharesGridEl = el("div", { className: "sc-active-shares-grid" });
      activeSharesCardEl.appendChild(activeSharesGridEl);
      activeSharesCardEl.appendChild(activeSharesGhostEl);
    }
    activeSharesBodySig = "list";

    // Staged cards render first, ahead of live ones.
    const seenStagedIds = new Set();
    const stagedCardEl = (staged) => {
      seenStagedIds.add(staged.capture_id);
      const edit = getStagedEdit(staged);
      const sig = JSON.stringify({ staged, edit, roomOptions: joinedRooms, supportedCodecs });
      let entry = stagedCardEls.get(staged.capture_id);
      if (!entry || entry.sig !== sig) {
        entry = {
          el: withFramerateHint(destinationCard(
            staged,
            {
              onEditApply: (captureId, patch) => applyStagedTuning(captureId, staged, patch),
              onStagedRoomChange: (captureId, roomId) => setStagedRoom(captureId, roomId),
              onGoLive: (captureId) => goLive(captureId, staged),
              onCancel: (captureId) => cancelStagedCapture(captureId),
            },
            {
              staged: true,
              stagedRoomId: edit.roomId,
              roomOptions: joinedRooms,
              framerateOptions: framerateOptionsFor(edit),
              // A staged row carries its own list; fall back to the global one
              // only if a row happens not to.
              supportedCodecs: staged.supported_codecs || supportedCodecs,
              editState: edit,
            }
          )),
          sig,
        };
        stagedCardEls.set(staged.capture_id, entry);
      }
      return entry.el;
    };
    const stagedCardElsOrdered = stagedCaptures.map(stagedCardEl);
    for (const id of Array.from(stagedCardEls.keys())) {
      if (!seenStagedIds.has(id)) stagedCardEls.delete(id);
    }

    const seenIds = new Set();
    const orderedCardEls = dests.map((dest) => {
      seenIds.add(dest.destination_id);
      // Room names can change after the row was fetched (rename, or
      // adopted from a peer), so the label is resolved at render time.
      dest.room_label = roomName(dest.roomId);
      const roomsAlreadyFedByCapture = dests.filter((d) => d.capture_id === dest.capture_id).map((d) => d.roomId);
      const editState = getDestEdit(dest);
      const stalledSince = getStalledSince(dest);
      const sig = JSON.stringify({ dest, editState, roomOptions: joinedRooms, roomsAlreadyFedByCapture, stalledSince, supportedCodecs });

      let entry = destCardEls.get(dest.destination_id);
      if (!entry || entry.sig !== sig) {
        entry = {
          el: withFramerateHint(destinationCard(
            dest,
            {
              onEditApply: (id, patch) => applyDestinationEdit(id, patch),
              onFanout: (captureId, targetRoomId) => fanoutDestination(dest, targetRoomId),
              onStop: (id) => stopDestination(id),
              onRetry: (d) => retryDestination(d),
            },
            {
              roomOptions: joinedRooms,
              framerateOptions: framerateOptionsFor(editState),
              // A live destination row has no `supported_codecs` of its own —
              // the globally-fetched list is the only source.
              supportedCodecs,
              roomsAlreadyFedByCapture,
              editState,
              stalledSince,
            }
          )),
          sig,
        };
        destCardEls.set(dest.destination_id, entry);
      }
      return entry.el;
    });

    for (const id of Array.from(destCardEls.keys())) {
      if (!seenIds.has(id)) destCardEls.delete(id);
    }

    syncChildren(activeSharesGridEl, stagedCardElsOrdered.concat(orderedCardEls));
    return activeSharesCardEl;
  }

  // ---------------------------------------------------------------------
  // Init — fetches every data touchpoint, then renders. Also the "refresh"
  // this tab exposes on `window.StreamControl` for `shell.js`'s event
  // listeners to call after a room / destination change.
  // ---------------------------------------------------------------------

  async function init() {
    joinedRooms = await fetchJoinedRooms();
    dests = await fetchActiveDestinations();
    stagedCaptures = await fetchStagedCaptures();
    supportedCodecs = await fetchSupportedCodecs();
    render();
  }

  // `stream-stats-updated` fires ~4x/sec, so this deliberately bypasses the
  // sig-diffed `render()` path: it writes straight into each already-rendered
  // card's readout nodes via `textContent`, keyed off `destCardEls`. A
  // destination in the payload with no rendered card yet is skipped.
  function updateStats(payload) {
    const destinations = (payload && payload.destinations) || [];
    destinations.forEach((d) => {
      const entry = destCardEls.get(d.destination_id);
      if (!entry) return;
      const readout = entry.el.querySelector(".dest-fps-readout");
      if (readout) {
        readout.hidden = false;
        readout.textContent = `Captured: ${Math.round(d.captured_fps)}fps · Sent: ${Math.round(d.sent_fps)}fps`;
      }

      // The destination's real live bitrate — written straight to the DOM (and
      // the cached row) because a live bitrate change never fires
      // `destination-state-changed`, so the card would otherwise go stale.
      if (d.bitrate_kbps !== null && d.bitrate_kbps !== undefined) {
        const dest = dests.find((x) => x.destination_id === d.destination_id);
        if (dest) dest.bitrate_kbps = d.bitrate_kbps;
        const bitrateValue = entry.el.querySelector(".dest-metric-bitrate-value");
        if (bitrateValue) bitrateValue.textContent = `${d.bitrate_kbps} kbps`;
      }

      // Sparkline: push this tick's `sent_fps` onto the rolling window, then
      // rescale every bar against the window's own max (so both a 30fps and a
      // 240fps stream read as a legible shape).
      const spark = entry.el.querySelector(".dest-sparkline");
      if (!spark) return;
      let hist = destSparkHistory.get(d.destination_id);
      if (!hist) {
        hist = [];
        destSparkHistory.set(d.destination_id, hist);
      }
      hist.push(Number(d.sent_fps) || 0);
      if (hist.length > SPARK_BARS) hist.shift();

      const max = Math.max(1, ...hist);
      const bars = spark.querySelectorAll(".spark-bar");
      const padCount = SPARK_BARS - hist.length;
      bars.forEach((bar, i) => {
        const histIdx = i - padCount;
        if (histIdx < 0) {
          bar.classList.add("spark-bar-empty");
          bar.style.height = "";
          return;
        }
        bar.classList.remove("spark-bar-empty");
        bar.style.height = Math.max(8, Math.round((hist[histIdx] / max) * 100)) + "%";
      });
      spark.hidden = false;
    });
  }

  window.StreamControl = { refresh: init, updateStats, stopDestination };

  document.addEventListener("DOMContentLoaded", init);
})();
