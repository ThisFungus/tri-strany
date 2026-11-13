#!/bin/sh
# Builds the GitHub Pages site into $1 (default _site): index.html is the artifact page body,
# wrapped in a full document, plus PeerJS and p2p.js, which replace the artifact db with peer-to-peer sync.
set -e
cd "$(dirname "$0")/.."
out=${1:-_site}
rm -rf "$out"; mkdir -p "$out"
cp app.js game.js questions.js p2p.js sound.js "$out"/
{
  printf '<!doctype html>\n<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n'
  sed 's|<script src="questions.js"></script>|<script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>\n<script src="p2p.js"></script>\n&|' index.html
  printf '</body></html>\n'
} > "$out/index.html"
grep -q 'src="p2p.js"' "$out/index.html" || { echo "build-pages: p2p script tag not inserted" >&2; exit 1; }
