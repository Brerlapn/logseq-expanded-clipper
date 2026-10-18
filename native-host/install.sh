#!/bin/sh
# Install the Logseq Expanded Clipper native messaging host (host name stays logseq_quick_capture).
#
# Layout (verified against plain Firefox conventions and flatpak Zen Browser):
#   ~/.local/share/logseq-quick-capture/lqc_host.py   the host (runs on the host system)
#   ~/.mozilla/native-messaging-hosts/
#     logseq_quick_capture.json                       manifest (browsers read this path,
#                                                     Zen included — it does NOT use ~/.zen)
#     lqc-host-wrapper.sh                             sandbox-aware launcher: inside a
#                                                     flatpak it relays via flatpak-spawn
#
# Chromium-family browsers (Chrome, Chromium, Brave, Vivaldi; flatpak Chrome and
# Chromium) each get their own wrapper copy and a Chromium-format manifest
# (`allowed_origins`) in their per-user NativeMessagingHosts directory. Only the
# browsers actually present on this machine are touched.
#
# Flatpak browsers additionally need overrides (printed at the end):
#   - talk access to org.freedesktop.Flatpak (lets the sandbox spawn the host script)
#   - Zen only: read-only access to ~/.mozilla/native-messaging-hosts (lets it find the
#     manifest). Flatpak Chromium browsers keep their copy inside their own sandbox home
#     and need no filesystem override.
#
# Safety: refuses to run as root, and refuses to write under any directory (up to $HOME)
# that is world-writable or owned by another user. Manifests are 0644, wrapper/host 0755.

set -eu

HOST_NAME="logseq_quick_capture"
EXT_ID="logseqexpandedclipper@brerlapn.org"
CHROMIUM_EXT_ID="ojfmjhjcjgogodbfmnoepkdlacdmkbpn"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.local/share/logseq-quick-capture"
HOST_PATH="$INSTALL_DIR/lqc_host.py"
MOZ_DIR="$HOME/.mozilla/native-messaging-hosts"
ZEN_APP="app.zen_browser.zen"

# Chromium rows: label|config dir tail (under ~/.config)|flatpak app id or "-"
CHROMIUM_ROWS="Google Chrome|google-chrome|com.google.Chrome
Chromium|chromium|org.chromium.Chromium
Ungoogled Chromium|chromium|io.github.ungoogled_software.ungoogled_chromium
Brave|BraveSoftware/Brave-Browser|-
Vivaldi|vivaldi|com.vivaldi.Vivaldi"

if [ "$(id -u)" -eq 0 ]; then
    echo "install.sh: refusing to run as root; run it as the user whose browser will use the host." >&2
    exit 1
fi

# Refuse if DIR or any parent up to $HOME is world-writable or owned by someone else.
# Components that do not exist yet are skipped (mkdir -p creates them under our umask).
check_safe_path() {
    d="$1"
    while :; do
        if [ -e "$d" ]; then
            if [ -n "$(find "$d" -prune -perm -0002 2>/dev/null)" ]; then
                echo "install.sh: refusing to install: $d is world-writable." >&2
                exit 1
            fi
            if [ -n "$(find "$d" -prune ! -user "$(id -un)" 2>/dev/null)" ]; then
                echo "install.sh: refusing to install: $d is owned by another user." >&2
                exit 1
            fi
        fi
        case "$d" in
            "$HOME"|/) break ;;
        esac
        parent="$(dirname "$d")"
        [ "$parent" = "$d" ] && break
        d="$parent"
    done
}

# Detect Chromium targets. Emits lines: <NativeMessagingHosts dir>|<label>|<flatpak id or ->
chromium_targets() {
    printf '%s\n' "$CHROMIUM_ROWS" | while IFS='|' read -r label tail app; do
        case "$label" in
            "Ungoogled Chromium") ;; # native form shares ~/.config/chromium with the Chromium row
            *) if [ -d "$HOME/.config/$tail" ]; then
                   printf '%s|%s|-\n' "$HOME/.config/$tail/NativeMessagingHosts" "$label"
               fi ;;
        esac
        if [ "$app" != "-" ] && flatpak info "$app" >/dev/null 2>&1; then
            printf '%s|%s|%s\n' "$HOME/.var/app/$app/config/$tail/NativeMessagingHosts" "$label (flatpak)" "$app"
        fi
    done
}
CHROMIUM_TARGETS="$(chromium_targets)"

# Check every destination before writing anything.
check_safe_path "$INSTALL_DIR"
check_safe_path "$MOZ_DIR"
if [ -n "$CHROMIUM_TARGETS" ]; then
    printf '%s\n' "$CHROMIUM_TARGETS" | while IFS='|' read -r dir label app; do
        check_safe_path "$dir"
    done || exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM

mkdir -p "$INSTALL_DIR" "$MOZ_DIR"

install -m 755 "$SRC_DIR/lqc_host.py" "$HOST_PATH"
echo "Installed host script: $HOST_PATH"

# Browser-neutral wrapper; each browser gets its own copy next to its manifest.
write_wrapper() {
    cat > "$TMP" <<'EOF'
#!/bin/sh
# Inside a flatpak browser sandbox, relay to the host-side script;
# flatpak-spawn is present in flatpak runtimes.
if [ -e /.flatpak-info ]; then
  exec flatpak-spawn --host "$HOME/.local/share/logseq-quick-capture/lqc_host.py" "$@"
fi
exec "$HOME/.local/share/logseq-quick-capture/lqc_host.py" "$@"
EOF
    install -m 755 "$TMP" "$1"
    echo "Installed wrapper: $1"
}

WRAPPER="$MOZ_DIR/lqc-host-wrapper.sh"
write_wrapper "$WRAPPER"

cat > "$TMP" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Logseq CLI bridge for Logseq Expanded Clipper",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF
install -m 644 "$TMP" "$MOZ_DIR/$HOST_NAME.json"
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

# Chromium-family browsers: one wrapper copy + Chromium-format manifest per detected browser.
if [ -n "$CHROMIUM_TARGETS" ]; then
    printf '%s\n' "$CHROMIUM_TARGETS" | while IFS='|' read -r dir label app; do
        echo ""
        echo "$label detected."
        mkdir -p "$dir"
        write_wrapper "$dir/lqc-host-wrapper.sh"
        cat > "$TMP" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Logseq CLI bridge for Logseq Expanded Clipper",
  "path": "$dir/lqc-host-wrapper.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$CHROMIUM_EXT_ID/"]
}
EOF
        install -m 644 "$TMP" "$dir/$HOST_NAME.json"
        echo "Installed manifest: $dir/$HOST_NAME.json"
        if [ "$app" != "-" ]; then
            echo ""
            echo "Grant $label access (once), then restart it:"
            echo ""
            echo "  flatpak override --user --talk-name=org.freedesktop.Flatpak $app"
            echo ""
            echo "Note: this lets the sandbox launch host commands via flatpak-spawn — a"
            echo "deliberate sandbox widening; skip it and the extension stays on HTTP."
        fi
    done
fi

echo "Done."
