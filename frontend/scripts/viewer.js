// viewer.js — pop-out stream viewer window content.
//
// Loaded by `frontend/viewer.html`, which `view.js`'s `popOutWatch` opens with
// `window.open` FROM THE MAIN WINDOW (see `electron/main.js`'s
// `setWindowOpenHandler`). That is the whole trick: a MediaStream cannot be
// sent to another window (postMessage of a track throws DataCloneError), so
// this window reads it straight from `window.opener.P2P.getStream(...)`, live
// stats from `window.opener.__TAURI__.event`, and volume/mute from
// `window.opener.ViewTab`. It never joins the room itself and has no preload:
// fullscreen is the web Fullscreen API (Electron maps it to real OS
// fullscreen) and closing is `window.close()`. If the main window goes away
// this window is closed with it (main.js).
//
// The stream to show comes on the query string: `key` (the View tab's tile id,
// the handle for `ViewTab.getAudio/setAudio`), `roomId`, `owner`, `streamId`,
// plus display metadata (`ownerLabel`, `roomLabel`, `hasAudio`, `resolution`).
//
// F11 toggles fullscreen; Escape only ever exits fullscreen (native), it never
// closes the window. Only the x button or the OS window close does.

(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const main = window.opener && !window.opener.closed ? window.opener : null;
  const tile = {
    key: params.get("key"),
    roomId: params.get("roomId"),
    owner: params.get("owner"),
    streamId: Number(params.get("streamId")),
    ownerLabel: params.get("ownerLabel"),
    roomLabel: params.get("roomLabel"),
    hasAudio: params.get("hasAudio") === "1",
    resolution: params.get("resolution"),
  };

  const cleanups = [];

  function el(tag, opts, children) {
    const node = document.createElement(tag);
    opts = opts || {};
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.attrs) {
      for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
    }
    if (opts.onClick) node.addEventListener("click", opts.onClick);
    (children || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  /** A single Material Symbols glyph — mirrors `components.js`'s `icon()`
   * (this lean window doesn't load `components.js`, just `fonts.css`). */
  function icon(name) {
    return el("span", { className: "material-symbols-outlined", text: name });
  }

  const formatBitrate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);

  /** Builds the mute + volume pill into `bottom`, mirroring `view.js`'s
   * `renderTile`. State lives in the main window's `ViewTab` (the single
   * source of truth, so the tile shows the same value when it comes back);
   * this window's own `<video>` is what actually plays. */
  function appendAudioGroup(video, bottom) {
    let { volume, muted: isMuted } = main.ViewTab.getAudio(tile.key);
    const apply = () => {
      video.volume = volume / 100;
      video.muted = isMuted;
      main.ViewTab.setAudio(tile.key, volume, isMuted);
    };
    video.volume = volume / 100;
    video.muted = isMuted;

    const buildAudioGroup = (muted) => {
      const group = el("div", { className: "media-tile-audio" + (muted ? " media-tile-audio-muted" : "") });
      group.appendChild(
        el(
          "button",
          {
            className: "media-tile-audio-btn",
            attrs: { title: muted ? "Unmute" : "Mute", "aria-label": muted ? "Unmute" : "Mute" },
            onClick: (e) => {
              e.stopPropagation();
              isMuted = !isMuted;
              apply();
              const next = buildAudioGroup(isMuted);
              bottom.replaceChild(next, audioGroup);
              audioGroup = next;
            },
          },
          [icon(muted ? "volume_off" : "volume_up")]
        )
      );
      if (!muted) {
        const slider = el("input", {
          className: "media-tile-audio-slider",
          attrs: { type: "range", min: "0", max: "100", step: "5", "aria-label": "Volume" },
        });
        slider.value = String(volume);
        slider.addEventListener("click", (e) => e.stopPropagation());
        slider.addEventListener("input", () => {
          volume = Number(slider.value);
          apply();
        });
        // Release focus once a mouse drag ends: this tile fills the whole
        // viewport, and a slider left focused keeps `.viewer-tile:focus-within`
        // (viewer.css) true, pinning the overlay visible with the mouse gone.
        slider.addEventListener("mouseup", () => slider.blur());
        group.appendChild(slider);
      }
      return group;
    };
    let audioGroup = buildAudioGroup(isMuted);
    bottom.appendChild(audioGroup);
  }

  /** Renders the stream: a full-bleed `<video>`, plus the same hover chrome
   * (stat bar, vignette, audio control) as the View tab's tile. */
  function renderTile() {
    const wrap = el("div", { className: "viewer-tile" });
    const video = el("video", { attrs: { autoplay: "", playsinline: "", "aria-label": tile.ownerLabel || "Stream" } });
    const connecting = el("div", { className: "viewer-tile-placeholder" }, [el("span", { text: "Connecting…" })]);
    video.srcObject = main.P2P.getStream(tile.roomId, tile.owner, tile.streamId);
    connecting.hidden = video.readyState >= 2;
    video.onplaying = () => {
      connecting.hidden = true;
    };
    wrap.appendChild(video);
    wrap.appendChild(connecting);

    // The stream can (re)arrive after this window opened, or end while it is
    // open; ending closes the window (the View tab drops the tile too).
    const key = `${tile.owner}:${tile.streamId}`;
    cleanups.push(
      main.P2P.onStream((s) => {
        if (s.roomId === tile.roomId && `${s.owner}:${s.stream_id}` === key) video.srcObject = s.stream;
      }),
      main.P2P.onStreamRemoved((s) => {
        if (s.roomId === tile.roomId && `${s.owner}:${s.stream_id}` === key) window.close();
      })
    );

    if (tile.ownerLabel) {
      const statbar = el("div", { className: "media-tile-statbar" });
      statbar.appendChild(el("span", { className: "media-tile-statbar-dot" }));
      const label = tile.roomLabel ? `${tile.ownerLabel} · ${tile.roomLabel}` : tile.ownerLabel;
      statbar.appendChild(el("span", { className: "media-tile-statbar-name", text: label }));
      if (tile.resolution) {
        statbar.appendChild(el("span", { className: "media-tile-statbar-sep", text: "·" }));
        statbar.appendChild(el("span", { className: "media-tile-statbar-value", text: tile.resolution }));
      }
      const fpsSpan = el("span", { className: "media-tile-statbar-value", text: "" });
      const bitrateSpan = el("span", { className: "media-tile-statbar-value", text: "" });
      statbar.appendChild(fpsSpan);
      statbar.appendChild(bitrateSpan);
      if (tile.hasAudio) {
        const badge = el("span", { className: "media-tile-statbar-audio-badge", attrs: { title: "Sharing audio", "aria-label": "Sharing audio" } });
        badge.appendChild(icon("volume_up"));
        statbar.appendChild(badge);
      }
      wrap.appendChild(statbar);

      // Live fps / bitrate from the main window's stats event (this window
      // has no `shell.js` to fan it out).
      main.__TAURI__.event
        .listen("stream-stats-updated", ({ payload }) => {
          const w = ((payload && payload.watched) || []).find(
            (x) => x.roomId === tile.roomId && x.owner === tile.owner && x.stream_id === tile.streamId
          );
          if (!w) return;
          fpsSpan.textContent = `${Math.round(w.fps)}fps`;
          bitrateSpan.textContent = formatBitrate(w.bitrate_kbps);
        })
        .then((unlisten) => cleanups.push(unlisten));

      const vignette = el("div", { className: "media-tile-vignette" });
      const overlay = el("div", { className: "media-tile-overlay" });
      // Empty top spacer: with a single flex child `.media-tile-overlay`'s
      // `justify-content: space-between` would put the audio pill at the top.
      const top = el("div", { className: "media-tile-overlay-top" });
      const bottom = el("div", { className: "media-tile-overlay-bottom" });
      if (tile.hasAudio) appendAudioGroup(video, bottom);
      overlay.appendChild(top);
      overlay.appendChild(bottom);
      wrap.appendChild(vignette);
      wrap.appendChild(overlay);
    }
    return wrap;
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  function setupExitControls() {
    document.getElementById("viewer-root").before(
      el("button", {
        className: "viewer-exit-btn",
        text: "×",
        attrs: { type: "button", title: "Exit viewer", "aria-label": "Exit viewer" },
        onClick: () => window.close(),
      })
    );

    document.addEventListener("keydown", (e) => {
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "Escape" && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  // Unsubscribe from the main window's event streams before this window goes
  // away, so nothing there keeps calling into a dead window.
  window.addEventListener("pagehide", () => {
    cleanups.splice(0).forEach((fn) => fn());
  });

  function init() {
    setupExitControls();
    const root = document.getElementById("viewer-root");
    if (!main || !tile.roomId || !tile.owner || !Number.isInteger(tile.streamId)) {
      root.appendChild(el("div", { className: "viewer-empty", text: "No stream to show." }));
      return;
    }
    if (tile.ownerLabel) document.title = `${tile.ownerLabel}${tile.roomLabel ? ` · ${tile.roomLabel}` : ""}`;
    const grid = el("div", { className: "viewer-grid" }, [renderTile()]);
    grid.style.gridTemplateColumns = "1fr";
    grid.style.gridTemplateRows = "1fr";
    root.appendChild(grid);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
