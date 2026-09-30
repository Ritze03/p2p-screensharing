# Tests

- `npm test` runs the unit tests, then the e2e suite **headless**: `headless/run.sh` starts a private sway
  (headless backend, 1920x1080, Xwayland) under `env -i` with its own `XDG_RUNTIME_DIR` and a service-less
  D-Bus session, runs Playwright + Electron (`--ozone-platform=x11`, X11 screen capture, no portal) inside
  it, then kills everything by PID and deletes the runtime dir. Nothing appears on your display, focus is
  untouched and your screen-share portal is never contacted. The wrapper aborts if `WAYLAND_DISPLAY`,
  `HYPRLAND_INSTANCE_SIGNATURE` or `/run/user/*` leak into the inner environment.
- `npm run test:e2e` runs only the e2e suite (also headless); extra args: `npm run test:e2e -- e2e/launch.spec.mjs`.
- Opt-out: `npm run test:display` runs on the real Hyprland display (Wayland portal capture with the auto share
  picker; windows appear and steal focus). A bare `npx playwright test` is refused by `headless/guard.mjs`.
- Needs `sway`, `dbus-run-session`, and the Electron binary in `electron/node_modules`. Debug: `P2P_E2E_LEAK_TEST=1`
  forces a leak to prove the guard fails fast.

