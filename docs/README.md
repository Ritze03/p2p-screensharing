# P2P Screensharing - web client

A static, build-free web client for the same P2P rooms as the desktop app. Same share codes, same rooms,
desktop and browser can watch each other both ways. `docs/` is the whole site (all URLs are relative, so it works
under any sub-path such as `https://<user>.github.io/<repo>/`).

## Publish on GitHub Pages

Repository **Settings -> Pages -> Build and deployment**: Source *Deploy from a branch*, Branch `main`, folder `/docs`.
`docs/.nojekyll` is already there. Pages serves https, which `getDisplayMedia` and Web Crypto need.

## Run locally

```sh
python3 -m http.server --bind 127.0.0.1 8080 -d docs     # then open http://127.0.0.1:8080/
```

`localhost` / `127.0.0.1` count as a secure context; any other plain-http host does not (the page then says so).

## Keep the backend copies in sync

The P2P backend is shared with the desktop app, not forked. `docs/p2p/`, `docs/vendor/`, `docs/styles/tokens.css`,
`docs/fonts/` and `docs/assets/` are **copies** of files under `frontend/`. Never edit them by hand:

```sh
tools/sync-web.sh            # after changing frontend/p2p (or vendor/tokens/fonts): copy into docs/
tools/sync-web.sh --check    # exit 1 if a copy is missing or differs (for CI / pre-commit)
```

Web-only files: `index.html`, `app.js`, `styles/app.css`, `styles/fonts.css`, `test-capture.js`
(test hook, only loaded with `?testCapture=canvas`).

## Capabilities (what the browser allows)

- Watching: any stream, up to whatever the sender encodes (240 fps included). The `<video>` is never throttled:
  no per-frame JS, no jitter-buffer or receiver constraints; the stats overlay updates from the backend's 1 s event.
- Sharing: desktop browsers only (the Share panel is hidden where `getDisplayMedia` is missing, e.g. phones).
  15 / 30 / 60 fps and a bitrate slider; codecs are whatever `RTCRtpSender.getCapabilities` offers.
  Audio depends on browser and OS (none in Firefox; on Linux Chromium only tab audio).
- Saved rooms (they contain the secret share code) and settings live in this browser's `localStorage`.

## Headless tests

Browser <-> desktop app interop, 240 fps, wrong password, sub-path (needs `sway` + the Electron binary, like `tests/`):

```sh
bash tests/headless/run.sh node tools/web-e2e.mjs                 # all of: a b c d e f
bash tests/headless/run.sh node tools/web-e2e.mjs c --fps=240 --w=1280 --h=720 --shots=/some/dir
```

Everything runs inside the private headless sway of `tests/headless/run.sh` with headless Chromium; nothing
opens on your display and no sound is played (`--mute-audio`). See the header of `tools/web-e2e.mjs` for options.
