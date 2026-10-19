# Logseq Expanded Clipper — How to Use

Capture the page you're reading into a Logseq DB graph without leaving the browser:
URL, title, tags, notes, highlighted text, or a full row of tag properties.
Version 1.4.1. Linux. Firefox 121+ (or Zen Browser), or a Chromium browser (Chrome, Chromium,
Brave, Vivaldi). DB graphs only.

## What's in this zip

| File | What it is |
|---|---|
| `logseq-expanded-clipper-1.4.1.xpi` | The signed extension, for Firefox and Zen |
| `chromium/` | The same extension as a folder, for Chromium browsers (load unpacked) |
| `native-host/install.sh` | Installs the CLI bridge (Tier 2) |
| `native-host/lqc_host.py` | The CLI bridge itself |
| `native-host/logseq-extracted` | Wrapper that runs the Logseq CLI from the AppImage |
| `README.md` | Full reference, including Troubleshooting |

## Install

### Tier 1 — the basics (required)

1. Install the extension:
   - **Firefox/Zen:** `about:addons` → gear menu → **Install Add-on From File…** → pick the `.xpi`.
   - **Chromium browsers:** `chrome://extensions` → turn on **Developer mode** → **Load unpacked**
     → pick the `chromium/` folder (keep the folder where it is; the browser loads it from there).
     Two warnings about Firefox-only manifest keys are normal.
2. In Logseq: **Settings → Developer → HTTP API server**. Turn it on and copy the token.
3. Open the extension's settings (Firefox: `about:addons` → Logseq Expanded Clipper → Preferences;
   Chromium: `chrome://extensions` → Details → Extension options), paste the token, and click
   **Test connection**.

That's enough to clip into whichever graph Logseq has open.

### Tier 2 — CLI integration (optional, recommended)

Lets you save into any graph, even with Logseq closed, and reads each tag's real
properties straight from your graph. Requires `python3`, `bash` and `flock`.

1. Put the Logseq AppImage at exactly `~/AppImages/logseq.appimage` and make it executable
   (`chmod +x`). A symlink with that name pointing at your real AppImage works too.
2. From the unzipped folder:
   ```sh
   install -m 755 native-host/logseq-extracted ~/.local/bin/
   sh native-host/install.sh
   ```
   The installer sets up the bridge for Firefox and for every Chromium browser it finds.
3. **Flatpak browser only** (e.g. Zen from Flathub): run the `flatpak override`
   commands the installer prints for your browser, then fully quit and restart the browser.
4. In the extension settings: tick **Enable CLI integration**, accept the prompt, then click
   **Test CLI connection**. It should show the CLI version. On Chromium browsers the extension
   restarts itself once right after you tick the box; reopen settings and click **Test CLI
   connection** again.

The first CLI use unpacks the AppImage (~500 MB at `~/AppImages/logseq-extracted`) and is
slow once. When you update Logseq, just replace the AppImage; the copy refreshes itself.

If anything about Tier 2 fails, the extension quietly falls back to Tier 1.

## Everyday use

**Open the clipper:** press **Alt+Shift+L**, or click the toolbar button. (To change the
shortcut: Firefox `about:addons` → gear → **Manage Extension Shortcuts**; Chromium
`chrome://extensions/shortcuts`.)

**Pick a Target Graph** at the top of the modal. On Tier 1, if Logseq has a different graph
open, the save stops and tells you; switch graphs in Logseq and hit **Retry**.

### Web Clipper mode

For saving a link with context.

1. Select text on the page first if you want a highlight (it's saved as a child block
   tagged `#highlight`).
2. Open the clipper. URL and title are filled in.
3. Add tags: type, use **↑/↓** to choose a suggestion, **Enter** to add it. Unknown names
   become new tags.
4. Add notes if you like, then **Save**.

Result: a `[Page Title](URL)` block carrying your tags, with notes and highlight as child
blocks. Tags are real Logseq DB tags, so the clip shows up in that tag's page and tables.

### Tag Properties mode

For building a table row, e.g. a `#music-recs` entry with artist, genre and date.

1. Switch to **Tag Properties** and pick a tag.
2. Fill in the fields. They match each property's type: date pickers, checkboxes,
   dropdowns for choice lists, autocomplete for node properties.
3. If the tag has a URL property, the page URL is already in it.
4. **Save.** The block lands with the tag and all its properties set.

Where the fields come from:
- **Tier 2:** read live from the tag's definition in your graph. Any tag works; to change
  the fields, edit the tag's properties in Logseq.
- **Tier 1:** you define them yourself in settings under **Tag Properties** (tag name plus a
  list of fields and types). Only tags configured there appear.

This mode saves properties only. If you typed notes or a highlight, the modal tells you
they won't be saved.

### Nothing gets lost

- **Escape** closes the modal and keeps what you typed as a draft. Next time you open it,
  an "Unsaved capture" bar offers **Restore** or **Discard**.
- If a save fails, the modal stays open with the error and a **Retry** button.

## Settings at a glance

- **Connection:** API token and port; Test connection
- **CLI integration:** enable toggle; Test CLI connection
- **Capture:** a capture page per graph (blank means that day's journal)
- **Tag Properties:** pinned tags and their fields (Tier 1 configs live here)

## Quick fixes

| Message | Fix |
|---|---|
| "Could not reach Logseq" | Logseq must be running with the HTTP API server on (Tier 1). |
| "Logseq has X open, but this capture is aimed at Y" | Switch graphs in Logseq, hit Retry, or set up Tier 2. |
| "No such native application logseq_quick_capture" | Re-run `sh native-host/install.sh`; on flatpak, apply both overrides and fully restart the browser. |
| "logseq CLI not found on this machine" | Check `~/.local/bin/logseq-extracted` exists and the AppImage is at `~/AppImages/logseq.appimage`. |

More in `README.md` → Troubleshooting.

## Uninstall

- Extension: Firefox `about:addons` → Remove; Chromium `chrome://extensions` → Remove, then delete
  the `chromium/` folder.
- CLI bridge: delete `~/.local/share/logseq-quick-capture/`, plus `logseq_quick_capture.json` and
  `lqc-host-wrapper.sh` from `~/.mozilla/native-messaging-hosts/` and from each Chromium browser's
  `NativeMessagingHosts` directory under `~/.config/` (the installer lists the ones it wrote).
- Wrapper: delete `~/.local/bin/logseq-extracted` and `~/AppImages/logseq-extracted*`.
