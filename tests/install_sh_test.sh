#!/bin/bash
# Exercise native-host/install.sh against fake HOMEs. Run: sh tests/install_sh_test.sh
# Covers R7, R8, R9, R17 (Chromium rows, flatpak rows, byte-identical Firefox output,
# world-writable refusal, root refusal).
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
NEW="$REPO/native-host/install.sh"
HOST_NAME="logseq_quick_capture"
CHROMIUM_EXT_ID="aambbkcokmgbfhfnipfbbghaihmcgdgo"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT INT TERM
FAILS=0

fail() { echo "FAIL: $*" >&2; FAILS=$((FAILS + 1)); }
pass() { printf "ok: %s\n" "$*" | head -n 1 | cut -c1-120; }
check() { if "$@" >/dev/null 2>&1; then pass "$*"; else fail "$*"; fi; }
mode_of() { stat -c '%a' "$1"; }

# Stub flatpak: only the app ids listed in $FLATPAK_INSTALLED are "installed".
mkdir -p "$ROOT/bin"
cat > "$ROOT/bin/flatpak" <<'EOF'
#!/bin/sh
[ "${1:-}" = "info" ] || exit 1
for a in ${FLATPAK_INSTALLED:-}; do [ "$a" = "${2:-}" ] && exit 0; done
exit 1
EOF
chmod 755 "$ROOT/bin/flatpak"
export PATH="$ROOT/bin:$PATH"

fresh_home() {
    rm -rf "$1"; mkdir -p "$1/.local/share"
}

# ---- 1. Chromium rows: three native dirs + flatpak Chromium -------------------------
H="$ROOT/home-chromium"
fresh_home "$H"
mkdir -p "$H/.config/google-chrome" "$H/.config/BraveSoftware/Brave-Browser" "$H/.config/vivaldi"
OUT="$(HOME="$H" FLATPAK_INSTALLED="org.chromium.Chromium" sh "$NEW" 2>&1)"; RC=$?
check test "$RC" -eq 0
for d in "$H/.config/google-chrome" "$H/.config/BraveSoftware/Brave-Browser" "$H/.config/vivaldi" \
         "$H/.var/app/org.chromium.Chromium/config/chromium"; do
    M="$d/NativeMessagingHosts/$HOST_NAME.json"
    W="$d/NativeMessagingHosts/lqc-host-wrapper.sh"
    check test -f "$M"
    check test -f "$W"
    check grep -q "\"allowed_origins\": \[\"chrome-extension://$CHROMIUM_EXT_ID/\"\]" "$M"
    check grep -q "\"path\": \"$W\"" "$M"
    check sh -c "! grep -q allowed_extensions '$M'"
    check test "$(mode_of "$M")" = 644
    check test "$(mode_of "$W")" = 755
    check cmp -s "$W" "$H/.mozilla/native-messaging-hosts/lqc-host-wrapper.sh"
done
check test ! -e "$H/.config/chromium"             # native Chromium absent → nothing created
check test ! -e "$H/.var/app/com.google.Chrome"    # flatpak Chrome not installed → nothing
check test "$(mode_of "$H/.local/share/logseq-quick-capture/lqc_host.py")" = 755
check test "$(mode_of "$H/.mozilla/native-messaging-hosts/$HOST_NAME.json")" = 644
check test "$(printf '%s\n' "$OUT" | grep -c 'flatpak override --user --talk-name=org.freedesktop.Flatpak org.chromium.Chromium')" = 1
check test "$(printf '%s\n' "$OUT" | grep -c 'flatpak override')" = 1   # no --filesystem, no Zen lines
check sh -c "printf '%s\n' \"\$1\" | grep -q 'Brave detected'" _ "$OUT"
check sh -c "printf '%s\n' \"\$1\" | grep -q 'Chromium (flatpak) detected'" _ "$OUT"

