// tauri-shim.js - Electron adapter: makes the GUI's `window.__TAURI__` gate talk
// to the browser-only P2P core. This is the ONLY file that knows about the GUI.
//
// Install (frontend/index.html) - this module MUST run before any GUI script:
//
//   <script type="module" src="p2p/tauri-shim.js"></script>   <!-- FIRST -->
//   <script defer src="scripts/components.js"></script>       <!-- then every classic script with `defer` -->
//   ...
//
// Module scripts are deferred; deferred classic scripts run in document order
// together with them, before DOMContentLoaded. A plain (non-defer) classic
// script would run BEFORE the module, i.e. see no window.__TAURI__.
// The shim sets its globals synchronously on evaluation (no top-level await);
// `invoke` internally waits for saved rooms to load.
//
// Globals installed:
//   window.__TAURI__ = { core: { invoke(name, args) }, event: { listen(name, cb) } }
//   window.P2P       = { getStream(roomId, owner, streamId), onStream(cb), onStreamRemoved(cb),
//                        getStreams(), selfId, APP_ID, supportedCodecs(), ... }   (see core.js)
//   window.__P2P_BACKEND__ = the raw backend (debug / tests)

import { createBackend } from './core.js';

const backend = createBackend();

window.__TAURI__ = {
  core: { invoke: (name, args) => backend.invoke(name, args) },
  event: { listen: (name, cb) => backend.listen(name, cb) },
};
window.P2P = backend.P2P;
window.__P2P_BACKEND__ = backend;
