// settings.js — Settings tab content: display name and the optional TURN
// relay.
//
//   get_settings()         -> { displayName, turnUrl, turnUsername, turnPassword }
//   set_settings(partial)  -> merges the given fields into the stored settings
//
// TURN is optional: with `turnUrl` empty the app connects peers directly.
// (There is deliberately no language setting: the frontend has no i18n layer —
// the old one lived in the Rust locales — so a language switch would do
// nothing.)

(function () {
  "use strict";

  const { el, card, icon } = window.Components;

  const DEFAULT_SETTINGS = {
    displayName: "",
    turnUrl: "",
    turnUsername: "",
    turnPassword: "",
  };

  const TURN_URL_SHAPE = /^turns?:\S+$/i;

  let state = Object.assign({}, DEFAULT_SETTINGS);

  function pickSettings(raw) {
    const out = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = typeof (raw || {})[key] === "string" ? raw[key] : DEFAULT_SETTINGS[key];
    return out;
  }

  async function fetchSettings() {
    return pickSettings(await window.__TAURI__.core.invoke("get_settings"));
  }

  /** Persists a partial settings update and mirrors it into local `state`.
   * Deliberately does NOT re-render: rebuilding the tab on every save would
   * drop keyboard focus when tabbing from one field to the next. */
  async function saveSettings(partial) {
    await window.__TAURI__.core.invoke("set_settings", partial);
    Object.assign(state, partial);
  }

  function render() {
    const root = document.getElementById("settings-root");
    if (!root) return;
    root.innerHTML = "";

    // -- DISPLAY NAME -------------------------------------------------------
    // The one name shown to everyone in every room. Saved on blur/Enter
    // (`change`), not on every keystroke.
    const nameInput = el("input", {
      className: "field-input settings-name-input",
      attrs: { type: "text", placeholder: "e.g. mo", value: state.displayName || "" },
    });
    nameInput.addEventListener("change", () => saveSettings({ displayName: nameInput.value.trim() }));

    const nameBlurb = el("p", {
      className: "settings-blurb",
      text: "Shown to everyone when you join or create a room — one name for every room, not asked each time.",
    });

    // -- TURN -----------------------------------------------------------------
    const turnUrl = el("input", {
      className: "field-input field-input-mono",
      attrs: { type: "text", placeholder: "turn:turn.example.com:3478", value: state.turnUrl, spellcheck: "false", autocomplete: "off", "aria-label": "TURN URL" },
    });
    const turnUser = el("input", {
      className: "field-input",
      attrs: { type: "text", value: state.turnUsername, spellcheck: "false", autocomplete: "off", "aria-label": "TURN username" },
    });
    const turnPass = el("input", {
      className: "field-input settings-password-input",
      attrs: { type: "password", value: state.turnPassword, spellcheck: "false", autocomplete: "new-password", "aria-label": "TURN password" },
    });

    // Show/hide toggle for the password.
    const revealBtn = el("button", {
      className: "btn btn-icon settings-reveal-btn",
      attrs: { type: "button", title: "Show password", "aria-label": "Show password" },
    });
    revealBtn.appendChild(icon("visibility"));
    revealBtn.addEventListener("click", () => {
      const show = turnPass.type === "password";
      turnPass.type = show ? "text" : "password";
      revealBtn.innerHTML = "";
      revealBtn.appendChild(icon(show ? "visibility_off" : "visibility"));
      revealBtn.title = revealBtn.ariaLabel = show ? "Hide password" : "Show password";
    });
    const passWrap = el("div", { className: "settings-password-wrap" }, [turnPass, revealBtn]);

    const status = el("span", { className: "settings-save-status", attrs: { role: "status" } });
    let statusTimer = null;
    const showStatus = (text, isError) => {
      status.textContent = text;
      status.classList.toggle("settings-save-status-error", !!isError);
      clearTimeout(statusTimer);
      if (text && !isError) statusTimer = setTimeout(() => (status.textContent = ""), 2000);
    };

    const saveTurn = async () => {
      const url = turnUrl.value.trim();
      if (url && !TURN_URL_SHAPE.test(url)) {
        showStatus("The URL should look like turn:host:3478 (or turns:…).", true);
        return;
      }
      turnUrl.value = url;
      if (url && (!turnUser.value.trim() || !turnPass.value)) {
        showStatus("A TURN URL needs both a username and a password.", true);
        return;
      }
      try {
        await saveSettings({ turnUrl: url, turnUsername: turnUser.value.trim(), turnPassword: turnPass.value });
        showStatus("Saved");
      } catch (e) {
        showStatus(`Could not save: ${e && e.message ? e.message : e}`, true);
      }
    };
    [turnUrl, turnUser, turnPass].forEach((input) => {
      input.addEventListener("change", saveTurn);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveTurn();
      });
    });

    const field = (label, control) => el("div", { className: "settings-field" }, [el("label", { className: "field-label", text: label }), control]);

    const turnBlurb = el("p", {
      className: "settings-blurb",
      text: "Only needed if peers can't connect directly. Leave empty for direct P2P. Changes apply after you leave all rooms or restart the app.",
    });
    const turnActions = el("div", { className: "settings-actions" }, [
      el("button", { className: "btn btn-secondary", text: "Save", attrs: { type: "button" }, onClick: saveTurn }),
      status,
    ]);

    // -- About ------------------------------------------------------------
    // Deliberately no version number: nothing exposes the real one to the
    // frontend, and a made-up one is worse than none.
    const about = el("div", { className: "card settings-about" }, [
      el("span", { className: "material-symbols-outlined settings-about-icon", text: "info" }),
      el("span", {
        className: "settings-about-text",
        text: "P2P Screensharing — streams go directly between peers. Nothing but your preferences and room list is stored on this machine.",
      }),
    ]);

    const grid = el("div", { className: "settings-grid" });
    grid.appendChild(card("DISPLAY NAME", [nameInput, nameBlurb]));
    grid.appendChild(
      card("TURN", [field("URL", turnUrl), field("Username", turnUser), field("Password", passWrap), turnBlurb, turnActions], {
        className: "settings-turn-card",
      })
    );
    grid.appendChild(about);
    root.appendChild(grid);
  }

  async function init() {
    state = await fetchSettings();
    render();
  }

  window.Settings = { getDisplayName: () => state.displayName, get: () => Object.assign({}, state) };

  document.addEventListener("DOMContentLoaded", init);
})();
