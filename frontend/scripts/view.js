// view.js — View tab content: the auto-tiled grid of watched streams.
//
// Data: `list_saved_rooms` for the joined rooms, then `room_detail` per room,
// joining that room's `watched` against its `streams` (resolution, audio flag)
// and `members` (display name). There is no single "list watched streams"
// command.
//
// Video: each tile is a `<video autoplay playsinline>` whose `srcObject` is the
// MediaStream from `window.P2P.getStream(roomId, owner, stream_id)`. Watching
// is asynchronous: `toggle_watch` only *requests* the stream, it arrives later
// through `P2P.onStream` (handled below), so a tile can exist for a moment
// with a "Connecting..." placeholder and no `srcObject`. The `<video>` element
// of a tile survives `render()` (`tileVideos`), so playback doesn't restart
// on every refresh.
//
// Pop-out: `popOutWatch` opens `viewer.html` with `window.open` from THIS
// window. A MediaStream cannot cross windows through postMessage, so
// `viewer.js` reads it straight from `window.opener.P2P` and volume/mute from
// `window.opener.ViewTab`. The pop-out never joins the room itself. The
// popped-out tile keeps its grid slot as a dashed "held" placeholder; the slot
// is released when the pop-out window closes (polled via `Window.closed`) or
// via "Bring it back".
//
// Per-tile volume/mute is the local `<video>.volume`/`.muted` (0-100 %).

