#!/bin/sh
# tools/build.sh - "build" = gzip to the exact filename the SPA requests.
# nginx `gzip_static on` serves this .gz for /views/gl-sdk4-ui-mudimodem.common.js
set -eu
cd "$(dirname "$0")/.."
mkdir -p build
gzip -9 -n -c src/views/mudimodem.js > build/gl-sdk4-ui-mudimodem.common.js.gz
cp src/menu/mudimodem.json build/mudimodem.json 2>/dev/null || true
gzip -9 -n -c src/views/mudimodem-tracking.js > build/gl-sdk4-ui-mudimodem-tracking.common.js.gz
cp src/menu/mudimodem-tracking.json build/mudimodem-tracking.json 2>/dev/null || true
ls -l build/
