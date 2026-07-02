#!/bin/sh
# Install the Logseq Quick Capture native messaging host.
#
# Layout (verified against plain Firefox conventions and flatpak Zen Browser):
#   ~/.local/share/logseq-quick-capture/lqc_host.py   the host (runs on the host system)
#   ~/.mozilla/native-messaging-hosts/
#     logseq_quick_capture.json                       manifest (browsers read this path,
#                                                     Zen included — it does NOT use ~/.zen)
#     lqc-host-wrapper.sh                             sandbox-aware launcher: inside a
#                                                     flatpak it relays via flatpak-spawn
#
# Flatpak browsers additionally need two overrides (printed at the end):
#   - talk access to org.freedesktop.Flatpak (lets the sandbox spawn the host script)
#   - read-only access to ~/.mozilla/native-messaging-hosts (lets it find the manifest)

set -eu

HOST_NAME="logseq_quick_capture"
EXT_ID="logseqexpandedclipper@brerlapn.org"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.local/share/logseq-quick-capture"
HOST_PATH="$INSTALL_DIR/lqc_host.py"
MOZ_DIR="$HOME/.mozilla/native-messaging-hosts"
ZEN_APP="app.zen_browser.zen"

mkdir -p "$INSTALL_DIR" "$MOZ_DIR"

install -m 755 "$SRC_DIR/lqc_host.py" "$HOST_PATH"
echo "Installed host script: $HOST_PATH"

WRAPPER="$MOZ_DIR/lqc-host-wrapper.sh"
cat > "$WRAPPER" <<'EOF'
#!/bin/sh
# Inside a flatpak browser sandbox, relay to the host-side script;
# flatpak-spawn is present in flatpak runtimes.
if [ -e /.flatpak-info ]; then
  exec flatpak-spawn --host "$HOME/.local/share/logseq-quick-capture/lqc_host.py" "$@"
fi
exec "$HOME/.local/share/logseq-quick-capture/lqc_host.py" "$@"
EOF
chmod 755 "$WRAPPER"
echo "Installed wrapper: $WRAPPER"

cat > "$MOZ_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Logseq CLI bridge for Logseq Quick Capture",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF
echo "Installed manifest: $MOZ_DIR/$HOST_NAME.json"

if flatpak info "$ZEN_APP" >/dev/null 2>&1; then
    echo ""
    echo "Flatpak Zen Browser detected. Grant it access (once), then restart Zen:"
    echo ""
    echo "  flatpak override --user --talk-name=org.freedesktop.Flatpak $ZEN_APP"
    echo "  flatpak override --user --filesystem=$MOZ_DIR:ro $ZEN_APP"
    echo ""
    echo "Note: the first override lets the Zen sandbox launch host commands via"
    echo "flatpak-spawn — a deliberate sandbox widening; skip it if that is not"
    echo "acceptable and the extension will stay on the HTTP baseline."
fi

echo "Done."
