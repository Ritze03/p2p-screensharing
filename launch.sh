#!/usr/bin/env bash
set -euo pipefail
command -v npm >/dev/null 2>&1 || { echo "Node.js/npm is required" >&2; exit 1; }
cd "$(dirname "$(readlink -f "$0")")/electron"
if [ ! -d node_modules ] || [ ! -e node_modules/.bin/electron ]; then
  npm install
fi
exec npm start -- "$@"
