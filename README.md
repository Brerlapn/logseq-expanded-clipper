# Logseq Expanded Clipper

A browser extension for Firefox and Chromium browsers (Chrome, Chromium, Brave, Vivaldi) that captures web content into [Logseq DB](https://github.com/logseq/logseq)
graphs without leaving the browser. Press a shortcut, annotate, save — the clip lands as a
block in your graph with native DB tags and typed properties.

Built for Logseq **DB graphs** only (tags as first-class `:block/tags` relationships, typed
properties). It does not use, and will never write, file-graph `property:: value` syntax.

## Two modes

- **Web Clipper** — captures the page URL and title, your tags (with autocomplete from the
  target graph), optional notes, and any selected text as a highlight (auto-tagged
  `#highlight`). Saved as a `[Title](URL)` block with child blocks for notes/highlight.
- **Tag Properties** — pick a tag, fill in its properties, save a fully-formed table-view row.
  Fields render by type (dates get date pickers, checkboxes get checkboxes, choices
  properties get dropdowns of their allowed values, node properties autocomplete from
  existing values). If the tag has a url-typed property, the clip URL is pre-filled into it
  and the block text becomes the clean page title.

Open the modal with **Alt+Shift+L** (rebindable in Firefox at `about:addons` → gear → Manage Extension
Shortcuts, in Chromium at `chrome://extensions/shortcuts`) or the toolbar button. Escape closes it; unsaved work is kept as a draft and
offered for restore next time. If a save fails, the modal stays open with a Retry button —
nothing is lost.

## Setup

### Requirements

- Firefox 121+ (or a Firefox-based browser — tested on Zen Browser), **or** a Chromium
  browser (Chrome, Chromium, Brave, Vivaldi; 1.4.0 was verified on Chrome, Chromium and
  Vivaldi — Brave is expected to work but has not been run)
- Logseq with a DB graph

**Firefox:** the extension ships as a signed `.xpi`: install via `about:addons` → gear menu →
*Install Add-on From File…*

**Chromium browsers:** load the `extension/` directory unpacked: `chrome://extensions` →
enable *Developer mode* → *Load unpacked* → pick `extension/`. The manifest pins the extension
ID to `ojfmjhjcjgogodbfmnoepkdlacdmkbpn` on every machine, which is what the native host
(Tier 2) allows. A Chrome Web Store listing is planned; until then unpacked is the install.
Chrome logs two warnings about Firefox-only manifest keys; they are harmless.

### Tier 1 — HTTP API (baseline)

Works with just the Logseq app. Captures go to whichever graph is open in Logseq.

1. In Logseq: **Settings → Developer → HTTP API server**, enable it, and copy the token.
2. In the extension settings: paste the token, hit **Test connection**.

What you get:

- Capture to the open graph: tags, notes, highlights, tag properties
- **Graph Guard**: aim a capture at a specific graph; if a different graph is open in
  Logseq, the save is blocked with a clear error — switch graphs and hit Retry
- Per-graph capture pages (default: today's journal), per-graph tag autocomplete
- The graph list accumulates automatically: every graph the extension sees open in Logseq
  becomes a target choice (open a graph once to register it)

Baseline limits (all removed by Tier 2): captures can only be written to the open graph;
Tag Properties fields come from the static config you define in extension settings; node
property values are not linked to existing nodes.

### Tier 2 — CLI integration (optional power tier)

Uses the [Logseq CLI](https://github.com/logseq/logseq/blob/master/docs/cli/logseq-cli.md)
via a native messaging host. Captures route **directly to any graph** — no graph switching,
and Logseq doesn't even need to be running.

1. Install the Logseq CLI (the `logseq` binary must be on your PATH, in `~/.local/bin`,
   or pointed to by `LOGSEQ_CLI_PATH`).

   **AppImage installs:** the `logseq` launcher the desktop app writes to `~/.local/bin`
   runs from the AppImage's temporary mount, only works while the app is open, and leaves
   background db-workers that crash (SIGBUS) after each write. Install the bundled wrapper
   instead; the host prefers it when present:

   ```sh
   install -m 755 native-host/logseq-extracted ~/.local/bin/
   ```

   It runs the CLI from an extracted copy of `~/AppImages/logseq.appimage` (override with
   `LOGSEQ_APPIMAGE`; about 500 MB at `~/AppImages/logseq-extracted`) and re-extracts by
   itself whenever the AppImage changes, so updating Logseq is still just replacing the
   AppImage. To undo: delete `~/.local/bin/logseq-extracted` and
   `~/AppImages/logseq-extracted*`.
2. Run the host installer from this repo. It installs the host for Firefox (`~/.mozilla`)
   and for every Chromium browser it finds — Chrome, Chromium, Brave, Vivaldi, plus flatpak
   Chrome and Chromium — each in that browser's own `NativeMessagingHosts` directory:

   ```sh
   sh native-host/install.sh
   ```

   The installer refuses to run as root or to write into a world-writable directory, and
   the host only runs the handful of `logseq` subcommands the extension uses. If a newer
   extension reports "the installed native host is older than the extension", re-run it.

3. **Flatpak browsers only** — grant the sandbox access, then fully restart the browser.
   The installer prints the exact lines for each flatpak browser it detected. For Zen:

   ```sh
   flatpak override --user --talk-name=org.freedesktop.Flatpak app.zen_browser.zen
   flatpak override --user --filesystem=$HOME/.mozilla/native-messaging-hosts:ro app.zen_browser.zen
   ```

   Flatpak Chrome and Chromium need only the first kind of line (their host files live inside
   the sandbox's own home):

   ```sh
   flatpak override --user --talk-name=org.freedesktop.Flatpak org.chromium.Chromium
   ```

   > **Security note:** the `--talk-name` override lets the browser sandbox launch host
   > commands via `flatpak-spawn` — a deliberate sandbox widening that native messaging
   > requires on flatpak browsers. If that trade-off isn't acceptable, skip Tier 2; the
   > extension stays fully functional on the baseline.

4. In the extension settings: tick **Enable CLI integration** (accept the permission
   prompt), then **Test CLI connection** — it should report the CLI version.

What you get on top of the baseline:

- **True cross-graph routing** — save into any graph regardless of what's open; the Graph
  Guard becomes unnecessary and is skipped
- **Live everything** — the graph selector lists all graphs; tag autocomplete reads the
  target graph directly; works with the Logseq app closed
- **Live tag schemas** — Tag Properties fields are read from the tag's own definition in
  its graph (names, types, choices lists, node suggestions); the extension config becomes
  a cache, with Logseq as the source of truth
- **Correct entity linking** — tags match case-insensitively, node values link existing
  nodes (including all members of a property's constraint class), choices properties only
  accept their defined values

The CLI tier fails soft: if the host or CLI is unavailable, the extension quietly returns
to baseline behavior.

## Settings overview

- **Connection** — HTTP API token and port, Test connection. The token is stored on this
  device only unless you tick **Sync the API token across my browser profiles**; on Chrome
  that puts it in Google's sync store (encrypted with Google-held keys unless you set a sync
  passphrase). Firefox Sync is end-to-end encrypted. The CLI switch is always per profile.
- **CLI integration** — enable toggle and Test CLI connection
- **Capture** — one capture page per known graph; blank means that graph's daily journal
- **Tag Properties** — one config per tag, each bound to the graph the tag lives in.
  Tag names autocomplete from the selected graph (CLI tier). Configs that have been
  live-read from a graph lock their field editors — edit the tag's properties in Logseq
  instead.

## Troubleshooting

- **"Logseq has X open, but this capture is aimed at Y"** — baseline behavior working as
  intended: switch graphs in Logseq and hit Retry (or install Tier 2 for direct routing).
- **"No such native application logseq_quick_capture"** — the browser can't find the host
  manifest. Re-run `native-host/install.sh` (it needs the browser's config directory to exist,
  so launch the browser once first); on flatpak browsers make sure the printed overrides are
  applied and the browser was fully restarted.
- **Chromium browsers: "Native messaging enabled; restarting the extension once"** — expected the
  first time you enable the CLI. Chromium only exposes a newly granted permission's API to fresh
  extension contexts, so the extension reloads itself; reopen settings and press *Test CLI connection*.
- **"the installed native host is older than the extension"** — the host refused a
  subcommand it doesn't know. Re-run `native-host/install.sh`.
- **Chrome: "Could not reach Logseq" with the API enabled** — check `chrome://flags` for
  Local Network Access blocking; see `docs/verification/chromium-release.md` for the check.
- **"logseq CLI not found on this machine"** — the host script can't locate the `logseq`
  binary; put it on PATH or set `LOGSEQ_CLI_PATH`.
- **"Could not reach Logseq"** — baseline transport needs the app running with the HTTP
  API server enabled.

## Repository layout

- `extension/` — the extension source (no build step; plain WebExtension)
- `native-host/` — the native messaging host and installer for Tier 2
- `docs/adr/` — architecture decision records (why HTTP+CLI hybrid, why a content-script
  modal, how tag schemas are sourced)
- `CONTEXT.md` — the project glossary (Clip, DB Tag, Target Graph, Graph Guard, …)
- `implementation-plan.md` — the build plan, including verified Logseq API findings

## Development

No build tooling. Package with `npx web-ext build` from `extension/`; lint with
`npx web-ext lint`. On Zen Browser, temporary directory add-ons don't work — test with a
packaged (and for release, signed) `.xpi`. On Chromium browsers load `extension/` unpacked.

Tests: `node --test tests/*.test.js` (background and settings logic against an in-memory
`chrome.*`), `python3 -I tests/lqc_host_test.py` (native host), `bash tests/install_sh_test.sh`
(installer). The per-browser release checklist is `docs/verification/chromium-release.md`.

## Acknowledgements

This extension is a clean rebuild, but it owes its inspiration to two projects:

- [firefox-extension-logseq-quickcapture](https://github.com/benjypng/firefox-extension-logseq-quickcapture)
  by benjypng/hkgnp — the original Firefox quick-capture extension for Logseq
- [logseq-reference-manager](https://github.com/rsomani95/logseq-reference-manager) by
  rsomani95 — the reference-management and web-clipping workflow this extension's capture
  model grew out of

## License

[MIT](LICENSE.md)
