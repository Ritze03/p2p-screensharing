#!/bin/bash
# usage: run.sh <command...>
# Runs <command> inside a fully private headless sway (+Xwayland) on a private, service-less dbus session.
#  - env -i: nothing of the user's Hyprland/pipewire/pulse/portal session is visible to the inner tree
#    (an inherited WAYLAND_DISPLAY once made a portal start on the real display).
#  - private XDG_RUNTIME_DIR (0700), created per run, removed after.
#  - teardown kills tracked PIDs (inner setsid process group + sway.pid), then sweeps by PID (everything whose environ carries our private XDG_RUNTIME_DIR), never pkill -f.
# Debug: P2P_E2E_LEAK_TEST=1 forces WAYLAND_DISPLAY into the inner env to prove the leak guard fails fast.
# A script started with `&` from a non-interactive shell inherits SIGINT=SIG_IGN, and bash cannot trap an
# inherited-ignored signal, so `kill -INT` would skip cleanup. Re-exec once with SIGINT reset to default.
if [ -z "$P2P_RUN_REEXEC" ] && command -v perl >/dev/null; then
  export P2P_RUN_REEXEC=1
  exec perl -e '$SIG{INT}="DEFAULT"; exec @ARGV' bash "$0" "$@"
fi
unset P2P_RUN_REEXEC
HERE="$(dirname "$(readlink -f "$0")")"
RT="$(mktemp -d /tmp/p2p-e2e-rt.XXXXXX)" || exit 1
chmod 700 "$RT"

cleanup() {
  trap - EXIT INT TERM
  # 1) tracked PIDs: the inner process group (setsid, PGID == $CH) and sway's recorded PID
  SWP=$(cat "$RT/sway.pid" 2>/dev/null)
  for sig in TERM KILL; do
    [ -n "$CH" ] && kill -$sig -- "-$CH" 2>/dev/null
    [ -n "$CH" ] && kill -$sig "$CH" 2>/dev/null
    [ -n "$SWP" ] && kill -$sig "$SWP" 2>/dev/null
    # 2) secondary sweep: anything whose readable environ carries our private XDG_RUNTIME_DIR
    pids=""
    for e in /proc/[0-9]*/environ; do
      p=${e#/proc/}; p=${p%/environ}
      [ "$p" = "$$" ] && continue
      { tr '\0' '\n' <"$e" | grep -qxF "XDG_RUNTIME_DIR=$RT" && pids="$pids $p"; } 2>/dev/null
    done
    [ -n "$pids" ] && kill -$sig $pids 2>/dev/null
    [ "$sig" = TERM ] && sleep 1
  done
  rm -rf "$RT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PASS=(); for v in P2P_E2E_MAIN P2P_FT CI DEBUG PWDEBUG; do [ -n "${!v+x}" ] && PASS+=("$v=${!v}"); done
[ -n "$P2P_E2E_LEAK_TEST" ] && PASS+=("WAYLAND_DISPLAY=wayland-1")

setsid env -i "${PASS[@]}" PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" XDG_RUNTIME_DIR="$RT" \
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=gles2 HERE="$HERE" P2P_E2E_HEADLESS=1 \
  dbus-run-session --config-file="$HERE/dbus.conf" -- bash -c '
    # leak guard: nothing of the real session may be visible in here
    for v in WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE DISPLAY; do
      [ -n "${!v}" ] && { echo "headless: LEAK: $v=${!v} is set in the inner env" >&2; exit 97; }
    done
    case "$XDG_RUNTIME_DIR" in /run/user/*) echo "headless: LEAK: XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >&2; exit 97;; esac
    if env | grep -q "/run/user/"; then echo "headless: LEAK: /run/user/ referenced in inner env" >&2; exit 97; fi
    sway -c "$HERE/sway.conf" >"$XDG_RUNTIME_DIR/sway.log" 2>&1 &
    SW=$!; echo $SW >"$XDG_RUNTIME_DIR/sway.pid"
    for i in $(seq 1 50); do [ -s "$XDG_RUNTIME_DIR/display" ] && break; sleep 0.2; done
    [ -s "$XDG_RUNTIME_DIR/display" ] || { echo "headless: sway did not come up:" >&2; cat "$XDG_RUNTIME_DIR/sway.log" >&2; exit 98; }
    export DISPLAY=$(cat "$XDG_RUNTIME_DIR/display")
    echo "headless: DISPLAY=$DISPLAY XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >&2
    "$@"; rc=$?
    kill $SW 2>/dev/null; wait $SW 2>/dev/null
    exit $rc
  ' bash "$@" &
CH=$!
wait $CH
rc=$?
exit $rc
