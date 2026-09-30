// Electron main process for p2p-screensharing.
//
// No sidecar, no server: the renderer does everything (capture via
// getDisplayMedia, media over Chromium-native WebRTC). This process only
// creates windows and grants display capture. Pop-out viewer windows are
// opened by the renderer with window.open (see openHandler below).

"use strict";

const { app, BrowserWindow, Menu, session, desktopCapturer } = require("electron");
const path = require("path");

// ---------------------------------------------------------------------
// Chromium switches - MUST be set before app.whenReady().
// NOTE: appendSwitch("enable-features", ...) overwrites on repeat, so ALL
// enabled features go in the single list. Verified on Electron 43.7.7:
//  - AcceleratedVideoEncoder is the only switch H.264 VA-API encode needs
//    (encoderImplementation: VaapiVideoEncodeAccelerator). VaapiVideoEncoder/
//    VaapiVideoDecoder are obsolete no-ops.
//  - PulseaudioLoopbackForScreenShare: best-effort system audio on Linux.
//  - Do NOT add disable-accelerated-video-decode: it also breaks VA-API *encode* (the GPU process then finds
//    no render node and the H.264 sender falls back to OpenH264). See disable-features below for the decode fix.
//  - No frame-rate-limit / vsync switches: they only make rAF spin (~9 kHz)
//    and do not raise capture fps.
// ---------------------------------------------------------------------
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "AcceleratedVideoEncoder,PulseaudioLoopbackForScreenShare");
  // VA-API 1080p H.264 decode through the GL path silently produces no frames (framesDecoded stays 0, every
  // frame dropped, sender keeps sending) for the stream our VA-API *encoder* sends; 960x540 and below decode fine.
  // Reproduced 5/5 with two instances on one machine (headless sway/Xwayland, Electron 43.7.7). Disabling ONLY this
  // feature fixes it (1080p60 decodes, ~1 ms/frame) and leaves VA-API *encode* intact. The earlier workaround
  // "disable-accelerated-video-decode" also stopped VA-API init in the GPU process, which killed the encoder.
  app.commandLine.appendSwitch("disable-features", "AcceleratedVideoDecodeLinuxGL");
}
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
// Low-latency video pacing (measured: viewer delay after a static->motion burst 875 ms -> ~190 ms): libwebrtc paces
// video at only 1.1x the send-side BWE target. After a static screen the first frames of new motion are
// huge (scene change), so they queue in the sender's pacer for 0.5-1 s and then drain at once ("delayed, then
// catches up"). factor:2.5 is the pacing multiplier the rest of GCC is tuned for; max_delay:250 makes the
// pacer drain faster whenever packets would wait >250 ms (default 2000 ms) instead of queueing seconds of video.
// Field trial name/values are libwebrtc's (WebRTC-Video-Pacing, video/video_send_stream_impl.cc).
// P2P_FT (testing only) is appended as further trials.
app.commandLine.appendSwitch("force-fieldtrials", "WebRTC-Video-Pacing/factor:2.5,max_delay:250/" + (process.env.P2P_FT || ""));

// Packaged (AppImage) vs dev path resolution: when packaged, the sibling
// ../frontend dir is not next to __dirname (inside app.asar); electron-builder's
// extraResources (electron/package.json "build") copies it to
// process.resourcesPath/frontend instead.
const FRONTEND_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "frontend")
  : path.join(__dirname, "..", "frontend");
const FRONTEND_INDEX = path.join(FRONTEND_DIR, "index.html");
const { fileURLToPath } = require("url");
const VIEWER_PATH = path.join(FRONTEND_DIR, "viewer.html");
const APP_ICON = path.join(FRONTEND_DIR, "assets", "icons", "mark-256.png");

let mainWindow = null;

// ---------------------------------------------------------------------
// URL / permission policy
// ---------------------------------------------------------------------

/** Parsed file: URL -> absolute filesystem path, or null if it is not a file: URL. */
function filePathOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "file:" ? fileURLToPath(u) : null;
  } catch (_) {
    return null;
  }
}

/** True for file: URLs that point inside the app's own frontend directory. */
function isAppUrl(url) {
  const p = filePathOf(url);
  if (p === null) return false;
  const rel = path.relative(FRONTEND_DIR, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** True only for viewer.html itself (query/hash allowed). */
function isViewerUrl(url) {
  const p = filePathOf(url);
  return p !== null && path.normalize(p) === VIEWER_PATH;
}

// Only what the app needs:
//  media / display-capture: getDisplayMedia (+ loopback audio) for sharing
//  fullscreen:              tile double-click + viewer pop-out F11 (Fullscreen API)
//  clipboard-sanitized-write: navigator.clipboard.writeText (Copy button)
// Everything else (notifications, geolocation, clipboard-read, midi, hid, usb, ...) is denied.
const ALLOWED_PERMISSIONS = new Set(["media", "display-capture", "fullscreen", "clipboard-sanitized-write"]);

function installPermissionHandlers() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || webContents.getURL();
    const ok = ALLOWED_PERMISSIONS.has(permission) && isAppUrl(url);
    if (!ok) console.warn("[electron] permission denied:", permission, url);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const url = (details && details.requestingUrl) || requestingOrigin || "";
    return ALLOWED_PERMISSIONS.has(permission) && (isAppUrl(url) || url === "file:///" || url === "file://");
  });
}

// Applied to EVERY webContents (main window, pop-outs, anything else): no navigation away from the app's own
// files, no <webview>, and no further windows by default. createWindow() then overrides the window-open
// handler for the main window only, to allow exactly viewer.html.
app.on("web-contents-created", (_event, contents) => {
  const block = (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      console.warn("[electron] blocked navigation to", url);
    }
  };
  contents.on("will-navigate", (event, url) => block(event, url));
  contents.on("will-redirect", (event, url) => block(event, url));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});

// ---------------------------------------------------------------------
// Display capture: makes renderer navigator.mediaDevices.getDisplayMedia() work.
// ---------------------------------------------------------------------

function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      // Only reached when the OS/system picker is unavailable or unsupported:
      // grant the first screen (plus loopback system audio, best effort on Linux).
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
        const screen = sources.find((s) => s.id.startsWith("screen:")) || sources[0];
        if (!screen) return callback({});
        callback(process.platform === "win32" || process.platform === "linux" ? { video: screen, audio: "loopback" } : { video: screen });
      } catch (err) {
        console.error("[electron] getDisplayMedia source lookup failed:", err);
        callback({});
      }
    },
    { useSystemPicker: true }
  );
}

// ---------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    title: "p2p-screensharing",
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Pop-outs are opened by view.js with window.open("viewer.html?...") from
  // the main window: a MediaStream cannot be sent to another BrowserWindow, so
  // the pop-out has to be a same-process child that reads the stream from
  // window.opener.P2P. Only viewer.html may be opened this way. The child needs
  // no preload (fullscreen is the web Fullscreen API, closing is
  // window.close()).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isViewerUrl(url)) return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 640,
        height: 400,
        title: "p2p-screensharing - Stream",
        icon: APP_ICON,
        autoHideMenuBar: true,
      },
    };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // Pop-outs read their stream from the main window; without it they are dead.
    for (const win of BrowserWindow.getAllWindows()) win.close();
  });
  mainWindow.loadFile(FRONTEND_INDEX);
}

// ---------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  installPermissionHandlers();
  installDisplayMediaHandler();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
