#!/bin/bash
# Copies the browser-only P2P backend (and the few shared assets) from frontend/ into docs/,
# which is what GitHub Pages serves. The copies are NEVER edited by hand.
#   tools/sync-web.sh           copy
#   tools/sync-web.sh --check   exit 1 if any copy is missing or differs (no writes)
set -u
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
FILES=(
  p2p/core.js
  p2p/sharecode.js
  vendor/trystero.mjs
  styles/tokens.css
  fonts/Geist-Regular.ttf
  fonts/Geist-Bold.ttf
  fonts/GeistMono-Regular.ttf
  assets/icons/mark-32.png
  assets/icons/mark-256.png
)
# source path under frontend/ -> destination under docs/ (assets/icons/* lands in docs/assets/)
dest() { case "$1" in assets/icons/*) echo "assets/$(basename "$1")";; *) echo "$1";; esac; }

bad=0
for f in "${FILES[@]}"; do
  src="$ROOT/frontend/$f"; dst="$ROOT/docs/$(dest "$f")"
  if [ ! -f "$src" ]; then echo "sync-web: missing source $src" >&2; bad=1; continue; fi
  if [ "${1:-}" = "--check" ]; then
    cmp -s "$src" "$dst" || { echo "sync-web: OUT OF DATE docs/$(dest "$f") (run tools/sync-web.sh)" >&2; bad=1; }
  else
    mkdir -p "$(dirname "$dst")" && cp -f "$src" "$dst" && echo "synced docs/$(dest "$f")"
  fi
done
[ "${1:-}" = "--check" ] && [ $bad = 0 ] && echo "sync-web: docs/ copies are up to date"
exit $bad