(function () {
  "use strict";

  const { el, icon, renderEmptyState, secondaryButton } = window.Components;

  // "NOT ON SCREEN" rail data — streams the user can watch but isn't
  // currently displaying. Rebuilt by `fetchWatchedStreams` on every
  // `init()`.
  let notOnScreenStreams = [];

  // Tiles from the last `fetchWatchedStreams`.
  let watchedTiles = [];

  // Signature of the last rendered data; `init()` skips a re-render when
  // nothing visible changed (a refresh fires on every presence event, and a
  // rebuild would exit a fullscreen tile and reset the stat readouts).
  let lastSignature = "";

  // Selected room filter chip ("All rooms" when null) — pruned back to null
  // right before a render if the selected room no longer has any tiles.
  let roomFilter = null;

  // Tile ids currently popped out to their own window (`popOutWatch`) —
  // rendered as a held dashed-border slot instead of video. Cleared by "Bring
  // it back" or when the pop-out window closes (polled, see `popouts`).
  const poppedOutIds = new Set();

  // Dynamic grid layout (2026-07-28) — see `computeGridShape`'s doc comment
  // for the algorithm and `applyGridLayout` for how it's wired to the DOM.
  // `currentGridEl`/`currentTileCount` are the last-rendered grid's element
  // and on-screen tile count (including held slots), kept outside `render()`
  // so a debounced resize can recompute the layout without a full rebuild.
  let currentGridEl = null;
  let currentTileCount = 0;
  let gridLayoutDebounce = null;

  // Must match `.view-grid`'s `gap` in view.css.
  const GRID_GAP_PX = 12;

  /** Pure layout math — no DOM access, easy to sanity-check standalone (see
   * this file's matching `superdoc/features/viewer-window.md` entry for how
   * this was verified without a JS test framework).
   *
   * Replaces the old `ceil(sqrt(n))` "square-ish grid" heuristic, which only
   * looked at the tile count and ignored the window's actual shape — in a
   * tall/narrow window, 2 side-by-side 16:9 tiles each shrink to fit the
   * width, wasting most of the window's height as letterboxing above/below.
   *
   * For every `cols` from 1 to `n` (rows = `ceil(n / cols)`, the minimum
   * rows that fit `n` tiles at that column count — never more, per the task
   * brief's `(rows-1) * cols < n` invariant, which `ceil` already
   * guarantees), this computes the size a single 16:9 tile would render at
   * if `availWidth x availHeight` were evenly divided into that `rows x
   * cols` grid (accounting for `gap` between cells), then picks whichever
   * `rows x cols` shape maximizes that per-tile displayed area. Since every
   * candidate is a uniform grid (all cells the same size), maximizing
   * per-tile area is equivalent to maximizing total displayed video area
   * across all `n` tiles — the wasted-space slots from `rows * cols > n`
   * (e.g. 3 tiles in a 2x2 grid, one cell empty) don't change any
   * individual tile's size, so they don't need special-casing here. */
  function computeGridShape(n, availWidth, availHeight, gap = GRID_GAP_PX, aspect = 16 / 9) {
    const w = Math.max(0, availWidth);
    const h = Math.max(0, availHeight);
    if (n <= 1) {
      let tileWidth = w;
      let tileHeight = tileWidth / aspect;
      if (tileHeight > h) {
        tileHeight = h;
        tileWidth = tileHeight * aspect;
      }
      return { cols: 1, rows: n, tileWidth, tileHeight };
    }

    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      if ((rows - 1) * cols >= n) continue; // dead case per the invariant above; ceil() never actually hits this
      const cellWidth = (w - gap * (cols - 1)) / cols;
      const cellHeight = (h - gap * (rows - 1)) / rows;
      if (cellWidth <= 0 || cellHeight <= 0) continue;
      let tileWidth = cellWidth;
      let tileHeight = tileWidth / aspect;
      if (tileHeight > cellHeight) {
        tileHeight = cellHeight;
        tileWidth = tileHeight * aspect;
      }
      const area = tileWidth * tileHeight;
      if (!best || area > best.area) best = { cols, rows, tileWidth, tileHeight, area };
    }
    // Degenerate fallback (availWidth/availHeight not yet laid out, e.g. 0):
    // single row, n columns, no aspect clamp against a nonexistent height.
    if (!best) {
      const tileWidth = n > 0 ? w / n : 0;
      return { cols: Math.max(1, n), rows: 1, tileWidth, tileHeight: tileWidth / aspect };
    }
    return best;
  }

  /** Measures `.content` (the always-present scroll container all tabs
   * share — stable even while this tab's panel is `hidden`) minus everything
   * above the grid (via the grid's own rendered top, see the `Why:` note
   * inside for why this isn't a hand-enumerated sibling list anymore) and
   * the "not on screen" rail below it (measured from its real rendered
   * height, not assumed), then writes the resulting shape as CSS custom
   * properties on `currentGridEl`. No-ops if the grid isn't currently
   * rendered, or if the available box measures to 0 or negative (this tab's
   * panel is `hidden`, or a render happened before first layout) — the
   * `ResizeObserver` below re-fires this once real dimensions are available
   * (a `hidden` -> visible panel transition itself is a resize of
   * `#view-root`, from 0 to its real size). */
  function applyGridLayout() {
    if (!currentGridEl || currentTileCount <= 0) return;
    const content = document.querySelector(".content");
    if (!content) return;
    const cs = getComputedStyle(content);
    const availWidth = content.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
    if (availWidth <= 0) return;

    // Bug (2026-07-28, see `superdoc/features/viewer-window.md`'s follow-up
    // entry): this used to derive `availHeight` from `.content`'s total
    // height minus *assumed* sibling heights (`.view-header`/`.view-controls`
    // above, `.view-not-on-screen` below, with hardcoded margin literals).
    // That list silently missed the `<h2>` tab title that sits above
    // `#view-root` (see index.html) — its ~35px (19px line box + 16px
    // margin-bottom) was never subtracted, so `availHeight` came out that
    // much too tall on every render. Harmless when width was the binding
    // constraint (the extra vertical slack just went unused), but on
    // height-constrained shapes (e.g. a 1-column stack, or any shape close
    // to filling the container's height) the grid was sized into space that
    // didn't actually exist, pushing its bottom — and the "not on screen"
    // rail below it — past `.content`'s visible bottom edge.
    //
    // Fixed by anchoring the top measurement to `currentGridEl`'s own
    // rendered top (`getBoundingClientRect().top`) instead of re-deriving it
    // from a hand-maintained list of siblings above it. The grid's top
    // position only depends on the layout of *everything before it* in the
    // DOM (h2, header, controls, and whatever else may be added later) —
    // never on the grid's own height — so this can't go stale the way an
    // enumerated sibling list can, and there's no gap-count/margin literal
    // to keep in sync for the "above" side anymore.
    const contentRect = content.getBoundingClientRect();
    const contentPaddingBottom = parseFloat(cs.paddingBottom || "0");
    // `content.clientHeight` spans `.content`'s full padding box (no border
    // on `.content`, so the border box and padding box coincide); subtract
    // the bottom padding to land on the real bottom edge of the usable
    // (scrollable) content area.
    const contentBottom = contentRect.top + content.clientHeight - contentPaddingBottom;
    const gridTop = currentGridEl.getBoundingClientRect().top;

    // The "not on screen" rail still needs its own hardcoded margin-top
    // (`.view-not-on-screen`'s `16px` in view.css) — it sits *after* the
    // grid, so it can't be folded into the same "measure up to my own top"
    // trick without moving the grid's height computation into a second pass.
    const railEl = document.querySelector(".view-not-on-screen");
    const usedBelow = railEl ? railEl.getBoundingClientRect().height + 16 : 0;

    const availHeight = contentBottom - gridTop - usedBelow;
    if (availHeight <= 0) return;

    const { cols, rows, tileWidth, tileHeight } = computeGridShape(currentTileCount, availWidth, availHeight);
    currentGridEl.style.setProperty("--grid-cols", String(cols));
    currentGridEl.style.setProperty("--grid-rows", String(Math.max(1, rows)));
    currentGridEl.style.setProperty("--tile-w", `${tileWidth.toFixed(2)}px`);
    currentGridEl.style.setProperty("--tile-h", `${tileHeight.toFixed(2)}px`);
  }

  // Recomputes the layout (debounced) on any resize of `#view-root` — real
  // window/sidebar resizes while this tab is visible, and also the
  // 0-size -> real-size jump when switching onto this tab from another one
  // (`shell.js`'s `setActiveTab` just flips the `hidden` attribute; it
  // doesn't know to call back into this file, so this observer is what
  // catches that transition instead of leaving a stale/zeroed layout up).
  (function watchGridContainerResize() {
    const watchedEl = document.getElementById("view-root");
    if (!watchedEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (gridLayoutDebounce) clearTimeout(gridLayoutDebounce);
      gridLayoutDebounce = setTimeout(() => {
        gridLayoutDebounce = null;
        applyGridLayout();
      }, 120);
    });
    observer.observe(watchedEl);
  })();


  const DEFAULT_VOLUME = 100;

  // Per-tile volume (0-100) and mute state, keyed by tile id. Kept here (not
  // read back from the DOM) so it survives re-renders, and shared with the
  // pop-out window through `window.ViewTab.getAudio/setAudio`.
  const tileVolume = new Map();
  const tileMuted = new Set();

  // tile id -> the tile's `<video>`. Survives `render()`; entries for tiles no
  // longer shown get their `srcObject` cleared and are dropped there.
  const tileVideos = new Map();

  // tile id -> pop-out Window, for tiles in `poppedOutIds`.
  const popouts = new Map();

  const tileId = (roomId, owner, streamId) => `${roomId}:${owner}:${streamId}`;

  function applyAudio(id) {
    const video = tileVideos.get(id);
    if (!video) return;
    video.volume = (tileVolume.get(id) ?? DEFAULT_VOLUME) / 100;
    video.muted = tileMuted.has(id);
  }

  /** The tile's persistent `<video>`, attached to its stream if it has arrived. */
  function getTileVideo(tile) {
    let video = tileVideos.get(tile.id);
    if (!video) {
      video = el("video", { className: "media-tile-video", attrs: { autoplay: "", playsinline: "", "aria-label": tile.ownerLabel } });
      tileVideos.set(tile.id, video);
      applyAudio(tile.id);
    }
    const stream = window.P2P.getStream(tile.roomId, tile.owner, tile.stream_id);
    if (video.srcObject !== stream) video.srcObject = stream;
    return video;
  }

  // Watched streams arrive/leave asynchronously after `toggle_watch`.
  window.P2P.onStream(({ roomId, owner, stream_id, stream }) => {
    const video = tileVideos.get(tileId(roomId, owner, stream_id));
    if (video) video.srcObject = stream;
  });
  window.P2P.onStreamRemoved(({ roomId, owner, stream_id }) => {
    const video = tileVideos.get(tileId(roomId, owner, stream_id));
    if (video) video.srcObject = null;
  });

  // Tile id -> that tile's fps / bitrate `<span>`, rebuilt on every `render()`.
  // `stream-stats-updated` fires about once a second, so `updateStats` patches
  // just these spans in place rather than re-rendering.
  let fpsSpans = new Map();
  let bitrateSpans = new Map();

  const formatBitrate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`);

  async function fetchWatchedStreams() {
    const { invoke } = window.__TAURI__.core;
    const rooms = await invoke("list_saved_rooms");
    const tiles = [];
    const notOnScreen = [];
    for (const room of rooms.filter((r) => r.state === "joined")) {
      const detail = await invoke("room_detail", { roomId: room.roomId });
      if (!detail) continue;
      const nameOf = (owner) => {
        const member = detail.members.find((m) => m.conn_id === owner);
        return member ? member.display_name : String(owner);
      };
      const watchedKeys = new Set(detail.watched.map((k) => `${k.owner}:${k.stream_id}`));
      for (const key of detail.watched) {
        const streamInfo = detail.streams.find((s) => s.owner === key.owner && s.stream_id === key.stream_id);
        // `watched` and `streams` can briefly disagree (the sharer just
        // stopped): never render a tile for a stream that's already gone.
        if (!streamInfo) continue;
        tiles.push({
          id: tileId(room.roomId, key.owner, key.stream_id),
          roomId: room.roomId,
          owner: key.owner,
          stream_id: key.stream_id,
          ownerLabel: nameOf(key.owner),
          roomLabel: room.name,
          resolution: `${streamInfo.width}x${streamInfo.height}`,
          hasAudio: !!streamInfo.audio,
        });
      }
      // "NOT ON SCREEN": announced video streams the user isn't watching.
      // (`room_detail.streams` never includes the user's own streams.)
      for (const s of detail.streams) {
        if (s.kind !== "Video" || watchedKeys.has(`${s.owner}:${s.stream_id}`)) continue;
        notOnScreen.push({
          roomId: room.roomId,
          owner: s.owner,
          stream_id: s.stream_id,
          ownerLabel: nameOf(s.owner),
          roomLabel: room.name,
          resolution: `${s.width}x${s.height}`,
          hasAudio: !!s.audio,
        });
      }
    }
    notOnScreenStreams = notOnScreen;
    return tiles;
  }

  /** "Play" on a "NOT ON SCREEN" card: request the stream via `toggle_watch`
   * (same command as the sidebar's Watch button), then refetch so the tile
   * appears (its video attaches when the stream arrives). */
  async function playNotOnScreen(item) {
    await window.__TAURI__.core.invoke("toggle_watch", { roomId: item.roomId, owner: item.owner, streamId: item.stream_id });
    await init();
  }

  /** "Stop watching" on a tile — `toggle_watch` is a genuine toggle, so the
   * same command that started the watch stops it. The stream reappears in the
   * "NOT ON SCREEN" rail on the refetch. */
  async function stopWatching(tile) {
    await window.__TAURI__.core.invoke("toggle_watch", { roomId: tile.roomId, owner: tile.owner, streamId: tile.stream_id });
    await init();
  }

  /** Opens `viewer.html` for this stream in its own window (see the header
   * note). The tile keeps its grid slot as a held placeholder meanwhile. */
  function popOutWatch(tile) {
    const q = new URLSearchParams({ key: tile.id, roomId: tile.roomId, owner: tile.owner, streamId: String(tile.stream_id) });
    if (tile.ownerLabel) q.set("ownerLabel", tile.ownerLabel);
    if (tile.roomLabel) q.set("roomLabel", tile.roomLabel);
    if (tile.hasAudio) q.set("hasAudio", "1");
    if (tile.resolution) q.set("resolution", tile.resolution);
    const win = window.open(`viewer.html?${q}`, `popout:${tile.id}`);
    if (!win) {
      console.warn("pop-out window was blocked");
      return;
    }
    popouts.set(tile.id, win);
    poppedOutIds.add(tile.id);
    render();
  }

  // The pop-out closing (x button, OS close, ...) releases its held slot.
  setInterval(() => {
    let released = false;
    for (const [id, win] of popouts) {
      if (!win.closed) continue;
      popouts.delete(id);
      if (poppedOutIds.delete(id)) released = true;
    }
    if (released) render();
  }, 500);

  function render() {
    const root = document.getElementById("view-root");
    if (!root) return;
    root.innerHTML = "";

    const liveIds = new Set(watchedTiles.map((t) => t.id));
    // Drop per-tile state for tiles that are gone for good, so a stream
    // watched again later doesn't inherit a stale mute or held slot.
    for (const id of tileMuted) if (!liveIds.has(id)) tileMuted.delete(id);
    for (const id of tileVolume.keys()) if (!liveIds.has(id)) tileVolume.delete(id);
    for (const id of poppedOutIds) if (!liveIds.has(id)) poppedOutIds.delete(id);
    for (const id of popouts.keys()) if (!poppedOutIds.has(id)) popouts.delete(id);
    // Room filter: fall back to "All rooms" if the selected room dropped
    // out of the watched set entirely (room left, or its last tile ended).
    const roomLabels = [...new Set(watchedTiles.map((t) => t.roomLabel))];
    if (roomFilter !== null && !roomLabels.includes(roomFilter)) roomFilter = null;

    const header = el("div", { className: "view-header" });
    const roomCount = roomLabels.length;
    // "On screen" excludes held-slot tiles (popped out to their own window).
    const onScreenCount = watchedTiles.filter((t) => !poppedOutIds.has(t.id)).length;
    header.appendChild(
      el("div", {
        className: "view-header-count",
        text: `${onScreenCount} on screen · ${roomCount} room${roomCount === 1 ? "" : "s"}`,
      })
    );
    if (roomLabels.length > 1) {
      const filter = el("div", { className: "view-room-filter" });
      filter.appendChild(
        el("button", {
          className: "view-room-filter-chip" + (roomFilter === null ? " active" : ""),
          text: "All rooms",
          onClick: () => {
            roomFilter = null;
            render();
          },
        })
      );
      roomLabels.forEach((label) => {
        filter.appendChild(
          el("button", {
            className: "view-room-filter-chip" + (roomFilter === label ? " active" : ""),
            text: label,
            onClick: () => {
              roomFilter = label;
              render();
            },
          })
        );
      });
      header.appendChild(filter);
    }
    root.appendChild(header);
    root.appendChild(el("div", { className: "view-controls" }));

    // Full rebuild: every stat span from the previous render is stale.
    fpsSpans = new Map();
    bitrateSpans = new Map();

    const shownTiles = roomFilter === null ? watchedTiles : watchedTiles.filter((t) => t.roomLabel === roomFilter);

    if (watchedTiles.length === 0) {
      root.appendChild(
        renderEmptyState("Pick someone from a room in the sidebar and click Watch.", null, null, {
          icon: "visibility",
          headline: "Nobody's on screen",
        })
      );
      renderNotOnScreenRail(root);
      currentGridEl = null;
      currentTileCount = 0;
      releaseUnusedVideos(shownTiles);
      return;
    }

    const grid = el("div", { className: "view-grid" });
    // The tile count includes held slots, so the grid doesn't reshuffle every
    // other tile just because one left for another window.
    shownTiles.forEach((tile) => grid.appendChild(renderTile(tile)));

    // Rail appended first (still ends up after the grid in the DOM, see
    // below) so `applyGridLayout` can read its real rendered height as part
    // of the grid's vertical budget.
    const railEl = renderNotOnScreenRail(root);
    if (railEl) root.insertBefore(grid, railEl);
    else root.appendChild(grid);

    currentGridEl = grid;
    currentTileCount = shownTiles.length;
    applyGridLayout();
    releaseUnusedVideos(shownTiles);
  }

  /** Detach and forget the `<video>` of every tile that isn't currently
   * rendered as video (removed, filtered out, or popped out). */
  function releaseUnusedVideos(shownTiles) {
    const inUse = new Set(shownTiles.filter((t) => !poppedOutIds.has(t.id)).map((t) => t.id));
    for (const [id, video] of tileVideos) {
      if (inUse.has(id)) continue;
      video.srcObject = null;
      tileVideos.delete(id);
    }
  }

  /** "NOT ON SCREEN" rail: a row of cards for streams the user can watch but
   * isn't (resolution and audio flag are announced by the sender up front;
   * bitrate only exists once a stream is actually being received). Renders
   * nothing when there's nothing to show. Returns the appended element (or
   * `null`) so `render()`'s grid-layout math can read its rendered height. */
  function renderNotOnScreenRail(root) {
    if (notOnScreenStreams.length === 0) return null;
    const rail = el("div", { className: "view-not-on-screen" });
    rail.appendChild(el("div", { className: "view-not-on-screen-label", text: "Not on screen" }));
    const cards = el("div", { className: "view-not-on-screen-cards" });
    notOnScreenStreams.forEach((item) => {
      const meta = el("div", { className: "view-not-on-screen-card-meta" });
      if (item.resolution) meta.appendChild(el("span", { className: "view-not-on-screen-card-value", text: item.resolution }));
      if (item.hasAudio) {
        const audioBadge = el("span", { className: "view-not-on-screen-card-audio", attrs: { title: "Sharing audio", "aria-label": "Sharing audio" } });
        audioBadge.appendChild(icon("volume_up"));
        meta.appendChild(audioBadge);
      }
      const info = el("div", { className: "view-not-on-screen-card-info" }, [
        el("span", { className: "view-not-on-screen-card-name", text: item.ownerLabel }),
        el("span", { className: "view-not-on-screen-card-room", text: item.roomLabel }),
        meta,
      ]);
      const playBtn = el(
        "button",
        {
          className: "view-not-on-screen-card-play",
          attrs: { title: `Watch ${item.ownerLabel}`, "aria-label": `Watch ${item.ownerLabel}` },
          onClick: () => playNotOnScreen(item),
        },
        [icon("play_arrow")]
      );
      cards.appendChild(el("div", { className: "view-not-on-screen-card" }, [info, playBtn]));
    });
    rail.appendChild(cards);
    root.appendChild(rail);
    return rail;
  }

  /** Held-slot placeholder for a tile popped out to its own window: no
   * video, just the dashed "bring it back" affordance plus a live stat bar
   * (the stream keeps being received, so bitrate and fps stay live). */
  function renderHeldSlot(tile, reasonText) {
    const wrap = el("div", { className: "media-tile media-tile-held" });

    const statbar = el("div", { className: "media-tile-statbar" });
    statbar.appendChild(el("span", { className: "media-tile-statbar-dot" }));
    statbar.appendChild(el("span", { className: "media-tile-statbar-name", text: `${tile.ownerLabel} · ${tile.roomLabel}` }));
    if (tile.resolution) {
      statbar.appendChild(el("span", { className: "media-tile-statbar-sep", text: "·" }));
      statbar.appendChild(el("span", { className: "media-tile-statbar-value", text: tile.resolution }));
    }
    appendStatSpans(statbar, tile);
    if (tile.hasAudio) statbar.appendChild(audioBadge());
    wrap.appendChild(statbar);

    wrap.appendChild(icon("picture_in_picture_alt"));
    wrap.appendChild(el("div", { className: "media-tile-held-text", text: `${tile.ownerLabel} is ${reasonText}` }));
    wrap.appendChild(
      secondaryButton(
        "Bring it back",
        () => {
          const win = popouts.get(tile.id);
          popouts.delete(tile.id);
          poppedOutIds.delete(tile.id);
          if (win && !win.closed) win.close();
          render();
        },
        { className: "media-tile-held-btn" }
      )
    );
    return wrap;
  }

  function audioBadge() {
    const badge = el("span", { className: "media-tile-statbar-audio-badge", attrs: { title: "Sharing audio", "aria-label": "Sharing audio" } });
    badge.appendChild(icon("volume_up"));
    return badge;
  }

  /** Appends the fps and bitrate readouts to a stat bar and registers them
   * with `updateStats`. */
  function appendStatSpans(statbar, tile) {
    const fpsSpan = el("span", { className: "media-tile-statbar-value media-tile-fps", text: "" });
    const bitrateSpan = el("span", { className: "media-tile-statbar-value media-tile-bitrate", text: "" });
    statbar.appendChild(fpsSpan);
    statbar.appendChild(bitrateSpan);
    fpsSpans.set(tile.id, fpsSpan);
    bitrateSpans.set(tile.id, bitrateSpan);
  }

  function renderTile(tile) {
    // A tile popped out to its own window keeps its grid slot as a placeholder.
    if (poppedOutIds.has(tile.id)) return renderHeldSlot(tile, "in a separate window");

    const wrap = el("div", { className: "media-tile" });

    // Double-click to fullscreen this tile in the current window (distinct
    // from `popOutWatch`, which opens a separate OS window); a second
    // double-click or Escape exits. `requestFullscreen()` can reject, so it's
    // caught rather than surfacing as an unhandled rejection.
    wrap.addEventListener("dblclick", () => {
      if (document.fullscreenElement === wrap) {
        document.exitFullscreen().catch(() => {});
      } else if (wrap.requestFullscreen) {
        wrap.requestFullscreen().catch(() => {});
      }
    });

    const video = getTileVideo(tile);
    const connecting = el("div", { className: "media-tile-placeholder" }, [el("span", { text: "Connecting…" })]);
    connecting.hidden = video.readyState >= 2;
    video.onplaying = () => {
      connecting.hidden = true;
    };
    video.onemptied = () => {
      connecting.hidden = false;
    };
    wrap.appendChild(video);
    wrap.appendChild(connecting);

    // Always-visible stat bar: name, resolution, live fps/bitrate, audio badge.
    const statbar = el("div", { className: "media-tile-statbar" });
    statbar.appendChild(el("span", { className: "media-tile-statbar-dot" }));
    statbar.appendChild(el("span", { className: "media-tile-statbar-name", text: `${tile.ownerLabel} · ${tile.roomLabel}` }));
    if (tile.resolution) {
      statbar.appendChild(el("span", { className: "media-tile-statbar-sep", text: "·" }));
      statbar.appendChild(el("span", { className: "media-tile-statbar-value", text: tile.resolution }));
    }
    appendStatSpans(statbar, tile);
    if (tile.hasAudio) statbar.appendChild(audioBadge());
    wrap.appendChild(statbar);

    // Hover overlay: pop-out / stop-watching (top-right), audio (bottom-left).
    // The vignette is a separate sibling so it can sit below the stat bar in
    // z-order while the overlay's buttons stay above it (see view.css).
    const vignette = el("div", { className: "media-tile-vignette" });
    const overlay = el("div", { className: "media-tile-overlay" });

    const top = el("div", { className: "media-tile-overlay-top" });
    const actions = el("div", { className: "media-tile-overlay-actions" });
    actions.appendChild(
      el(
        "button",
        {
          className: "media-tile-popout-btn",
          attrs: { title: "Pop out", "aria-label": "Pop out" },
          onClick: () => popOutWatch(tile),
        },
        [icon("open_in_new")]
      )
    );
    // Destructive action rightmost, same convention as shell.js's leave-room.
    actions.appendChild(
      el(
        "button",
        {
          className: "media-tile-popout-btn media-tile-stop-btn",
          attrs: { title: "Stop watching", "aria-label": `Stop watching ${tile.ownerLabel}` },
          onClick: () => stopWatching(tile),
        },
        [icon("close")]
      )
    );
    top.appendChild(actions);
    overlay.appendChild(top);

    const bottom = el("div", { className: "media-tile-overlay-bottom" });

    // Audio control, only when the sender shares audio: a mute button and a
    // volume slider driving the tile's `<video>`. The mute button swaps the
    // pill in place (`replaceChild`) instead of calling `render()`, so
    // toggling mute doesn't rebuild the whole grid. The slider exists only
    // while unmuted (absent from the DOM, not CSS-collapsed) — see view.css's
    // `.media-tile-audio` comment.
    if (tile.hasAudio) {
      const buildAudioGroup = (muted) => {
        const group = el("div", { className: "media-tile-audio" + (muted ? " media-tile-audio-muted" : "") });
        const muteBtn = el(
          "button",
          {
            className: "media-tile-audio-btn",
            attrs: { title: muted ? "Unmute" : "Mute", "aria-label": muted ? `Unmute ${tile.ownerLabel}` : `Mute ${tile.ownerLabel}` },
            onClick: (e) => {
              e.stopPropagation();
              const nowMuted = !tileMuted.has(tile.id);
              if (nowMuted) tileMuted.add(tile.id);
              else tileMuted.delete(tile.id);
              applyAudio(tile.id);
              const next = buildAudioGroup(nowMuted);
              bottom.replaceChild(next, audioGroup);
              audioGroup = next;
            },
          },
          [icon(muted ? "volume_off" : "volume_up")]
        );
        group.appendChild(muteBtn);
        if (!muted) {
          const slider = el("input", {
            className: "media-tile-audio-slider",
            attrs: { type: "range", min: "0", max: "100", step: "5", "aria-label": `Volume for ${tile.ownerLabel}` },
          });
          slider.value = String(tileVolume.get(tile.id) ?? DEFAULT_VOLUME);
          slider.addEventListener("click", (e) => e.stopPropagation());
          slider.addEventListener("input", () => {
            tileVolume.set(tile.id, Number(slider.value));
            applyAudio(tile.id);
          });
          group.appendChild(slider);
        }
        return group;
      };
      let audioGroup = buildAudioGroup(tileMuted.has(tile.id));
      bottom.appendChild(audioGroup);
    }

    overlay.appendChild(bottom);

    wrap.appendChild(vignette);
    wrap.appendChild(overlay);

    return wrap;
  }

  async function init() {
    const tiles = await fetchWatchedStreams();
    const signature = JSON.stringify([
      tiles.map((t) => [t.id, t.ownerLabel, t.roomLabel, t.resolution, t.hasAudio]),
      notOnScreenStreams.map((s) => [s.roomId, s.owner, s.stream_id, s.ownerLabel, s.roomLabel, s.resolution, s.hasAudio]),
    ]);
    watchedTiles = tiles;
    if (signature === lastSignature) return;
    lastSignature = signature;
    render();
  }

  /** Fed by `shell.js`'s `stream-stats-updated` listener (about once a
   * second). Only `payload.watched` is this tab's concern. Patches each
   * matching tile's fps / bitrate span in place — no re-render, no flicker. */
  function updateStats(payload) {
    if (!payload || !Array.isArray(payload.watched)) return;
    for (const w of payload.watched) {
      const id = tileId(w.roomId, w.owner, w.stream_id);
      const bitrateSpan = bitrateSpans.get(id);
      if (bitrateSpan) bitrateSpan.textContent = formatBitrate(w.bitrate_kbps);
      const fpsSpan = fpsSpans.get(id);
      if (fpsSpan) fpsSpan.textContent = `${Math.round(w.fps)}fps`;
    }
  }

  /** Set by `shell.js`'s ROOMS-row left-click handler (joined room, multiple
   * rooms connected): jumps the View tab to a single room's tiles instead of
   * "all rooms". `roomLabel` matches a tile's `roomLabel` (the saved room's
   * name); pass `null` to clear back to "All rooms". `render()` already falls
   * back to null for a label with no tiles. */
  function setRoomFilter(roomLabel) {
    roomFilter = roomLabel;
    render();
  }

  window.ViewTab = {
    refresh: init,
    updateStats,
    setRoomFilter,
    // Shared with the pop-out window (`viewer.js`), which has no state of its own.
    getAudio: (id) => ({ volume: tileVolume.get(id) ?? DEFAULT_VOLUME, muted: tileMuted.has(id) }),
    setAudio: (id, volume, muted) => {
      tileVolume.set(id, volume);
      if (muted) tileMuted.add(id);
      else tileMuted.delete(id);
      applyAudio(id);
    },
  };

  document.addEventListener("DOMContentLoaded", init);
})();
