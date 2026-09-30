// shell.js — app shell behavior: nav tab switching, ROOMS/STREAMS rendering,
// the "Create / Join a Room" card, the room-detail slide-over, the
// leave-confirm modal.
//
// Every backend touchpoint is `invoke(name, args)` on the `window.__TAURI__`
// seam the P2P backend (p2p/tauri-shim.js) installs (`core.invoke(name,
// args)` and `event.listen(name, cb)` where `cb` receives `{ payload }`).
//
// Rooms are identified by `roomId`. A room's `code` is its *share code*: one
// string carrying both the room identifier and its password, e.g.
// `ab12cd-ef34gh56ij78kl90`. Joining is "paste the code, press Join".
//
// Per the "the nav is a pure view-switcher" rule: this script only ever
// toggles which tab panel is visible. It never starts or stops a share/watch
// as a side effect of switching tabs.
//
// This module also owns the one place every event listener is registered
// (`wireEvents`, called once from `init`). Events that affect other tabs are
// forwarded through the small `window.StreamControl` / `window.ViewTab`
// surfaces those scripts expose.

(function () {
  "use strict";

  const {
    renderNavButton,
    renderRoomRow,
    renderStreamRow,
    renderEmptyState,
    renderUnreachableNote,
    secondaryButton,
    primaryButton,
    dangerButton,
    iconButton,
    icon,
    el,
    statusDot,
    hatchedBanner,
    pillSwitch,
  } = window.Components;

  const NAV_TABS = ["Stream Control", "View", "Settings"];

  const { invoke } = window.__TAURI__.core;

  // Saved rooms (`list_saved_rooms`, plus each joined room's roster from
  // `room_detail`) and the sidebar OUTGOING rows (`list_active_streams`).
  let rooms = [];
  let streams = [];

  // ---------------------------------------------------------------------
  // UI state (frontend-only; not persisted).
  // ---------------------------------------------------------------------

  const state = {
    activeTab: "Stream Control",
    // `roomId` of the room whose detail slide-over is open (or null).
    activeRoomPanel: null,
    addRoomOpen: false,
    // Which tab the "+ Create/Join a Room" card shows. "join" is the default
    // (reset whenever the card is opened), "create" mints a new room.
    addRoomTab: "join",
    // After a successful Create: { roomId, code, name } — the card then shows
    // the new room's share code (copyable) until dismissed.
    addRoomCreated: null,
    pendingLeaveRoomId: null,
    // Own display name for the MEMBERS panel's self row — re-read from
    // settings every time a panel opens (it can change in the Settings tab).
    myDisplayName: null,
    // roomId -> Map(peerId -> peerName): peers we couldn't reach directly
    // (`peer_unreachable`), cleared by `peer_connected` / `peer_left`.
    unreachable: new Map(),
  };

  /** Error text for display: `Error` objects give their message, anything else
   * (e.g. a rejected string) is stringified. */
  function errText(e) {
    return e && e.message ? e.message : String(e);
  }

  // ---------------------------------------------------------------------
  // Data touchpoints
  // ---------------------------------------------------------------------

  async function fetchRooms() {
    return await invoke("list_saved_rooms");
  }

  async function fetchStreams() {
    const rows = await invoke("list_active_streams");
    return rows.map((row) => Object.assign({}, row, { room_label: roomLabelFor(row.roomId) }));
  }

  function roomLabelFor(roomId) {
    const room = rooms.find((r) => r.roomId === roomId);
    return room ? room.name : String(roomId);
  }

  async function fetchMyDisplayName() {
    try {
      const settings = await invoke("get_settings");
      return settings.displayName || null;
    } catch (_) {
      return null;
    }
  }

  /** Populates one room's `members` / `streams` from `room_detail` — the
   * saved-room list doesn't inline a roster, so this is a lazy, per-room
   * fetch. */
  async function loadRoomMembers(room) {
    if (room.state !== "joined") return;
    const detail = await invoke("room_detail", { roomId: room.roomId });
    if (!detail) return;
    const selfId = window.P2P && window.P2P.selfId;
    const watchedOwners = new Set(detail.watched.map((k) => `${k.owner}:${k.stream_id}`));
    room.members = detail.members.map((m) => {
      const videoStream = detail.streams.find((s) => s.owner === m.conn_id && s.kind === "Video");
      return {
        conn_id: m.conn_id,
        display_name: m.display_name,
        // The roster includes this client itself (conn_id = P2P.selfId).
        self: m.conn_id === selfId,
        owner: m.conn_id,
        stream_id: videoStream ? videoStream.stream_id : 0,
        resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : null,
        watching: videoStream ? watchedOwners.has(`${videoStream.owner}:${videoStream.stream_id}`) : false,
      };
    });
    // Every announced stream (not just one per member) plus the watched set,
    // both read by the room panel's "Live streams" section.
    room.streams = detail.streams;
    room.watchedKeys = watchedOwners;
  }

  // ---- Room lifecycle: create / join / leave ---------------------------

  /** `create_room({ name })` -> `{ roomId, code, name }` */
  async function apiCreateRoom(name) {
    const created = await invoke("create_room", { name });
    await refreshRooms();
    return created;
  }

  /** `join_room({ code, name? })` -> `{ roomId, code, name }`; rejects with an
   * `Error` whose message is shown to the user when the code is malformed. */
  async function apiJoinRoom(code, name) {
    const joined = await invoke("join_room", name ? { code, name } : { code });
    await refreshRooms();
    return joined;
  }

  /** Reconnect a saved (disconnected) room using its stored code. */
  async function reconnectRoom(roomId) {
    const room = rooms.find((r) => r.roomId === roomId);
    if (!room) return;
    try {
      // The placeholder "Room <roomId>" isn't a real name: don't send it.
      const placeholder = room.name === `Room ${roomId}`;
      await apiJoinRoom(room.code, placeholder ? undefined : room.name);
    } catch (e) {
      console.error("reconnect failed", e);
    }
  }

  /** Leave a room: a joined/reconnecting room becomes disconnected (still
   * saved); a disconnected one is forgotten (removed from the saved list). */
  async function leaveRoom(roomId) {
    const room = rooms.find((r) => r.roomId === roomId);
    if (!room) return;
    const wasConnected = room.state !== "disconnected";
    state.unreachable.delete(roomId);
    if (wasConnected) await invoke("leave_room", { roomId });
    else await invoke("forget_room", { roomId });
    await refreshRooms();
  }

  // ---------------------------------------------------------------------
  // Nav
  // ---------------------------------------------------------------------

  function renderNav() {
    const nav = document.getElementById("nav");
    nav.innerHTML = "";
    NAV_TABS.forEach((tab) => {
      nav.appendChild(renderNavButton(tab, state.activeTab === tab, () => setActiveTab(tab)));
    });
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    // Toggle the active class on the existing buttons rather than rebuilding
    // them: the active-pill is a CSS `transition:`, and a transition never
    // plays on a brand-new element inserted already in its final state.
    document.querySelectorAll("#nav .nav-btn").forEach((btn) => {
      btn.classList.toggle("nav-btn-active", btn.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = panel.dataset.tab !== tab;
    });
  }

  // ---------------------------------------------------------------------
  // Unreachable peers — `peer_unreachable` / `peer_connected`
  // ---------------------------------------------------------------------

  function peersFor(roomId) {
    const peers = state.unreachable.get(roomId);
    return peers ? Array.from(peers, ([peerId, peerName]) => ({ peerId, peerName })) : [];
  }

  /** `peer_unreachable` handler: `{ roomId, peerId, peerName }`. Also callable
   * from the console (`Shell.peerUnreachable({...})`) to demo the state. */
  function peerUnreachable(payload) {
    if (!payload || payload.roomId == null || payload.peerId == null) return;
    if (!state.unreachable.has(payload.roomId)) state.unreachable.set(payload.roomId, new Map());
    state.unreachable.get(payload.roomId).set(payload.peerId, payload.peerName || String(payload.peerId));
    renderRooms();
    renderRoomPanel();
  }

  /** `peer_connected` handler: `{ roomId, peerId, peerName }` — clears the
   * blocked state for that peer. */
  function peerConnected(payload) {
    if (!payload) return;
    const peers = state.unreachable.get(payload.roomId);
    if (peers) {
      peers.delete(payload.peerId);
      if (peers.size === 0) state.unreachable.delete(payload.roomId);
    }
    renderRooms();
    renderRoomPanel();
  }

  // ---------------------------------------------------------------------
  // ROOMS section
  // ---------------------------------------------------------------------

  function renderRooms() {
    const list = document.getElementById("rooms-list");
    const count = document.getElementById("rooms-count");
    if (count) count.textContent = rooms.length > 0 ? String(rooms.length) : "";
    list.innerHTML = "";

    if (rooms.length === 0) {
      list.appendChild(renderRoomsEmptyState());
      // The empty state offers no action of its own, so with zero rooms the
      // "+ Create/Join a Room" card auto-opens as the entry point — only on
      // the closed->open transition, so a repaint doesn't reset a user who is
      // mid-typing or on the Create tab.
      if (!state.addRoomOpen) {
        state.addRoomOpen = true;
        state.addRoomTab = "join";
        renderAddRoomCard();
      }
      return;
    }

    rooms.forEach((room) => {
      room.unreachable = peersFor(room.roomId);
      list.appendChild(
        renderRoomRow(room, {
          onOpenRoom: (roomId) => openRoomPanel(roomId),
          onReconnect: (roomId) => reconnectRoom(roomId),
          onLeave: (roomId) => openLeaveConfirm(roomId),
          onJoinedRowClick: (clickedRoom) => jumpToViewForRoom(clickedRoom),
          onUnreachableClick: () => setActiveTab("Settings"),
        })
      );
    });
  }

  /** ROOMS row left-click on a *joined* room: jump to the View tab, filtered
   * to this room's streams unless it's the only connected room (then "all
   * rooms" is already exactly this room). */
  function jumpToViewForRoom(room) {
    setActiveTab("View");
    if (!window.ViewTab) return;
    const joinedCount = rooms.filter((r) => r.state === "joined").length;
    window.ViewTab.setRoomFilter(joinedCount > 1 ? room.name : null);
  }

  /** Watch-toggle for the room panel's MEMBERS section. */
  async function toggleWatch(roomId, member) {
    const room = rooms.find((x) => x.roomId === roomId);
    if (!room) return;
    await invoke("toggle_watch", { roomId, owner: member.owner, streamId: member.stream_id });
    await loadRoomMembers(room);
    if (window.ViewTab) window.ViewTab.refresh();
    renderRoomPanel();
  }

  /** Watch-toggle for the panel's "Live streams" section — same command,
   * generalized to any stream row. Also switches to the View tab on a *start*
   * (not a stop): the point is "so I can connect to them from there". */
  async function toggleStreamWatch(roomId, streamRow) {
    const room = rooms.find((x) => x.roomId === roomId);
    if (!room) return;
    const wasWatching = !!streamRow.watching;
    await invoke("toggle_watch", { roomId, owner: streamRow.owner, streamId: streamRow.stream_id });
    await loadRoomMembers(room);
    if (window.ViewTab) window.ViewTab.refresh();
    if (!wasWatching) setActiveTab("View");
    renderRoomPanel();
  }

  /** One row of the panel's "Live streams" section. */
  function renderRoomPanelStreamRow(room, s) {
    const row = el("div", { className: "room-panel-member-row" });
    const nameText = s.label ? `${s.display_name} — ${s.label}` : s.display_name;
    row.appendChild(el("span", { className: "room-panel-member-name", text: nameText }));
    const metaParts = [s.kind === "Video" ? "Video" : "Audio"];
    if (s.resolution) metaParts.push(s.resolution);
    row.appendChild(el("span", { className: "room-panel-member-status", text: metaParts.join(" · ") }));
    row.appendChild(
      iconButton(s.watching ? "visibility_off" : "visibility", () => toggleStreamWatch(room.roomId, s), {
        title: s.watching ? "Stop watching" : "Watch",
        className: s.watching ? "watch-active" : "",
      })
    );
    return row;
  }

  /** Empty state for the ROOMS section (first launch / no rooms). */
  function renderRoomsEmptyState() {
    return renderEmptyState("Paste a share code from whoever invited you, or create a room.", null, null, {
      icon: "meeting_room",
      headline: "No rooms yet",
      className: "empty-state-rooms",
    });
  }

  // ---- Copyable share-code field ----------------------------------------

  /** Copies `text` to the clipboard: `navigator.clipboard.writeText`, with an
   * `execCommand` fallback for contexts where the async API is refused.
   * Resolves `true` on success. */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (_) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  /** A read-only, click-to-select field showing a share code, with a Copy
   * button that flashes "Copied" for 1.5s. */
  function renderCodeField(code) {
    const wrap = el("div", { className: "share-code-field" });
    const input = el("input", {
      className: "field-input field-input-mono share-code-input",
      attrs: { type: "text", readonly: "", value: code, "aria-label": "Share code", spellcheck: "false" },
    });
    input.addEventListener("focus", () => input.select());
    input.addEventListener("click", () => input.select());
    wrap.appendChild(input);

    let revertTimer = null;
    const copyBtn = secondaryButton(
      "Copy",
      async () => {
        const ok = await copyText(code);
        copyBtn.textContent = ok ? "Copied" : "Copy failed";
        if (!ok) input.select();
        clearTimeout(revertTimer);
        revertTimer = setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      },
      { className: "share-code-copy" }
    );
    wrap.appendChild(copyBtn);
    return wrap;
  }

  // ---- Join / Create submit handlers ------------------------------------

  /** Shared join flow. `btn` (optional) is disabled while the request is in
   * flight; a failure is shown in `errorEl`. */
  async function submitJoin(code, errorEl, btn) {
    errorEl.hidden = true;
    if (!code) {
      errorEl.textContent = "Enter a share code.";
      errorEl.hidden = false;
      return;
    }
    if (btn) btn.disabled = true;
    try {
      await apiJoinRoom(code);
      state.addRoomOpen = false;
      renderAddRoomCard();
    } catch (e) {
      errorEl.textContent = errText(e);
      errorEl.hidden = false;
      if (btn) btn.disabled = false;
    }
  }

  /** Create tab's submit — mints a brand-new room, then shows its share code. */
  async function submitCreate(name, errorEl, btn) {
    errorEl.hidden = true;
    if (!name) {
      errorEl.textContent = "Give the room a name.";
      errorEl.hidden = false;
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const created = await apiCreateRoom(name);
      state.addRoomCreated = { roomId: created.roomId, code: created.code, name: created.name || name };
      renderAddRoomCard();
    } catch (e) {
      errorEl.textContent = errText(e);
      errorEl.hidden = false;
      if (btn) btn.disabled = false;
    }
  }

  function openLeaveConfirm(roomId) {
    const room = rooms.find((r) => r.roomId === roomId);
    if (!room) return;

    // Leaving raises a confirm dialog iff the room has an outgoing
    // destination or a live watch; a leave with neither is immediate. A
    // not-connected row (✕ = "forget") never needs one.
    const hasStake = myStreamCountForRoom(room) > 0 || (room.members || []).some((m) => m.watching);
    if (room.state === "joined" && hasStake) {
      state.pendingLeaveRoomId = roomId;
      renderLeaveModal();
    } else {
      leaveRoom(roomId);
    }
  }

  /**
   * Leave-room confirm dialog: a red `logout` icon + "Leave {RoomName}?"
   * title, a "you can rejoin any time" line, up to 2 stacked amber hatched
   * warning banners (only the ones that apply), and a footer with an "ESC to
   * cancel" hint, Cancel on the left, "Leave room" (danger) on the right.
   * Danger-on-the-right is a deliberate choice from the original design
   * handoff, not a bug to "fix".
   */
  function renderLeaveModal() {
    const overlay = document.getElementById("modal-overlay");
    overlay.innerHTML = "";
    if (!state.pendingLeaveRoomId) {
      overlay.hidden = true;
      return;
    }
    const room = rooms.find((r) => r.roomId === state.pendingLeaveRoomId);
    if (!room) {
      overlay.hidden = true;
      return;
    }

    const watchingCount = (room.members || []).filter((m) => m.watching).length;
    // The user's *own* outgoing-destination count (not the room's count of
    // other members' streams — a pure watcher must not see "you're sending").
    const sendingCount = myStreamCountForRoom(room);

    const modal = el("div", { className: "modal leave-modal" });

    const head = el("div", { className: "leave-modal-head" });
    head.appendChild(el("span", { className: "material-symbols-outlined leave-modal-icon", text: "logout" }));
    const headText = el("div", { className: "leave-modal-head-text" });
    headText.appendChild(el("div", { className: "leave-modal-title", text: `Leave ${room.name}?` }));
    headText.appendChild(el("div", { className: "leave-modal-subtext", text: "You can rejoin any time with the same share code." }));
    head.appendChild(headText);
    modal.appendChild(head);

    const banners = el("div", { className: "leave-modal-banners" });
    if (watchingCount > 0) {
      banners.appendChild(hatchedBanner(`You're watching ${watchingCount} stream${watchingCount === 1 ? "" : "s"} here — leaving closes ${watchingCount === 1 ? "it" : "them"}.`));
    }
    if (sendingCount > 0) {
      banners.appendChild(hatchedBanner(`You're sending ${sendingCount} stream${sendingCount === 1 ? "" : "s"} here — leaving stops ${sendingCount === 1 ? "it" : "them"}.`));
    }
    if (banners.children.length > 0) modal.appendChild(banners);

    const footer = el("div", { className: "leave-modal-footer" });
    footer.appendChild(el("span", { className: "leave-modal-esc-hint", text: "ESC to cancel" }));
    const actions = el("div", { className: "leave-modal-actions" });
    actions.appendChild(
      secondaryButton("Cancel", () => {
        state.pendingLeaveRoomId = null;
        renderLeaveModal();
      })
    );
    actions.appendChild(
      el("button", {
        // Solid red: Cancel is the outlined option on the left, the
        // destructive action the filled one on the right.
        className: "btn btn-danger-solid",
        text: "Leave room",
        onClick: async () => {
          const roomId = state.pendingLeaveRoomId;
          state.pendingLeaveRoomId = null;
          renderLeaveModal();
          await leaveRoom(roomId);
        },
      })
    );
    footer.appendChild(actions);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    overlay.hidden = false;
  }

  // ---------------------------------------------------------------------
  // Room-detail slide-over — one panel at a time, keyed by
  // `state.activeRoomPanel` (a `roomId`, or null when closed).
  // ---------------------------------------------------------------------

  /** Opens the panel for a room, any state. `renderRoomPanel` degrades for a
   * disconnected/reconnecting room (no Members/Live-streams sections, which
   * need a live roster). */
  async function openRoomPanel(roomId) {
    const room = rooms.find((r) => r.roomId === roomId);
    if (!room) return;

    state.activeRoomPanel = roomId;
    state.myDisplayName = await fetchMyDisplayName();

    const scrim = document.getElementById("room-panel-scrim");
    scrim.hidden = false;
    renderRoomPanel();
    // Two nested rAFs: the transition needs the closed state to have painted
    // once before the open class is added.
    requestAnimationFrame(() => requestAnimationFrame(() => scrim.classList.add("room-panel-scrim-open")));

    await loadRoomMembers(room);
    if (state.activeRoomPanel === roomId) renderRoomPanel();
  }

  /** Closes the panel (scrim click, close icon, ESC, or its room
   * disappearing). Animates out, then hides the scrim once the transition
   * ends (timeout fallback so the scrim can never get stuck invisible but
   * still blocking clicks). */
  function closeRoomPanel() {
    state.activeRoomPanel = null;
    const scrim = document.getElementById("room-panel-scrim");
    const panel = document.getElementById("room-panel");
    scrim.classList.remove("room-panel-scrim-open");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      scrim.hidden = true;
      panel.removeEventListener("transitionend", finish);
    };
    panel.addEventListener("transitionend", finish);
    setTimeout(finish, 300);
  }

  /** One non-self member row: name + either a watch toggle (they're sharing)
   * or a "not sharing" status. */
  function renderRoomPanelMemberRow(room, m) {
    const row = el("div", { className: "room-panel-member-row" });
    row.appendChild(el("span", { className: "room-panel-member-name", text: m.display_name }));
    if (m.resolution) {
      row.appendChild(
        iconButton(m.watching ? "visibility_off" : "visibility", () => toggleWatch(room.roomId, m), {
          title: m.watching ? "Stop watching" : "Watch",
          className: m.watching ? "watch-active" : "",
        })
      );
    } else {
      row.appendChild(el("span", { className: "room-panel-member-status", text: "not sharing" }));
    }
    return row;
  }

  /** The room panel header's title: click-to-edit in place. Enter commits,
   * Escape reverts, blur commits too. The rename is local: peers keep their
   * own name for the room (a newcomer with no name yet adopts one from a
   * peer's hello, see core.js). The note saying so shows only while editing. */
  function renderRoomPanelTitle(room) {
    const wrap = el("span", { className: "room-panel-title-wrap" });
    const title = el("span", { className: "room-panel-title", text: room.name });
    title.tabIndex = 0;
    title.title = "Click to rename";

    const startEdit = () => {
      wrap.innerHTML = "";
      const input = el("input", {
        className: "field-input room-panel-title-input",
        attrs: { type: "text", value: room.name },
      });
      const note = el("div", {
        className: "room-panel-privacy-note room-panel-title-privacy-note",
        text: "Only changes the name for you — others keep the name they see.",
      });

      // Enter, Escape, and blur can each fire in sequence (Enter blurs the
      // input as a side effect) — `settled` makes only the first one count.
      let settled = false;
      const commit = () => {
        if (settled) return;
        settled = true;
        renamePanelRoom(room.roomId, input.value.trim() || room.name);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        renderRoomPanel();
      };

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation(); // Don't also close the whole panel.
          cancel();
        }
      });
      input.addEventListener("blur", commit);

      wrap.appendChild(input);
      wrap.appendChild(note);
      input.focus();
      input.select();
    };

    title.addEventListener("click", startEdit);
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        startEdit();
      }
    });

    wrap.appendChild(title);
    return wrap;
  }

  /** Renders the panel's content for `state.activeRoomPanel`. A no-op when the
   * panel is closed; called after every data change that could affect it. */
  function renderRoomPanel() {
    const panel = document.getElementById("room-panel");
    if (!state.activeRoomPanel) return;
    const room = rooms.find((r) => r.roomId === state.activeRoomPanel);
    if (!room) return;
    panel.innerHTML = "";

    // ---- Header: status dot + name + close icon, meta line below. ----
    const header = el("div", { className: "room-panel-header" });
    const top = el("div", { className: "room-panel-header-top" });
    top.appendChild(statusDot(room.state));
    top.appendChild(renderRoomPanelTitle(room));
    top.appendChild(iconButton("close", () => closeRoomPanel(), { title: "Close", className: "room-panel-close" }));
    header.appendChild(top);

    // `room.members` is `room_detail`'s roster, which includes this client
    // (flagged `self`). The meta line and the Members / Live-streams sections
    // only make sense for a joined room (no live roster otherwise).
    const isJoined = room.state === "joined";
    const members = room.members || [];
    if (isJoined) {
      const memberCount = Math.max(members.length, 1);
      const sendingCount = myStreamCountForRoom(room);
      const metaText = `${memberCount} member${memberCount === 1 ? "" : "s"} · you're sending ${sendingCount} stream${sendingCount === 1 ? "" : "s"} here`;
      header.appendChild(el("div", { className: "room-panel-meta", text: metaText }));
    } else {
      const metaText = room.state === "reconnecting" ? "Reconnecting…" : "Not connected";
      header.appendChild(el("div", { className: "room-panel-meta", text: metaText }));
    }
    panel.appendChild(header);

    const body = el("div", { className: "room-panel-body" });

    // ---- SHARE CODE: viewable + copyable for any saved/active room. ----
    const codeSection = el("div", { className: "room-panel-members-section" });
    codeSection.appendChild(el("div", { className: "room-panel-section-label", text: "Share code" }));
    if (room.code) {
      codeSection.appendChild(renderCodeField(room.code));
      codeSection.appendChild(
        el("div", { className: "room-panel-privacy-note", text: "Anyone with this code can join the room — it includes the password." })
      );
    } else {
      codeSection.appendChild(el("span", { className: "room-panel-member-status", text: "No share code stored for this room." }));
    }
    body.appendChild(codeSection);

    // ---- Peers we couldn't reach directly. ----
    const blocked = renderUnreachableNote(peersFor(room.roomId), () => {
      closeRoomPanel();
      setActiveTab("Settings");
    });
    if (blocked) body.appendChild(blocked);

    if (isJoined) {
      // ---- MEMBERS ----
      const membersSection = el("div", { className: "room-panel-members-section" });
      membersSection.appendChild(el("div", { className: "room-panel-section-label", text: "Members" }));
      const memberList = el("div", { className: "room-panel-members" });

      const youRow = () => {
        const row = el("div", { className: "room-panel-member-row room-panel-member-row-you" });
        row.appendChild(el("span", { className: "room-panel-member-name", text: state.myDisplayName || "You" }));
        row.appendChild(el("span", { className: "room-panel-you-badge", text: "YOU" }));
        return row;
      };
      if (!members.some((m) => m.self)) memberList.appendChild(youRow());
      members.forEach((m) => memberList.appendChild(m.self ? youRow() : renderRoomPanelMemberRow(room, m)));
      membersSection.appendChild(memberList);
      body.appendChild(membersSection);

      // ---- LIVE STREAMS ----
      // Per-stream view of `room.streams`. Owner display name is looked up in
      // `members`; falls back to a short id if the owner isn't in the roster.
      const watchedKeys = room.watchedKeys || new Set();
      const streamRows = (room.streams || []).map((s) => {
        const ownerMember = members.find((m) => m.conn_id === s.owner);
        return {
          owner: s.owner,
          stream_id: s.stream_id,
          kind: s.kind,
          label: s.label,
          resolution: s.kind === "Video" ? `${s.width}x${s.height}` : null,
          display_name: ownerMember ? ownerMember.display_name : `Stream ${String(s.owner).slice(-4)}`,
          watching: watchedKeys.has(`${s.owner}:${s.stream_id}`),
        };
      });
      const streamsSection = el("div", { className: "room-panel-members-section" });
      streamsSection.appendChild(el("div", { className: "room-panel-section-label", text: "Live streams" }));
      const streamList = el("div", { className: "room-panel-members" });
      if (streamRows.length === 0) {
        streamList.appendChild(el("span", { className: "room-panel-member-status", text: "No one is sharing right now." }));
      } else {
        streamRows.forEach((s) => streamList.appendChild(renderRoomPanelStreamRow(room, s)));
      }
      streamsSection.appendChild(streamList);
      body.appendChild(streamsSection);
    }

    // ---- AUTO-CONNECT: join this room automatically at app startup. ----
    const autoConnectSection = el("div", { className: "room-panel-autoconnect-section" });
    const autoConnectLabel = el("label", { className: "room-panel-autoconnect-row" });
    const autoConnectCheckbox = el("input", {
      className: "room-panel-checkbox-input",
      attrs: { type: "checkbox" },
    });
    autoConnectCheckbox.checked = !!room.auto_connect;
    autoConnectCheckbox.addEventListener("change", () => {
      setRoomAutoConnect(room.roomId, autoConnectCheckbox.checked);
    });
    autoConnectLabel.appendChild(autoConnectCheckbox);
    autoConnectLabel.appendChild(el("span", { className: "room-panel-checkbox-box" }));
    autoConnectLabel.appendChild(el("span", { className: "room-panel-checkbox-label", text: "Auto-Connect" }));
    autoConnectSection.appendChild(autoConnectLabel);
    body.appendChild(autoConnectSection);

    panel.appendChild(body);

    // ---- Footer: two outline actions, each enabled only in the one state it
    // applies to (disabled rather than hidden, so the footer keeps its shape).
    //  - "Disconnect": a live connection to drop (joined, behind the confirm
    //    dialog if there is anything to lose) or an in-flight connect to
    //    cancel (reconnecting — nothing to lose, no confirm).
    //  - "Delete room": forget a saved room (disconnected only).
    const footer = el("div", { className: "room-panel-footer" });
    footer.appendChild(
      dangerButton(
        "Disconnect",
        () => {
          const roomId = room.roomId;
          closeRoomPanel();
          if (room.state === "reconnecting") leaveRoom(roomId);
          else openLeaveConfirm(roomId);
        },
        { className: "room-panel-leave-btn", disabled: room.state !== "joined" && room.state !== "reconnecting" }
      )
    );
    footer.appendChild(
      dangerButton(
        "Delete room",
        () => {
          const roomId = room.roomId;
          closeRoomPanel();
          openLeaveConfirm(roomId);
        },
        { className: "room-panel-leave-btn", disabled: room.state !== "disconnected" }
      )
    );
    panel.appendChild(footer);
  }

  async function renamePanelRoom(roomId, newName) {
    await invoke("rename_room", { roomId, newName });
    await refreshRooms();
  }

  /** Persists the panel's "Auto-Connect" checkbox and optimistically updates
   * the local room so the checkbox doesn't snap back while the round trip is
   * in flight. */
  async function setRoomAutoConnect(roomId, autoConnect) {
    const room = rooms.find((r) => r.roomId === roomId);
    if (room) room.auto_connect = autoConnect;
    try {
      await invoke("set_room_auto_connect", { roomId, autoConnect });
    } catch (e) {
      console.error("set_room_auto_connect failed", e);
    }
    await refreshRooms();
  }

  // ---------------------------------------------------------------------
  // "+ Create / Join a Room" inline card
  // ---------------------------------------------------------------------

  /** Renders the expanded card: a `pillSwitch` (Join first/default, Create
   * second) over one of two field sets — Join is a single "Share code" field,
   * Create asks for a room name and then shows the new room's share code.
   * `focusField` focuses the first input (only on user-driven opens, so a
   * background repaint never steals focus). */
  function renderAddRoomCard(focusField) {
    const card = document.getElementById("add-room-card");
    const btn = document.getElementById("add-room-btn");
    card.hidden = !state.addRoomOpen;
    btn.hidden = state.addRoomOpen;
    if (!state.addRoomOpen) return;

    card.innerHTML = "";
    card.appendChild(el("div", { className: "section-label add-room-label", text: "Create / Join a Room" }));

    // Create succeeded: show the share code instead of the form.
    if (state.addRoomCreated) {
      const created = state.addRoomCreated;
      card.appendChild(el("div", { className: "add-room-created-title", text: `“${created.name}” created` }));
      card.appendChild(el("label", { className: "field-label", text: "Share code" }));
      card.appendChild(renderCodeField(created.code));
      card.appendChild(
        el("div", { className: "add-room-hint", text: "Send this code to whoever should join — it includes the room password." })
      );
      const doneActions = el("div", { className: "add-room-actions" });
      doneActions.appendChild(
        primaryButton("Done", () => {
          state.addRoomCreated = null;
          state.addRoomOpen = false;
          renderAddRoomCard();
        })
      );
      card.appendChild(doneActions);
      return;
    }

    // `.add-room-tabs` is a scoped equal-width override of the shared
    // `pillSwitch` (see shell.css).
    const tabs = pillSwitch(
      [
        { value: "join", label: "Join" },
        { value: "create", label: "Create" },
      ],
      state.addRoomTab,
      (tab) => {
        state.addRoomTab = tab;
        renderAddRoomCard(true);
      }
    );
    tabs.classList.add("add-room-tabs");
    card.appendChild(tabs);

    const errorText = el("div", { className: "add-room-error", text: "" });
    errorText.hidden = true;
    const actions = el("div", { className: "add-room-actions" });
    const cancelBtn = secondaryButton("Cancel", () => {
      state.addRoomOpen = false;
      renderAddRoomCard();
    });

    if (state.addRoomTab === "create") {
      card.appendChild(el("label", { className: "field-label", text: "Room name" }));
      const roomNameInput = el("input", { className: "field-input", attrs: { type: "text", placeholder: "e.g. Movie Night" } });
      card.appendChild(roomNameInput);
      card.appendChild(errorText);

      const createBtn = primaryButton("Create", () => submitCreate(roomNameInput.value.trim(), errorText, createBtn));
      roomNameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") createBtn.click();
      });
      actions.appendChild(createBtn);
      actions.appendChild(cancelBtn);
      card.appendChild(actions);
      if (focusField) roomNameInput.focus();
      return;
    }

    // Join tab (default): just the share code.
    card.appendChild(el("label", { className: "field-label", text: "Share code" }));
    const codeInput = el("input", {
      className: "field-input field-input-mono",
      attrs: { type: "text", placeholder: "ab12cd-ef34gh56ij78kl90", spellcheck: "false", autocomplete: "off" },
    });
    // Share codes never contain whitespace: trim whatever gets pasted/typed.
    codeInput.addEventListener("input", () => {
      const trimmed = codeInput.value.trim();
      if (trimmed !== codeInput.value) codeInput.value = trimmed;
    });
    card.appendChild(codeInput);
    card.appendChild(errorText);

    const joinBtn = primaryButton("Join", () => submitJoin(codeInput.value.trim(), errorText, joinBtn));
    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") joinBtn.click();
    });
    actions.appendChild(joinBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);
    if (focusField) codeInput.focus();
  }

  // ---------------------------------------------------------------------
  // STREAMS / "OUTGOING" section — one row per active outgoing destination,
  // across every room. A destination sharing audio gets a speaker glyph.
  // ---------------------------------------------------------------------

  function renderStreams() {
    const list = document.getElementById("streams-list");
    list.innerHTML = "";
    if (streams.length === 0) {
      list.appendChild(
        renderEmptyState("Start a stream from the Stream Control tab to see it here.", "+ Start a Stream", () => {
          setActiveTab("Stream Control");
        }, { icon: "cast", headline: "You're not sharing anything" })
      );
      return;
    }
    streams.forEach((row) => list.appendChild(renderStreamRow(row, { onStop: (destinationId) => stopDestination(destinationId) })));
  }

  /** Sidebar's lighter-weight entry point onto the same `stop_destination`
   * command Stream Control's own Stop button calls. */
  async function stopDestination(destinationId) {
    if (window.StreamControl) {
      // Owns the actual stop plus its own per-destination bookkeeping.
      await window.StreamControl.stopDestination(destinationId);
    }
    await refreshStreams();
    if (window.StreamControl) window.StreamControl.refresh();
  }

  // ---------------------------------------------------------------------
  // Refresh — re-fetch + re-render ROOMS/STREAMS. Exposed on `window.Shell`
  // so the event listeners below (and other tabs) can trigger a sidebar
  // repaint without duplicating the fetch call.
  // ---------------------------------------------------------------------

  async function refreshRooms() {
    rooms = await fetchRooms();
    // The saved-room list carries no roster — every fresh object needs its
    // `.members` / `.streams` re-fetched (all joined rooms, in parallel: the
    // sidebar's member/LIVE tree needs them for every visible joined room).
    await Promise.all(rooms.filter((r) => r.state === "joined").map((r) => loadRoomMembers(r)));
    // The only reason to auto-close the panel is its room genuinely vanishing
    // from the saved list (forgotten elsewhere); a room dropping out of
    // `joined` just re-renders the panel in its disconnected form.
    if (state.activeRoomPanel && !rooms.some((r) => r.roomId === state.activeRoomPanel)) {
      closeRoomPanel();
    }
    renderRooms();
    renderRoomPanel();
  }

  async function refreshStreams() {
    streams = await fetchStreams();
    renderStreams();
  }

  /** How many streams *the current user* is sending into `room` right now —
   * this client's own outgoing destinations targeting it (not
   * `room.active_stream_count`, which counts *other* people's streams). */
  function myStreamCountForRoom(room) {
    if (!room) return 0;
    return streams.filter((s) => s.roomId === room.roomId).length;
  }

  async function refreshAll() {
    await refreshRooms();
    await refreshStreams();
  }

  // ---------------------------------------------------------------------
  // Event listeners — set up once. Events that affect other tabs are
  // forwarded through the small `window.StreamControl` / `window.ViewTab`
  // surfaces those scripts expose.
  // ---------------------------------------------------------------------

  function wireEvents() {
    const { listen } = window.__TAURI__.event;

    listen("room-connected", () => {
      refreshAll();
      // Without this, a room that finishes joining while the user is on the
      // Stream Control tab never appears in its room dropdown.
      if (window.StreamControl) window.StreamControl.refresh();
      if (window.ViewTab) window.ViewTab.refresh();
    });
    listen("room-disconnected", () => {
      refreshAll();
      if (window.StreamControl) window.StreamControl.refresh();
      if (window.ViewTab) window.ViewTab.refresh();
    });
    listen("room-connect-failed", (event) => {
      const p = event && event.payload;
      // Wrong-password attempts (often from outsiders) are expected noise:
      // `kind: 'wrong-password'`, or the older shape matched by message text.
      const text = typeof p === "string" ? p : p && (p.message || p.error || p.reason);
      const wrongPassword =
        (p && p.kind === "wrong-password") || (typeof text === "string" && /incorrect (room )?password/i.test(text));
      if (wrongPassword) console.debug("room-connect-failed (wrong password)", p);
      else console.error("room-connect-failed", p);
      refreshRooms();
    });
    listen("presence-updated", () => {
      // Cheapest correct response is a full refetch rather than patching one
      // row. Streams too: OUTGOING labels carry the room name, which can
      // change (rename, or a joiner adopting the name from a peer's hello).
      refreshAll();
      if (window.StreamControl) window.StreamControl.refresh();
      if (window.ViewTab) window.ViewTab.refresh();
    });
    listen("destination-state-changed", () => {
      refreshStreams();
      if (window.StreamControl) window.StreamControl.refresh();
    });
    // A staged capture came up (`starting` -> `ready`) or disappeared (went
    // live, or was cancelled).
    listen("staged-capture-changed", () => {
      if (window.StreamControl) window.StreamControl.refresh();
    });
    listen("stream-stats-updated", (event) => {
      // Fires ~4x/sec, not diffed — this must stay cheap. Each owner patches
      // just its own DOM in place (direct `textContent` writes), never a
      // re-render.
      if (window.StreamControl && window.StreamControl.updateStats) window.StreamControl.updateStats(event.payload);
      if (window.ViewTab && window.ViewTab.updateStats) window.ViewTab.updateStats(event.payload);
    });
    // Peer connectivity: `{ roomId, peerId, peerName }`.
    listen("peer_unreachable", (event) => peerUnreachable(event.payload));
    listen("peer_connected", (event) => peerConnected(event.payload));
    listen("peer_left", (event) => peerConnected(event.payload));
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  async function init() {
    renderNav();
    await refreshRooms();
    renderAddRoomCard();
    await refreshStreams();
    wireEvents();

    document.getElementById("add-room-btn").addEventListener("click", () => {
      state.addRoomOpen = true;
      state.addRoomTab = "join"; // Join is always the pre-selected tab on open.
      state.addRoomCreated = null;
      renderAddRoomCard(true);
    });

    // Clicking the scrim closes the room panel. `#room-panel` sits inside
    // `#room-panel-scrim`, so a click anywhere in the panel bubbles here — the
    // `e.target.id` check limits "closes" to a click on the scrim itself.
    document.getElementById("room-panel-scrim").addEventListener("click", (e) => {
      if (e.target.id === "room-panel-scrim") closeRoomPanel();
    });

    // ESC closes the frontmost thing: the leave modal (it renders on top of
    // the panel), else the room panel.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.pendingLeaveRoomId) {
        state.pendingLeaveRoomId = null;
        renderLeaveModal();
      } else if (state.activeRoomPanel) {
        closeRoomPanel();
      }
    });

    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = panel.dataset.tab !== state.activeTab;
    });

    initRangeFill();
  }

  // -------------------------------------------------------------------
  // Slider fill. Chromium can't paint an accent fill up to a range input's
  // thumb natively, so the value is published as a percentage in
  // `--range-pct` and CSS draws the fill as a hard-stop gradient on the
  // track. Delegated at the document and re-applied by a MutationObserver,
  // because the sliders are re-created wholesale by their tab's `render()`.
  // -------------------------------------------------------------------

  function paintRange(input) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const span = max - min;
    const pct = span > 0 ? ((Number(input.value) - min) / span) * 100 : 0;
    input.style.setProperty("--range-pct", pct.toFixed(2) + "%");
  }

  let rangeDelegated = false;

  function initRangeFill() {
    document.querySelectorAll('input[type="range"]').forEach(paintRange);
    if (rangeDelegated) return;
    rangeDelegated = true;

    // Drag/keyboard updates.
    document.addEventListener("input", (e) => {
      if (e.target && e.target.matches && e.target.matches('input[type="range"]')) paintRange(e.target);
    });

    // Initial paint for sliders that appear later.
    new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches('input[type="range"]')) paintRange(node);
          node.querySelectorAll && node.querySelectorAll('input[type="range"]').forEach(paintRange);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  window.Shell = {
    refreshRooms,
    refreshStreams,
    refreshAll,
    paintRanges: initRangeFill,
    // Console-callable handlers for the `peer_unreachable` / `peer_connected`
    // events (also what the real listeners call).
    peerUnreachable,
    peerConnected,
  };

  document.addEventListener("DOMContentLoaded", init);
})();
