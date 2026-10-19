#!/bin/bash
# The store zip must have manifest.json at the root, no "key", and everything else intact.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
sh "$ROOT/scripts/package-chromium.sh" "$TMP/out.zip" >/dev/null
(cd "$TMP" && unzip -q out.zip -d unz)
python3 -I - "$ROOT/extension/manifest.json" "$TMP/unz/manifest.json" <<'PY'
import json, sys
src = json.load(open(sys.argv[1])); out = json.load(open(sys.argv[2]))
assert "key" not in out, "key survived"
src.pop("key", None)
assert src == out, "manifest changed beyond key removal"
for k in ("background", "permissions", "host_permissions", "optional_permissions", "action", "commands"):
    assert k in out, f"missing {k}"
assert out["background"]["service_worker"] == "background/service-worker.js"
PY
for f in background/service-worker.js content/modal.js options/options.html options/options.js options/options.css icons/icon128.png; do
  cmp -s "$ROOT/extension/$f" "$TMP/unz/$f" || { echo "differs: $f"; exit 1; }
done
[ ! -e "$TMP/unz/.amo-upload-uuid" ] && [ ! -e "$TMP/unz/web-ext-artifacts" ]
echo "package_chromium_test: all checks passed"
