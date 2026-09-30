// components.js — shared UI primitives for the frontend shell.
//
// These are the vanilla-JS equivalent of `theme.rs`'s widget-helper family
// (`primary_button`, `secondary_button`, `danger_button`, `icon_button`,
// `nav_button`, `status_dot`, `card`, ...): small factory functions that
// return a DOM element, styled from `tokens.css` custom properties only
// (never a hard-coded color/size inline), so later workers building the
// Stream Control / View / Settings tab content can reuse them instead of
// hand-rolling their own button/card/dot markup.
//
// Every function here is pure with respect to the DOM: it builds and
// returns an element, wiring only the event listeners it's explicitly given
// (an `onClick` callback, etc.) — none of them mutate global state or reach
// into `shell.js`'s mock data directly. That keeps them reusable from any
// tab's own script without a circular dependency on shell.js.
//
// Exposed on `window.Components` (no bundler / module system in this repo,
// per the frontend's "plain static HTML/CSS/JS" scope) so any script that
// loads after this one can call e.g. `Components.renderRoomRow(...)`.

(function () {
  "use strict";

  /** Small helper: create an element, assign props/attrs, append children. */
  function el(tag, opts, children) {
    const node = document.createElement(tag);
    opts = opts || {};
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.html !== undefined) node.innerHTML = opts.html;
    if (opts.attrs) {
      for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
    }
    if (opts.onClick) node.addEventListener("click", opts.onClick);
    (children || []).forEach((c) => c && node.appendChild(c));
    return node;
  }

  /**
   * Wire a `wheel`-scroll listener onto a `<input type="range">` so hovering
   * it and scrolling steps the value up/down by exactly the slider's own
   * `step` (matching the granularity a manual drag/arrow-key already uses),
   * instead of doing nothing (native range inputs ignore wheel scroll in
   * Chromium/Electron) or letting the page/container scroll underneath it.
   *
   * `Why: scroll-up = increase` — matches the typical OS volume/spinner
   * convention (macOS/Windows volume sliders, most native spinbuttons):
   * scrolling "up" (negative `deltaY`) raises the value, "down" lowers it.
   *
   * Dispatches both `input` (for any live-preview readout wired on
   * `input`) and `change` (for whatever handler actually applies/persists
   * the value) so a wheel tick behaves like a real drag-then-release, not
   * just one half of it.
   */
  function attachWheelStep(sliderEl) {
    sliderEl.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const stepAttr = sliderEl.step;
        const step = stepAttr && stepAttr !== "any" && Number(stepAttr) ? Number(stepAttr) : 1;
        const min = sliderEl.min !== "" ? Number(sliderEl.min) : -Infinity;
        const max = sliderEl.max !== "" ? Number(sliderEl.max) : Infinity;
        const delta = event.deltaY < 0 ? step : -step;
        const next = Math.min(max, Math.max(min, Number(sliderEl.value) + delta));
        sliderEl.value = String(next);
        sliderEl.dispatchEvent(new Event("input", { bubbles: true }));
        sliderEl.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { passive: false }
    );
  }

  /** A single Material Symbols glyph, e.g. icon("expand_more"). */
  function icon(name, extraClass) {
    return el("span", {
      className: "material-symbols-outlined" + (extraClass ? " " + extraClass : ""),
      text: name,
    });
  }

  // -------------------------------------------------------------------
  // Buttons — mirrors theme.rs's four button variants.
  // -------------------------------------------------------------------

  /** Solid accent fill — the one primary action on a screen. */
  function primaryButton(label, onClick, opts) {
    opts = opts || {};
    return el("button", {
      className: "btn btn-primary" + (opts.className ? " " + opts.className : ""),
      text: label,
      onClick,
      attrs: opts.disabled ? { disabled: "disabled" } : {},
    });
  }

  /** Neutral fill + border — the default for everything else. */
  function secondaryButton(label, onClick, opts) {
    opts = opts || {};
    return el("button", {
      className: "btn btn-secondary" + (opts.className ? " " + opts.className : ""),
      text: label,
      onClick,
      attrs: opts.disabled ? { disabled: "disabled" } : {},
    });
  }

  /** Transparent fill, danger-colored text/border — destructive actions. */
  function dangerButton(label, onClick, opts) {
    opts = opts || {};
    return el("button", {
      className: "btn btn-danger" + (opts.className ? " " + opts.className : ""),
      text: label,
      onClick,
      attrs: opts.disabled ? { disabled: "disabled" } : {},
    });
  }

  /** Compact, chrome-free icon-only button for dense list rows. */
  function iconButton(glyph, onClick, opts) {
    opts = opts || {};
    const btn = el("button", {
      className: "btn btn-icon" + (opts.className ? " " + opts.className : ""),
      onClick,
      attrs: opts.title ? { title: opts.title, "aria-label": opts.title } : {},
    });
    btn.appendChild(icon(glyph));
    return btn;
  }

  /**
   * A chunky, full-width nav-rail pill — mirrors `theme::nav_button`.
   * Accent-filled + dark text when active, transparent (hover-only lift)
   * otherwise.
   */
  function renderNavButton(label, active, onClick) {
    return el("button", {
      className: "nav-btn" + (active ? " nav-btn-active" : ""),
      text: label,
      onClick,
      attrs: { "data-tab": label },
    });
  }

  // -------------------------------------------------------------------
  // Status dot — mirrors `theme::status_dot`.
  // -------------------------------------------------------------------

  /**
   * Three states, matching APP-SHELL.md's room-row table:
   *  - "joined"       -> solid filled SUCCESS dot
   *  - "reconnecting" -> pulsing WARNING dot (CSS animation)
   *  - "disconnected" -> hollow TEXT_FAINT ring
   */
  function statusDot(state) {
    return el("span", { className: "status-dot status-dot-" + state });
  }

  // -------------------------------------------------------------------
  // Status vocabulary — four families (progress/live/degraded/failed),
  // matching `capture::DestinationState`'s real variants (see
  // `src/capture.rs`: `Starting`/`Live`/`Rebuilding`/`Stalled`/`Failed`).
  // Visual rules live in `status.css`'s `.status-badge*`/`.status-failed-*`
  // classes; this is just the DOM-building side, one function callers reach
  // for instead of hand-rolling a pill per file.
  //
  // `degraded` is the one family with a live-updating part: it always shows
  // an elapsed-seconds count next to the label (e.g. "WAITING FOR CAPTURE ·
  // 4s"). No DTO carries a "since" timestamp for `Stalled` today (out of
  // this pass's frontend-only scope to add one) — callers that want the
  // counter to be accurate pass `options.since` (a client-side `Date.now()`
  // recorded the first time they observed this state, e.g.
  // `stream-control.js`'s `destStalledSince` map). The badge owns its own
  // `setInterval` (mirrors `tile-video.js`'s fps-interval pattern) and
  // stops itself once its node leaves the DOM — checked on each tick via
  // `isConnected` rather than requiring every caller to remember to call a
  // `.destroy()`, since this codebase's render paths don't have a uniform
  // unmount hook to call one from.
  // -------------------------------------------------------------------

  /**
   * @param {'progress'|'live'|'degraded'|'failed'} family
   * @param {string} label - short, stable, e.g. "STARTING" / "LIVE" /
   *   "WAITING FOR CAPTURE" / "Share failed". Failed's `label` is a full
   *   plain-language headline, not a state keyword.
   * @param {object} [options] - degraded: { since: number (ms epoch) }.
   *   failed: { errorText, onRetry, onDismiss }.
   */
  function statusBadge(family, label, options) {
    options = options || {};

    if (family === "failed") {
      const box = el("div", { className: "status-failed-box" });
      const head = el("div", { className: "status-failed-head" });
      head.appendChild(icon("error", "status-failed-icon"));
      head.appendChild(el("span", { className: "status-failed-headline", text: label }));
      box.appendChild(head);
      box.appendChild(
        el("div", {
          className: "status-failed-sub",
          text: options.errorText || "No further error detail is available for this destination.",
        })
      );
      const actions = el("div", { className: "status-failed-actions" });
      actions.appendChild(secondaryButton("Dismiss", () => options.onDismiss && options.onDismiss(), { className: "status-failed-dismiss" }));
      actions.appendChild(primaryButton("Retry", () => options.onRetry && options.onRetry(), { className: "status-failed-retry" }));
      box.appendChild(actions);
      return box;
    }

    const badge = el("span", { className: "status-badge status-badge-" + family });
    if (family === "progress") {
      badge.appendChild(el("span", { className: "status-badge-bar" }));
    } else if (family === "live") {
      badge.appendChild(el("span", { className: "status-badge-dot" }));
    } else if (family === "degraded") {
      badge.appendChild(icon("warning", "status-badge-icon"));
    }
    const text = el("span", { className: "status-badge-label", text: label });
    badge.appendChild(text);

    if (family === "degraded" && options.since) {
      let intervalId = null;
      const tick = () => {
        if (!badge.isConnected) {
          clearInterval(intervalId);
          return;
        }
        const elapsedS = Math.max(0, Math.round((Date.now() - options.since) / 1000));
        text.textContent = `${label} · ${elapsedS}s`;
      };
      tick();
      intervalId = setInterval(tick, 1000);
    }

    return badge;
  }

  /** Shared hatch fill with `.status-badge-degraded` (same CSS rule, see
   * status.css) — used by the leave-room confirm dialog's warning banners.
   * Not one of the 4 status families itself (it's a page-level warning
   * banner, not a state pill), just visually related enough to reuse the
   * same amber-hatch treatment rather than inventing a second one. */
  function hatchedBanner(text) {
    return el("div", { className: "hatched-banner" }, [icon("warning", "hatched-banner-icon"), el("span", { className: "hatched-banner-text", text })]);
  }

  /** Lighter, no-badge empty-row for in-context "this list is empty" rows
   * (a room's member list, ...) — icon + text only, no big gradient badge.
   * See `renderEmptyState` below for the whole-panel version. */
  function emptyRow(glyph, text) {
    return el("div", { className: "empty-row" }, [icon(glyph, "empty-row-icon"), el("span", { text })]);
  }

  // -------------------------------------------------------------------
  // Room row — the sidebar ROOMS section's per-room row + expanded member
  // list, per APP-SHELL.md's three-state table.
  // -------------------------------------------------------------------

  /**
   * @param {object} room - a saved-room row { roomId, code, name, state:
   *   'joined'|'disconnected'|'reconnecting', active_stream_count },
   *   plus two frontend-only arrays populated together via `room_detail` (no
   *   single DTO inlines any of this — see `loadRoomMembers`, shell.js):
   *   `members`: [{conn_id, display_name, owner, stream_id, resolution,
   *   watching}], and `streams`: every announced stream in the room
   *   ([{owner, stream_id, kind, ...}]) — used here only to test "does this
   *   member's `conn_id` own an entry" for the `[LIVE]` badge. Plus an
   *   optional frontend-only `unreachable`: [{peerId, peerName}] — peers this
   *   client could not connect to directly (`peer_unreachable` event), rendered
   *   as a "needs a TURN relay" note under the row.
   * @param {object} handlers - { onOpenRoom, onReconnect, onLeave, onJoinedRowClick,
   *   onUnreachableClick }
   *
   * Per the sidebar-redesign handoff (option 1c): every state renders through
   * ONE fixed row skeleton — `[dot][caret][name][meta, right-
   * aligned][action]` — rather than each state inventing its own layout. Only
   * the *content* of the caret/meta/action slots changes per state; the slots
   * themselves are always present (even empty, as a spacer) so columns stay
   * aligned down the whole ROOMS list regardless of which states are mixed
   * in. This replaces the previous two-line "disconnected" layout (Reconnect
   * pill + forget button on a sub-line) — that variance existed only because
   * the old design put a *labeled* Reconnect button next to a
   * possibly-long auto-generated name; the redesign folded that into the
   * row-wide click (see the 2026-07-29 note below).
   *
   * `Why:` (room-detail-slide-over pass, option 1f) a joined row no longer
   * expands inline on click to show its member list — right-clicking a
   * row's head (or left-clicking its caret specifically) calls
   * `handlers.onOpenRoom` to open the room-detail slide-over panel instead
   * (see shell.js's `openRoomPanel`/`renderRoomPanel`), which owns rename,
   * share code and leave actions. The row's own leave/forget icon-button in
   * the action slot stays as a fast path that does NOT open the panel first
   * (its own click handler stops propagation) — a user who already knows
   * they want to leave shouldn't be forced through the panel to do it.
   *
   * `Why:` (2026-07-29, full click-semantics overhaul, owner request) plain
   * left-click no longer opens the settings panel at all — it's now
   * state-dependent and always the most likely "I want to use this room"
   * action: disconnected → reconnect (`onReconnect`, same path the old
   * caret-only reconnect button used — that button is gone now, folded into
   * the row-wide click since a second, narrower hit-area doing the exact
   * same thing was redundant once the whole row did it); joined →
   * `onJoinedRowClick`, which shell.js wires to jump to the View tab,
   * filtered to this room's streams unless it's the only room currently
   * joined (see shell.js's `jumpToViewForRoom`). Settings moved to
   * right-click (`contextmenu`, `preventDefault`ed so the native menu never
   * shows) for every state, and middle-click (`auxclick`, button 1) now
   * disconnects a joined room via the same confirm-gated `onLeave` path the
   * panel's own Disconnect button uses — no bypass of that confirm dialog,
   * since middle-click is an easy accidental trigger (scroll-wheel click)
   * that arguably deserves *more* guardrail, not less. A `title` on the row
   * spells out the three bindings for discoverability.
   *
   * `Why:` (2026-07-28, room-row redesign) the row click now opens the
   * panel for EVERY state, not just `joined` — a disconnected/reconnecting
   * row used to be a dead click outside its caret/action icons, which read
   * as broken next to the joined rows' full-row affordance. `openRoomPanel`
   * (shell.js) degrades its content per state (no live roster to show
   * without a live connection) rather than refusing to open. The
   * disconnected row's reconnect action stays a fast path independent of
   * the panel: its caret slot (see below) still stops propagation so
   * clicking it reconnects without first opening/closing the panel.
   *
   * `Why:` (2026-07-28, member/LIVE tree pass) the row's meta slot used to
   * show a `"{count} active"` summary; it's now always shown below the row
   * itself, one line per current member, each carrying a `[LIVE]` pill if
   * that member owns a stream in `room.streams` — the same per-stream
   * roster `renderRoomPanelStreamRow` (shell.js) already reads for the
   * panel's "Live streams" section, reused here rather than re-derived. See
   * `superdoc/features/stream-control.md`'s 2026-07-28 note for the
   * eager-roster-fetch tradeoff this required in `shell.js`'s
   * `refreshRooms`.
   */
  function renderRoomRow(room, handlers) {
    handlers = handlers || {};
    const row = el("div", { className: "room-row room-row-" + room.state });

    const head = el("div", { className: "room-row-head room-row-head-clickable" });

    // Row-wide click semantics (2026-07-29 overhaul — replaces the earlier
    // "every click opens the panel" behavior): left-click is state-dependent
    // (connect if disconnected, jump-to-View-and-filter if joined),
    // right-click always opens settings, middle-click disconnects a joined
    // room. See `title` below for the on-hover summary, and this project's
    // APP-SHELL.md ROOMS section for the full rationale.
    head.addEventListener("click", () => {
      if (room.state === "disconnected") {
        handlers.onReconnect && handlers.onReconnect(room.roomId);
      } else if (room.state === "joined") {
        handlers.onJoinedRowClick && handlers.onJoinedRowClick(room);
      }
      // "reconnecting": nothing to do — mid-flight already.
    });

    // Right-click (any state) opens the settings/detail panel — the row's
    // old plain-left-click behavior, just moved off left-click since that's
    // now spoken for above. `preventDefault` suppresses the native OS/
    // browser context menu (there's no custom menu here — this *is* the
    // menu action).
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      handlers.onOpenRoom && handlers.onOpenRoom(room.roomId);
    });

    // Middle-click: disconnect a joined room via the same confirm-gated path
    // the panel's own "Disconnect"/✕ button uses (`onLeave` -> `shell.js`'s
    // `openLeaveConfirm`) — no bypass of the leave-confirm dialog; a
    // middle-click is an easy accidental trigger (scroll-wheel click), so if
    // anything it deserves *more* guardrail than a deliberate button click,
    // not less. No-op for disconnected/reconnecting rows (nothing to
    // disconnect). `auxclick` is the standard event for non-primary-button
    // clicks (middle-click never fires a plain `click`); `mousedown` +
    // `preventDefault` on the same button additionally suppresses X11's
    // middle-click autoscroll/paste-primary-selection gesture, which would
    // otherwise fire before `auxclick` does.
    head.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    head.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (room.state === "joined") {
        handlers.onLeave && handlers.onLeave(room.roomId);
      }
    });

    head.title = "Left-click: connect/view · Right-click: settings · Middle-click: disconnect";

    head.appendChild(statusDot(room.state));

    // Caret slot: open the room-detail panel (joined) or an empty spacer
    // (disconnected/reconnecting). The disconnected caret's old standalone
    // "reconnect" button/icon (`onReconnect`, `restart_alt` glyph) is gone —
    // the whole row now does that on left-click (see above), so a second,
    // narrower hit-area doing the exact same thing was redundant scaffolding
    // once the row-wide handler existed; keeping both would've meant two
    // code paths for one action with no behavioral difference between them.
    // Every remaining caret's own click still stops propagation so it
    // doesn't double-fire the head's row-wide click handler above.
    if (room.state === "joined") {
      head.appendChild(
        el("button", {
          className: "room-caret",
          onClick: (e) => {
            e.stopPropagation();
            handlers.onOpenRoom && handlers.onOpenRoom(room.roomId);
          },
          attrs: { "aria-label": "Room details", title: "Room details" },
        }, [icon("chevron_right")])
      );
    } else {
      head.appendChild(el("span", { className: "room-caret room-caret-spacer" }));
    }

    head.appendChild(el("span", { className: "room-name", text: room.name }));

    // Meta slot: fixed-width spacer that keeps the action icon's column
    // aligned across every row — never free-text state body (that would
    // fight the name for width on this narrow sidebar). Joined rooms used
    // to show a `"{count} active"` summary here; that's now the member/LIVE
    // tree appended below the row instead (see this function's doc
    // comment). Disconnected used to show a "not connected" string, and
    // both states used to fall back to a literal "—" placeholder — both
    // redundant with the row's own status dot and, per the design owner's
    // feedback, visual clutter — so this renders empty now, purely for
    // layout, not as a text placeholder.
    head.appendChild(el("span", { className: "room-meta" }));

    // Action slot: leave (joined), forget (disconnected), or empty (nothing
    // to act on mid-reconnect). Always present so the column stays aligned.
    // Both buttons stop propagation — this stays a fast path independent of
    // the panel, not an implicit "open panel then leave" detour.
    const actionSlot = el("span", { className: "room-action-slot" });
    if (room.state === "joined") {
      actionSlot.appendChild(
        iconButton(
          "close",
          (e) => {
            e.stopPropagation();
            handlers.onLeave && handlers.onLeave(room.roomId);
          },
          { title: "Leave room", className: "room-row-action-btn" }
        )
      );
    } else if (room.state === "disconnected") {
      actionSlot.appendChild(
        iconButton(
          "delete",
          (e) => {
            e.stopPropagation();
            handlers.onLeave && handlers.onLeave(room.roomId);
          },
          { title: "Forget room", className: "room-row-action-btn" }
        )
      );
    }
    head.appendChild(actionSlot);

    row.appendChild(head);

    // Member/LIVE tree — one indented row per current member of a joined
    // room, LIVE-badged if that member owns a stream in `room.streams`
    // (populated by `loadRoomMembers`, same source `renderRoomPanelStreamRow`
    // reads for the panel's "Live streams" section — reused here, not
    // re-derived). Disconnected/reconnecting rooms never have a live roster
    // to show (`room.members` is only populated for joined rooms).
    if (room.state === "joined" && (room.members || []).length > 0) {
      const liveOwners = new Set((room.streams || []).map((s) => s.owner));
      const tree = el("div", { className: "room-member-tree" });
      room.members.forEach((m) => {
        const memberRow = el("div", { className: "room-member-tree-row" });
        memberRow.appendChild(el("span", { className: "room-member-tree-name", text: m.self ? "You" : m.display_name }));
        if (liveOwners.has(m.conn_id)) {
          memberRow.appendChild(
            el("span", { className: "room-member-live-badge" }, [
              el("span", { className: "room-member-live-dot" }),
              el("span", { text: "LIVE" }),
            ])
          );
        }
        tree.appendChild(memberRow);
      });
      row.appendChild(tree);
    }

    const unreachable = renderUnreachableNote(room.unreachable, handlers.onUnreachableClick);
    if (unreachable) row.appendChild(unreachable);

    return row;
  }

  /** Message shown for a peer that can't be reached with a direct connection. */
  const UNREACHABLE_TEXT = "Direct connection blocked — this network needs a TURN relay (Settings → TURN)";

  /** The "peer can't be reached" note: one line per blocked peer (name in
   * bold) under the shared warning text. Returns null when `peers` is empty,
   * so callers can just `if (note) parent.appendChild(note)`. Clicking it
   * calls `onClick` (shell.js wires that to the Settings tab). */
  function renderUnreachableNote(peers, onClick) {
    if (!peers || peers.length === 0) return null;
    const note = el("div", {
      className: "room-unreachable",
      attrs: { role: "button", tabindex: "0", title: "Open Settings" },
    });
    note.appendChild(icon("wifi_off", "room-unreachable-icon"));
    const text = el("div", { className: "room-unreachable-text" });
    text.appendChild(el("span", { className: "room-unreachable-peers", text: peers.map((p) => p.peerName || p.peerId).join(", ") }));
    text.appendChild(el("span", { className: "room-unreachable-msg", text: UNREACHABLE_TEXT }));
    note.appendChild(text);
    if (onClick) {
      note.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      note.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      });
    }
    return note;
  }

  // -------------------------------------------------------------------
  // Stream row — the sidebar STREAMS section's per-destination row.
  // -------------------------------------------------------------------

  /** Maps `capture::DestinationState`'s variants to the sidebar OUTGOING
   * row's dot color + short meta label — same 4-family status vocabulary as
   * `statusBadge`/`destinationCard` (status.css), just a plain dot instead of
   * a pill (this row is dense enough that a full badge would crowd the
   * bitrate/room-label columns). */
  const OUTGOING_STATE_META = {
    starting: { label: "STARTING", dotClass: "status-dot-progress" },
    rebuilding: { label: "APPLYING", dotClass: "status-dot-progress" },
    live: { label: null, dotClass: "status-dot-live" },
    stalled: { label: "STALLED", dotClass: "status-dot-degraded" },
    failed: { label: "FAILED", dotClass: "status-dot-failed" },
  };

  /**
   * One row per active OUTGOING destination (the sidebar's cross-room
   * "STREAMS"/"OUTGOING" section — see APP-SHELL.md's STREAMS section doc).
   * Follows the same fixed row skeleton as `renderRoomRow`:
   * `[dot][room/destination label][meta, right-aligned]`, plus a "Stop"
   * button that's an absolutely-positioned hover/focus-reveal overlay (not
   * a normal flex child) — it reserves no width at rest, so the label/meta
   * get the row's full space until hover, matching view.css's
   * `.media-tile-overlay` hover-reveal pattern.
   *
   * A destination that is sharing audio gets a `volume_up` glyph at the end
   * of its row (`stream.audio`).
   *
   * @param {object} stream - a destination row { destination_id, state:
   *   'starting'|'live'|'rebuilding'|'stalled'|'failed', width, height,
   *   framerate, bitrate_kbps, audio: bool }, plus a frontend-only `room_label`
   *   (looked up from the room's name by `roomId`).
   * @param {object} [handlers] - { onStop(destinationId) } — calls the same
   *   `stop_destination` command `stream-control.js`'s own Stop button uses.
   */
  function renderStreamRow(stream, handlers) {
    handlers = handlers || {};
    const meta = OUTGOING_STATE_META[stream.state] || { label: null, dotClass: "status-dot-live" };

    const row = el("div", { className: "stream-row" });
    row.appendChild(el("span", { className: "status-dot " + meta.dotClass }));
    row.appendChild(el("span", { className: "stream-label", text: stream.room_label }));
    const metaText = meta.label || `${stream.width}×${stream.height} @ ${stream.framerate}fps`;
    row.appendChild(el("span", { className: "stream-meta", text: metaText }));
    if (stream.audio) row.appendChild(icon("volume_up", "stream-audio-glyph"));
    const stopBtn = dangerButton("Stop", () => handlers.onStop && handlers.onStop(stream.destination_id), {
      className: "stream-stop-overlay-btn",
    });
    stopBtn.prepend(icon("stop_circle"));
    stopBtn.title = "Stop";
    stopBtn.setAttribute("aria-label", "Stop");
    row.appendChild(stopBtn);
    return row;
  }

  /**
   * Standardized whole-panel empty state: icon-in-a-badge + one bold
   * headline + one sentence of body copy + one primary action. Used across
   * every "there's nothing here" panel (no rooms yet, nobody sharing in a
   * room, nobody on screen, no active shares) so they all read as the same
   * visual language rather than each screen inventing its own.
   *
   * Backward-compatible with every existing 2/3-arg call site: without
   * `opts.headline`, `message` itself becomes the (only) headline line, no
   * separate body line — the simplest correct case for a caller that just
   * has one short sentence to say.
   *
   * @param {string} message - body copy (or the headline, if `opts.headline`
   *   is absent).
   * @param {string|null} actionLabel
   * @param {(() => void)|null} onAction
   * @param {object} [opts] - { icon: glyph name, headline: string,
   *   inline: Element (e.g. an inline join-room form), className }
   */
  function renderEmptyState(message, actionLabel, onAction, opts) {
    opts = opts || {};
    const wrap = el("div", { className: "empty-state" + (opts.className ? " " + opts.className : "") });
    wrap.appendChild(el("div", { className: "empty-state-badge" }, [icon(opts.icon || "info", "empty-state-badge-icon")]));
    wrap.appendChild(el("p", { className: "empty-state-headline", text: opts.headline || message }));
    if (opts.headline) {
      wrap.appendChild(el("p", { className: "empty-state-body", text: message }));
    }
    if (opts.inline) wrap.appendChild(opts.inline);
    if (actionLabel) {
      wrap.appendChild(primaryButton(actionLabel, onAction, { className: "empty-state-action" }));
    }
    return wrap;
  }

  // -------------------------------------------------------------------
  // Card — a generic, equal-width section container. Added for the Stream
  // Control / View / Settings tab content: `.tab-placeholder-card` (shell.css)
  // was a one-off for the nav-switcher proof and capped itself at
  // `--panel-max-width`, which is exactly the "content-sized card" shape the
  // Stream Control redesign is fixing. `.card` has no width opinion of its
  // own — the caller's grid/flex container decides equal-width sizing (see
  // `stream-control.css`'s `.sc-grid`), so a card never reverts to shrinking
  // to fit its content.
  // -------------------------------------------------------------------

  /**
   * @param {string|null} label - section-label heading text, or null/'' for no heading.
   * @param {Element[]} children
   * @param {object} [opts] - { className }
   */
  function card(label, children, opts) {
    opts = opts || {};
    const c = el("div", { className: "card" + (opts.className ? " " + opts.className : "") });
    if (label) c.appendChild(el("div", { className: "section-label card-label", text: label }));
    (children || []).forEach((ch) => ch && c.appendChild(ch));
    return c;
  }

  // -------------------------------------------------------------------
  // Dropdown — the custom-styled replacement for native `<select>`. A
  // native select's open popup is platform/OS chrome CSS cannot reach
  // (stark white, generic font, no dark theme, no "roll out" animation, and
  // it looks different per OS/Chromium build) — this rebuilds the same
  // trigger+popup shape entirely out of ordinary elements so it can be
  // themed like every other control and animate open/closed. See
  // superdoc/ui/STYLING-GUIDE.md (2026-07-28) for the full rationale.
  // -------------------------------------------------------------------

  /**
   * @param {{value: *, label: string}[]} options - `value` may be any type;
   *   matching against the current value (and the value handed back to
   *   `onChange`) is done via `String(value)` equality so callers can use
   *   numbers, strings, whatever their option's `value` already was — same
   *   as a native `<select>`, callers that need a number back should
   *   `Number(...)` it in `onChange`, same as they did with `select.value`.
   * @param {*} value - the currently-selected option's `value`
   * @param {(value: *) => void} onChange - fired only on a real user pick,
   *   never for a programmatic `.value = ...` set (matches native `<select>`,
   *   which doesn't fire `change` for scripted assignment either).
   * @param {object} [opts] - { className: string (applied to the trigger
   *   button, so existing sizing classes like `.dest-room-select` keep
   *   their `max-width`/padding/etc.), placeholder: string, emptyText:
   *   string (shown, disabled-looking, when `options` is empty),
   *   onOpen: () => void, onClose: () => void (fired when the option list
   *   opens/closes) }
   * @returns {HTMLElement} a `<div class="dd">` wrapper. Beyond being a
   *   normal appendable/removable DOM node, it also exposes: a `.value`
   *   getter/setter (get/set the selection without going through the UI,
   *   like `select.value`), `.setOptions(newOptions)` (rebuild the option
   *   list in place), and `.focus()` (delegates to the trigger button). The native `.hidden`
   *   property/attribute works as-is since it's a plain element.
   */
  function dropdown(options, value, onChange, opts) {
    opts = opts || {};
    const root = el("div", { className: "dd" });
    const trigger = el("button", {
      className: "dd-trigger" + (opts.className ? " " + opts.className : ""),
      attrs: { type: "button" },
    });
    const labelEl = el("span", { className: "dd-trigger-label" });
    trigger.appendChild(labelEl);
    trigger.appendChild(icon("expand_more", "dd-chevron"));
    root.appendChild(trigger);

    // The option list lives outside `root` in the DOM (appended to <body>
    // only while open, removed again on close) rather than as a plain
    // `position: absolute` child of `root`. Several call sites nest this
    // control inside an `overflow: hidden` ancestor (`.dest-card`'s rounded
    // corners, in particular) — an absolutely-positioned child would be
    // silently clipped there. It's created once and reused across
    // open/close so re-opening doesn't rebuild it from scratch.
    const list = el("div", { className: "dd-list", attrs: { role: "listbox" } });

    let currentOptions = options || [];
    let currentValue = value;
    let open = false;

    function findOption(v) {
      return currentOptions.find((o) => String(o.value) === String(v));
    }

    function renderLabel() {
      const match = findOption(currentValue);
      labelEl.textContent = match ? match.label : opts.placeholder || "";
    }

    function renderOptions() {
      list.innerHTML = "";
      if (currentOptions.length === 0) {
        list.appendChild(el("div", { className: "dd-option-empty", text: opts.emptyText || "No options" }));
        return;
      }
      currentOptions.forEach((o) => {
        const isSelected = String(o.value) === String(currentValue);
        const item = el("button", {
          className: "dd-option" + (isSelected ? " dd-option-selected" : ""),
          attrs: { type: "button", role: "option", "aria-selected": String(isSelected) },
        });
        item.dataset.optionValue = String(o.value);
        item.appendChild(el("span", { className: "dd-option-label", text: o.label }));
        if (isSelected) item.appendChild(icon("check", "dd-option-check"));
        item.addEventListener("click", () => {
          currentValue = o.value;
          renderLabel();
          renderOptions();
          closeList();
          root.dispatchEvent(new Event("change"));
          onChange && onChange(o.value);
        });
        list.appendChild(item);
      });
    }

    /** Places `list` (already in <body>) directly under/over the trigger,
     * flipping above it only when there's not enough room below *and*
     * there's more room above — a simple check, not full collision/popover
     * logic (not needed: this app has no nested-scroll-container cases
     * beyond the simple "near the bottom of the window" one). */
    function position() {
      const rect = trigger.getBoundingClientRect();
      list.style.left = rect.left + "px";
      // `min-width`, not `width`: a narrow trigger (e.g. the 76px Framerate
      // picker) would otherwise force every option's label to wrap onto two
      // lines. Options can be wider than the trigger; they always share its
      // left edge.
      list.style.minWidth = rect.width + "px";
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const wantsFlip = spaceBelow < 160 && spaceAbove > spaceBelow;
      list.classList.toggle("dd-list-up", wantsFlip);
      if (wantsFlip) {
        list.style.bottom = window.innerHeight - rect.top + 4 + "px";
        list.style.top = "";
        list.style.maxHeight = Math.max(120, spaceAbove - 12) + "px";
      } else {
        list.style.top = rect.bottom + 4 + "px";
        list.style.bottom = "";
        list.style.maxHeight = Math.max(120, spaceBelow - 12) + "px";
      }
    }

    function onReposition() {
      if (!trigger.isConnected) {
        closeList();
        return;
      }
      position();
    }

    function onDocMouseDown(e) {
      if (!trigger.isConnected || (!root.contains(e.target) && !list.contains(e.target))) closeList();
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        closeList();
        trigger.focus();
      }
    }

    function openList() {
      if (open) return;
      open = true;
      document.body.appendChild(list);
      position();
      // A frame late, same "already in the DOM before the class flips"
      // trick this codebase already uses for its other open/close
      // transitions (see e.g. shell.css's `.room-panel-scrim-open`) — the
      // transition needs the closed (scaleY(0.9)/opacity 0) state to have
      // actually painted first, or the browser coalesces both style
      // changes into one frame and it just appears instead of rolling out.
      requestAnimationFrame(() => list.classList.add("dd-list-open"));
      trigger.classList.add("dd-trigger-open");
      document.addEventListener("mousedown", onDocMouseDown, true);
      document.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("scroll", onReposition, true);
      window.addEventListener("resize", onReposition);
      opts.onOpen && opts.onOpen();
    }

    function closeList() {
      if (!open) return;
      open = false;
      list.classList.remove("dd-list-open", "dd-list-up");
      trigger.classList.remove("dd-trigger-open");
      document.removeEventListener("mousedown", onDocMouseDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
      if (list.parentNode) list.parentNode.removeChild(list);
      opts.onClose && opts.onClose();
    }

    trigger.addEventListener("click", () => (open ? closeList() : openList()));

    Object.defineProperty(root, "value", {
      get() {
        return currentValue;
      },
      set(v) {
        currentValue = v;
        renderLabel();
        renderOptions();
      },
    });
    root.setOptions = function (newOptions) {
      currentOptions = newOptions || [];
      renderLabel();
      renderOptions();
    };
    root.focus = function () {
      trigger.focus();
    };

    renderLabel();
    renderOptions();
    return root;
  }

  // -------------------------------------------------------------------
  // Two-option pill switch — mirrors `theme.rs`'s use of a `selectable_label`
  // pair for exclusive two-choice pickers (the codec/preset pickers, the
  // add-room Join/Create tabs). One shared implementation so both
  // call sites don't drift into near-copies of each other.
  // -------------------------------------------------------------------

  /**
   * @param {{value: string, label: string, title?: string, disabled?: boolean}[]} options
   *   - `title` is optional per-option tooltip text (native `title`
   *   attribute); omit it and the button gets no tooltip at all, so existing
   *   callers that don't pass it are unaffected. `disabled` greys the option
   *   out and makes it unclickable — for options the codec selector needs to
   *   offer but the current machine's encoder backend can't actually produce
   *   (see `commands::supported_codecs`'s doc comment); existing callers
   *   that don't pass it are likewise unaffected.
   * @param {string} value - currently selected option's `value`
   * @param {(value: string) => void} onChange
   */
  function pillSwitch(options, value, onChange) {
    const wrap = el("div", { className: "mode-toggle" });
    options.forEach((opt) => {
      const attrs = {};
      if (opt.title) attrs.title = opt.title;
      if (opt.disabled) attrs.disabled = "";
      wrap.appendChild(
        el("button", {
          className:
            "mode-toggle-btn" +
            (opt.value === value ? " mode-toggle-btn-active" : "") +
            (opt.disabled ? " mode-toggle-btn-disabled" : ""),
          text: opt.label,
          onClick: opt.disabled ? null : () => onChange(opt.value),
          attrs,
        })
      );
    });
    return wrap;
  }

  // -------------------------------------------------------------------
  // Encoder presets — the "Low-Latency / Balanced / Quality / Gaming" pill
  // switch. A preset is one opaque wire string (`edit_destination`'s /
  // `set_preset`'s `preset`); what it means for the WebRTC sender (content
  // hint, degradation preference, ...) is the P2P module's business, not the
  // UI's. There are deliberately no raw encoder knobs (tune / quality level /
  // rate control / GOP) any more: those were GStreamer/VAAPI concepts with no
  // WebRTC equivalent.
  // -------------------------------------------------------------------
  const ENCODER_PRESETS = [
    { value: "low_latency", label: "Low-Latency", title: "Prioritizes reduced delay over sharpness." },
    { value: "balanced", label: "Balanced", title: "The default — a good mix of latency and quality." },
    { value: "quality", label: "Quality", title: "Maximizes visual quality within the bitrate ceiling." },
    { value: "gaming", label: "Gaming", title: "Tuned for fast-motion content — favors smooth motion over sharpness." },
  ];
  const DEFAULT_PRESET = "balanced";

  // Codec pill switch — values are the wire strings used by `set_codec` /
  // `edit_destination` / `set_start_stream_defaults`. All four are
  // WebRTC-native; which ones this machine can actually encode comes from
  // `supported_codecs` (`opts.supportedCodecs`).
  const CODEC_OPTIONS = [
    { value: "h264", label: "H.264", title: "Most compatible — decodes everywhere, including hardware that can't do H.265/AV1/VP9." },
    { value: "av1", label: "AV1", title: "Modern, royalty-free, best efficiency on recent hardware." },
    { value: "h265", label: "H.265", title: "Good quality per bit; licensing caveats on some platforms." },
    { value: "vp9", label: "VP9", title: "Royalty-free, widely supported software codec." },
  ];

  // -------------------------------------------------------------------
  // Destination card — the Stream Control tab's Active Shares entry. One of
  // these per outgoing destination (a capture sent into one room), or — with
  // `opts.staged` — the pre-"Go live" card for a capture that is running but
  // not yet sent anywhere. Deliberately dumb: it renders whatever fields/state
  // the caller hands it and calls back through `handlers` for every action.
  // -------------------------------------------------------------------

  /**
   * @param {object} dest - a destination row { destination_id, capture_id,
   *   roomId, state: 'starting'|'live'|'rebuilding'|'stalled'|'failed', width,
   *   height, framerate, bitrate_kbps, audio: bool, pending }, plus
   *   frontend-only `room_label` (looked up by `roomId`) and `pendingRoleText`.
   *   With `opts.staged`, a staged-capture row { capture_id, state:
   *   'starting'|'ready', width, height, framerate, bitrate_kbps } instead
   *   (no destination_id / roomId yet).
   * @param {object} handlers - { onEditApply(id, patch), onFanout(captureId,
   *   roomId), onStop(destinationId), onRetry(dest), onStagedRoomChange(
   *   captureId, roomId), onGoLive(captureId), onCancel(captureId) }.
   *   `patch` is any subset of { framerate, bitrateKbps, codec, preset,
   *   shareAudio }; `id` is `destination_id` (live) or `capture_id` (staged).
   * @param {object} [opts] - { roomOptions: [{id,name}], framerateOptions:
   *   number[], supportedCodecs: string[], roomsAlreadyFedByCapture: string[],
   *   editState: {bitrateKbps, framerate, codec, preset, shareAudio, error},
   *   stalledSince: number|null, staged: bool, stagedRoomId: string }.
   *
   *   `editState` is the caller-held edit buffer; every control renders from
   *   it, never from the `dest` DTO (the DTO lags behind live edits — a
   *   bitrate-only change never fires `destination-state-changed`, so
   *   rendering from the DTO made the slider snap back). The one exception is
   *   the Share-audio switch on a *live* card, which reads `dest.audio`.
   *
   *   `supportedCodecs` disables any codec option not in the list; defaults to
   *   `["h264"]` so an unfetched list never offers something that would
   *   silently downgrade.
   */
  function destinationCard(dest, handlers, opts) {
    handlers = handlers || {};
    opts = opts || {};
    const STATE_META = {
      starting: { label: "STARTING", family: "progress" },
      ready: { label: "READY", family: "progress" },
      rebuilding: { label: "APPLYING", family: "progress" },
      live: { label: "LIVE", family: "live" },
      stalled: { label: "WAITING FOR CAPTURE", family: "degraded" },
      failed: { label: dest.room_label ? `${dest.room_label} stream failed` : "Stream failed", family: "failed" },
    };
    const meta = STATE_META[dest.state] || { label: dest.state, family: "progress" };

    // `dest-card-<state>` also drives the 4px left accent bar
    // (stream-control.css's `.dest-card::before` family).
    const wrap = el("div", { className: "dest-card dest-card-" + dest.state });

    // Failed is a squared card, not a pill (status.css's `.status-failed-box`):
    // its own compact layout, since none of the meta/edit/actions stack applies
    // to a destination producing no frames.
    if (meta.family === "failed") {
      const head = el("div", { className: "dest-card-head" });
      head.appendChild(el("span", { className: "dest-room-label", text: dest.room_label }));
      wrap.appendChild(head);
      wrap.appendChild(
        statusBadge("failed", meta.label, {
          errorText: dest.errorText,
          onRetry: () => handlers.onRetry && handlers.onRetry(dest),
          onDismiss: () => handlers.onStop && handlers.onStop(dest.destination_id),
        })
      );
      return wrap;
    }

    const body = el("div", { className: "dest-card-body" });

    const head = el("div", { className: "dest-card-head" });
    // Staged: no room chosen yet (the Room field in the edit grid below is for
    // that), so the head names the card generically.
    head.appendChild(el("span", { className: "dest-room-label", text: opts.staged ? "Screen Share" : dest.room_label }));
    head.appendChild(statusBadge(meta.family, meta.label, meta.family === "degraded" ? { since: opts.stalledSince } : {}));
    body.appendChild(head);

    if (dest.pendingRoleText) {
      body.appendChild(el("div", { className: "dest-pending-role", text: dest.pendingRoleText }));
    }

    // Labelled RESOLUTION / FRAMERATE / BITRATE columns in a sunken inset,
    // sparkline pushed to the right end. The sparkline's bars are populated
    // out-of-band by `stream-control.js`'s `updateStats()`.
    const metaRow = el("div", { className: "dest-meta-row" });
    const metric = (label, value, extraValueClass) =>
      el("div", { className: "dest-metric" }, [
        el("span", { className: "dest-metric-label", text: label }),
        el("span", { className: extraValueClass ? `dest-metric-value ${extraValueClass}` : "dest-metric-value", text: value }),
      ]);
    metaRow.appendChild(metric("Resolution", `${dest.width}×${dest.height}`));
    metaRow.appendChild(metric("Framerate", `${dest.framerate} fps`));
    // `dest-metric-bitrate-value`: a dedicated class so `updateStats()` can
    // write the live bitrate straight into this node on every stats tick.
    metaRow.appendChild(metric("Bitrate", `${dest.bitrate_kbps} kbps`, "dest-metric-bitrate-value"));
    // Flex spacer that pushes the sparkline to the right edge.
    metaRow.appendChild(el("div", { className: "dest-meta" }));

    const sparkline = el("div", { className: "dest-sparkline", attrs: { hidden: "" } });
    for (let i = 0; i < 6; i++) sparkline.appendChild(el("span", { className: "spark-bar spark-bar-empty" }));
    metaRow.appendChild(sparkline);
    body.appendChild(metaRow);

    // Live captured/sent FPS readout — populated by `updateStats()` via direct
    // `textContent` writes (never through this card's sig-diffed render path).
    // Starts hidden until the first tick arrives.
    body.appendChild(el("div", { className: "dest-fps-readout", attrs: { hidden: "" } }));

    // "Which rooms" chip row — the rooms this capture is already sent to, plus
    // a dashed "Also send to…" chip that reveals the fan-out picker. Staged
    // cards have no room yet, so the row is skipped.
    if (!opts.staged) {
      const fedRoomIds = opts.roomsAlreadyFedByCapture && opts.roomsAlreadyFedByCapture.length ? opts.roomsAlreadyFedByCapture : [dest.roomId];
      const chipRow = el("div", { className: "dest-chip-row" });
      fedRoomIds.forEach((rid) => {
        const label = rid === dest.roomId ? dest.room_label : (((opts.roomOptions || []).find((r) => r.id === rid) || {}).name || String(rid));
        chipRow.appendChild(el("span", { className: "dest-chip", text: label }));
      });
      const fanoutOptions = (opts.roomOptions || []).filter((r) => r.id !== dest.roomId && !fedRoomIds.includes(r.id));
      if (fanoutOptions.length > 0) {
        const addWrap = el("span", { className: "dest-chip-inline-add" });
        const fanoutSelect = dropdown(
          fanoutOptions.map((r) => ({ value: r.id, label: r.name })),
          fanoutOptions[0].id,
          (value) => {
            handlers.onFanout && handlers.onFanout(dest.capture_id, String(value));
            addBtn.hidden = false;
            fanoutSelect.hidden = true;
          },
          { className: "dest-room-select dest-chip-select" }
        );
        fanoutSelect.hidden = true;
        const addBtn = el("button", {
          className: "dest-chip-add-btn",
          text: "+ Also send to…",
          onClick: () => {
            addBtn.hidden = true;
            fanoutSelect.hidden = false;
            fanoutSelect.focus();
          },
        });
        addWrap.appendChild(addBtn);
        addWrap.appendChild(fanoutSelect);
        chipRow.appendChild(addWrap);
      }
      body.appendChild(chipRow);
    }

    // The encoder edit panel: [Room (staged)], Framerate, Codec, Preset,
    // Bitrate, Share audio. All auto-apply on change.
    const editState = opts.editState || { framerate: dest.framerate, bitrateKbps: dest.bitrate_kbps, codec: "h264", preset: DEFAULT_PRESET, shareAudio: false };
    const editId = opts.staged ? dest.capture_id : dest.destination_id;
    const applyTuning = (patch) => handlers.onEditApply && handlers.onEditApply(editId, patch);

    // One grid (`.dest-edit-grid`) so every control starts at the same X.
    // `.dest-edit-row` is `display: contents`, so each row must contribute
    // exactly three children (label / control / value) or grid auto-placement
    // spills the next row's label into the value column.
    const editGrid = el("div", { className: "dest-edit-grid" });

    // Staged only: which room "Go live" sends into. A live destination already
    // has a room; "Also send to…" adds more afterwards.
    if (opts.staged) {
      const roomRow = el("div", { className: "dest-edit-row" });
      roomRow.appendChild(el("label", { className: "field-label dest-edit-label", text: "Room" }));
      roomRow.appendChild(
        dropdown(
          (opts.roomOptions || []).map((r) => ({ value: r.id, label: r.name })),
          opts.stagedRoomId,
          (value) => handlers.onStagedRoomChange && handlers.onStagedRoomChange(dest.capture_id, String(value)),
          { className: "dest-room-select", placeholder: "Join a room first", emptyText: "No joined rooms" }
        )
      );
      roomRow.appendChild(el("span"));
      editGrid.appendChild(roomRow);
    }

    const framerateRow = el("div", { className: "dest-edit-row" });
    framerateRow.appendChild(el("label", { className: "field-label dest-edit-label", text: "Framerate" }));
    framerateRow.appendChild(
      dropdown(
        (opts.framerateOptions || [editState.framerate]).map((fps) => ({ value: String(fps), label: fps + " fps" })),
        String(editState.framerate),
        (value) => applyTuning({ framerate: Number(value) }),
        { className: "dest-room-select dest-framerate-select" }
      )
    );
    framerateRow.appendChild(el("span"));
    editGrid.appendChild(framerateRow);

    const supportedCodecs = opts.supportedCodecs || ["h264"];
    const codecRow = el("div", { className: "dest-edit-row" });
    codecRow.appendChild(el("label", { className: "field-label dest-edit-label", text: "Codec" }));
    const codecToggle = pillSwitch(
      CODEC_OPTIONS.map((c) => ({ ...c, disabled: !supportedCodecs.includes(c.value) })),
      editState.codec || "h264",
      (value) => applyTuning({ codec: value })
    );
    codecToggle.classList.add("dest-tuning-toggle");
    codecRow.appendChild(codecToggle);
    codecRow.appendChild(el("span"));
    editGrid.appendChild(codecRow);

    const presetRow = el("div", { className: "dest-edit-row" });
    presetRow.appendChild(el("label", { className: "field-label dest-edit-label", text: "Preset" }));
    const presetToggle = pillSwitch(
      ENCODER_PRESETS.map((p) => ({ value: p.value, label: p.label, title: p.title })),
      editState.preset || DEFAULT_PRESET,
      (value) => applyTuning({ preset: value })
    );
    presetToggle.classList.add("dest-tuning-toggle");
    presetRow.appendChild(presetToggle);
    presetRow.appendChild(el("span"));
    editGrid.appendChild(presetRow);

    // Bitrate — always the user's to set (nothing splits it automatically any more).
    // Reads `editState.bitrateKbps`, not `dest.bitrate_kbps`: this card is
    // rebuilt whenever its sig changes, and `editState` is in that sig, so a
    // slider built from the lagging DTO would snap back to the old value.
    const bitrateRow = el("div", { className: "dest-edit-row" });
    bitrateRow.appendChild(el("label", { className: "field-label dest-edit-label", text: "Bitrate (kbps)" }));
    const slider = el("input", {
      className: "dest-bitrate-slider",
      attrs: { type: "range", min: "200", max: "40000", step: "100", value: String(editState.bitrateKbps) },
    });
    const bitrateValue = el("span", { className: "dest-bitrate-value", text: editState.bitrateKbps + " kbps" });
    slider.addEventListener("input", () => {
      bitrateValue.textContent = slider.value + " kbps";
    });
    slider.addEventListener("change", () => {
      applyTuning({ bitrateKbps: Number(slider.value) });
    });
    attachWheelStep(slider);
    bitrateRow.appendChild(slider);
    bitrateRow.appendChild(bitrateValue);
    editGrid.appendChild(bitrateRow);

    // Share audio — a plain on/off; which audio gets captured (system mix,
    // the picked window's audio, ...) is decided by the platform, not the UI.
    const audioOn = opts.staged ? !!editState.shareAudio : !!dest.audio;
    const audioRow = el("div", { className: "dest-edit-row" });
    audioRow.appendChild(el("label", { className: "field-label dest-edit-label", text: "Share audio" }));
    const audioToggle = pillSwitch(
      [
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ],
      audioOn ? "on" : "off",
      (value) => applyTuning({ shareAudio: value === "on" })
    );
    audioToggle.classList.add("dest-tuning-toggle", "dest-audio-toggle");
    audioRow.appendChild(audioToggle);
    audioRow.appendChild(el("span"));
    editGrid.appendChild(audioRow);

    body.appendChild(editGrid);

    if (editState.error) {
      body.appendChild(el("div", { className: "dest-edit-error", text: editState.error }));
    }

    const actions = el("div", { className: opts.staged ? "dest-actions dest-actions-staged" : "dest-actions" });
    if (opts.staged) {
      // "Go live" attaches the staged capture to the chosen room. Disabled —
      // not hidden — until the capture is `ready` (and a room is chosen), so
      // the button doesn't jump around when the capture comes up.
      const goLiveBtn = primaryButton("Go live", () => handlers.onGoLive && handlers.onGoLive(dest.capture_id), {
        className: "dest-action-btn dest-go-live-btn",
      });
      if (dest.state !== "ready" || !opts.stagedRoomId) goLiveBtn.disabled = true;
      actions.appendChild(goLiveBtn);
      actions.appendChild(
        dangerButton("Cancel", () => handlers.onCancel && handlers.onCancel(dest.capture_id), { className: "dest-action-btn" })
      );
    } else {
      actions.appendChild(dangerButton("Stop", () => handlers.onStop && handlers.onStop(dest.destination_id), { className: "dest-action-btn" }));
    }
    body.appendChild(actions);

    wrap.appendChild(body);
    return wrap;
  }

  window.Components = {
    el,
    icon,
    attachWheelStep,
    primaryButton,
    secondaryButton,
    dangerButton,
    iconButton,
    renderNavButton,
    statusDot,
    statusBadge,
    hatchedBanner,
    emptyRow,
    renderRoomRow,
    renderStreamRow,
    renderUnreachableNote,
    renderEmptyState,
    card,
    dropdown,
    pillSwitch,
    destinationCard,
    ENCODER_PRESETS,
  };
})();