# ---- 2. Firefox output byte-identical to the pre-change script ----------------------
# Baseline = the last installer before the Chromium port (merge-base with master at the
# time, d798b38). Override with LQC_OLD_INSTALL_REF. Never HEAD: that is the script under test.
OLD="$ROOT/install.sh.old"
OLD_REF="${LQC_OLD_INSTALL_REF:-d798b38}"
if git -C "$REPO" show "$OLD_REF:native-host/install.sh" > "$OLD" 2>/dev/null; then
    if grep -q CHROMIUM_EXT_ID "$OLD"; then fail "baseline $OLD_REF already contains the Chromium port; pick an older LQC_OLD_INSTALL_REF"; fi
    cp "$REPO/native-host/lqc_host.py" "$ROOT/lqc_host.py"   # old script reads a sibling host
    H="$ROOT/home-ff"
    fresh_home "$H"
    HOME="$H" FLATPAK_INSTALLED="" sh "$OLD" >/dev/null 2>&1 || fail "old installer exited non-zero"
    mkdir -p "$ROOT/old-out"
    cp "$H/.mozilla/native-messaging-hosts/$HOST_NAME.json" "$ROOT/old-out/manifest.json"
    cp "$H/.mozilla/native-messaging-hosts/lqc-host-wrapper.sh" "$ROOT/old-out/wrapper.sh"
    fresh_home "$H"
    HOME="$H" FLATPAK_INSTALLED="" sh "$NEW" >/dev/null 2>&1 || fail "new installer exited non-zero"
    # The human-readable "description" was reworded in the Chromium port; every other byte must match.
    check cmp -s <(grep -v '"description"' "$ROOT/old-out/manifest.json") <(grep -v '"description"' "$H/.mozilla/native-messaging-hosts/$HOST_NAME.json")
    check cmp -s "$ROOT/old-out/wrapper.sh" "$H/.mozilla/native-messaging-hosts/lqc-host-wrapper.sh"
    # Zen output lines unchanged too.
    fresh_home "$H"; O1="$(HOME="$H" FLATPAK_INSTALLED="app.zen_browser.zen" sh "$OLD" 2>&1)"
    fresh_home "$H"; O2="$(HOME="$H" FLATPAK_INSTALLED="app.zen_browser.zen" sh "$NEW" 2>&1)"
    check test "$O1" = "$O2"
else
    echo "skip: git show $OLD_REF:native-host/install.sh unavailable; byte-identity not checked"
fi

# ---- 3. No Chromium browser: nothing Chromium-related, exit 0 ----------------------
H="$ROOT/home-none"
fresh_home "$H"
OUT="$(HOME="$H" FLATPAK_INSTALLED="" sh "$NEW" 2>&1)"; RC=$?
check test "$RC" -eq 0
check test ! -e "$H/.config"
check test ! -e "$H/.var"
check sh -c "! printf '%s\n' \"\$1\" | grep -qi 'chrom\|brave\|vivaldi\|flatpak'" _ "$OUT"
check test -f "$H/.mozilla/native-messaging-hosts/$HOST_NAME.json"

# ---- 4. World-writable parent: refused, names the path, writes nothing -------------
H="$ROOT/home-ww"
fresh_home "$H"
chmod 0777 "$H/.local/share"
ERR="$(HOME="$H" FLATPAK_INSTALLED="" sh "$NEW" 2>&1 >/dev/null)"; RC=$?
check test "$RC" -ne 0
check sh -c "printf '%s\n' \"\$1\" | grep -qF '$H/.local/share is world-writable'" _ "$ERR"
check test ! -e "$H/.mozilla"
check test ! -e "$H/.local/share/logseq-quick-capture"

# World-writable Chromium target dir: also refused before any write.
H="$ROOT/home-ww2"
fresh_home "$H"
mkdir -p "$H/.config/vivaldi/NativeMessagingHosts"; chmod 0777 "$H/.config/vivaldi"
ERR="$(HOME="$H" FLATPAK_INSTALLED="" sh "$NEW" 2>&1 >/dev/null)"; RC=$?
check test "$RC" -ne 0
check sh -c "printf '%s\n' \"\$1\" | grep -qF '$H/.config/vivaldi is world-writable'" _ "$ERR"
check test ! -e "$H/.mozilla"

# ---- 5. Running as root: refused -----------------------------------------------------
mkdir -p "$ROOT/rootbin"
REAL_ID="$(command -v id)"
cat > "$ROOT/rootbin/id" <<EOF
#!/bin/sh
if [ "\${1:-}" = "-u" ]; then echo 0; else exec "$REAL_ID" "\$@"; fi
EOF
chmod 755 "$ROOT/rootbin/id"
H="$ROOT/home-root"
fresh_home "$H"
ERR="$(PATH="$ROOT/rootbin:$PATH" HOME="$H" FLATPAK_INSTALLED="" sh "$NEW" 2>&1 >/dev/null)"; RC=$?
check test "$RC" -ne 0
check sh -c "printf '%s\n' \"\$1\" | grep -q 'refusing to run as root'" _ "$ERR"
check test ! -e "$H/.mozilla"

echo ""
if [ "$FAILS" -eq 0 ]; then echo "install_sh_test: all checks passed"; else echo "install_sh_test: $FAILS failure(s)"; exit 1; fi
