# P2P Screensharing

A serverless peer-to-peer screensharing desktop app (Electron + WebRTC via Trystero). Rooms are joined with a single
share code; signalling is end-to-end encrypted with a password derived from that code. On Linux, H.264 encoding is
hardware-accelerated through VA-API.

## Run / build

```sh
cd electron && npm install && npm start     # run the app
npm run build:appimage                      # (in electron/) build the AppImage into electron/dist
```

## Tests

```sh
cd tests && npm install && npm test
```

Runs headless in a private sway session (nothing appears on your display). Needs `sway` and Xwayland installed.
See `tests/README.md`.

## Web client

`docs/` is a static, build-free browser client for the same rooms (publishable via GitHub Pages from the `/docs`
folder). Its P2P backend files are copies of `frontend/`; after changing them run `tools/sync-web.sh`
(`--check` verifies). See `docs/README.md`.

## Known limits

- Linux/Wayland capture is limited to ~90 fps (xdg-desktop-portal-hyprland).
- No default TURN server; peers behind strict NATs may fail to connect.
