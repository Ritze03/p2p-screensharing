# vendor/

`trystero.mjs` - Trystero **0.25.4** (MIT), the default Nostr-signalling build, as ONE
self-contained minified ES module (no imports; loads from `file://` in Electron and from
any static host). Do not use a CDN `+esm` URL: it is not self-contained.

Rebuild (exact):

```sh
mkdir build && cd build && npm init -y
npm i trystero@0.25.4 esbuild
echo 'export * from "trystero";' > entry.js
npx esbuild entry.js --bundle --format=esm --minify --outfile=<project>/frontend/vendor/trystero.mjs
```

Exports used: `joinRoom`, `selfId`.
