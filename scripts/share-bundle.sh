#!/bin/sh
# Build the share zip for a release: signed .xpi (Firefox/Zen) + the extension folder
# (Chromium, load unpacked) + native host + README + HOW-TO-USE.
# Usage: sh scripts/share-bundle.sh [version]   (default: version in extension/manifest.json)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:-$(python3 -c "import json;print(json.load(open('$ROOT/extension/manifest.json'))['version'])")}"
XPI="$(ls "$ROOT"/extension/web-ext-artifacts/*-"$VER".xpi 2>/dev/null | head -1 || true)"
[ -n "$XPI" ] || { echo "no signed .xpi for $VER in extension/web-ext-artifacts/ — run web-ext sign first" >&2; exit 1; }
NAME="logseq-expanded-clipper-$VER"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME/native-host" "$STAGE/$NAME/chromium"
cp "$XPI" "$STAGE/$NAME/$NAME.xpi"
cp "$ROOT"/native-host/install.sh "$ROOT"/native-host/lqc_host.py "$ROOT"/native-host/logseq-extracted "$STAGE/$NAME/native-host/"
cp "$ROOT/README.md" "$ROOT/docs/HOW-TO-USE.md" "$STAGE/$NAME/"
(cd "$ROOT/extension" && find . -path ./web-ext-artifacts -prune -o -type f -print | grep -v -E '^\./\.' | cpio -pdm --quiet "$STAGE/$NAME/chromium")
OUT="$ROOT/web-ext-artifacts/$NAME.zip"; mkdir -p "$ROOT/web-ext-artifacts"; rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" "$NAME")
echo "$OUT"; unzip -l "$OUT" | tail -1
