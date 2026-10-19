#!/bin/sh
# Build the Chrome Web Store upload zip from extension/.
#
# The store rejects a manifest that carries "key" ("key field is not allowed in
# manifest", 2026-10-19). The development manifest keeps the key so unpacked
# installs get a stable ID; this script strips it for the upload only. Nothing
# else is rewritten, so the store build is otherwise byte-identical to the tree.
#
# Usage: sh scripts/package-chromium.sh [out.zip]
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$ROOT/extension/manifest.json")"
OUT="${1:-$ROOT/web-ext-artifacts/logseq-expanded-clipper-chromium-$VERSION.zip}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/ext"
for d in background content icons options; do cp -R "$ROOT/extension/$d" "$STAGE/ext/$d"; done
python3 -I - "$ROOT/extension/manifest.json" "$STAGE/ext/manifest.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
m.pop("key", None)
json.dump(m, open(sys.argv[2], "w"), indent=2)
PY

mkdir -p "$(dirname "$OUT")"; rm -f "$OUT"
(cd "$STAGE/ext" && zip -qr "$OUT" manifest.json background content icons options -x '*/.*' '.*')
echo "$OUT"
