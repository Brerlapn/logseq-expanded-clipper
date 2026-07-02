# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A Firefox MV3 extension ("Logseq Quick Capture" / "Logseq Expanded Clipper") that captures the current
page (URL, title, selection, tags, notes) into a Logseq DB graph via Logseq's local HTTP API, without
leaving the browser. It also has a "Tag Properties" mode for filling in structured DB-typed properties
for a user-defined tag (e.g. building a table-view row for `#music-recs` straight from the browser).

The extension source lives in `extension/`. It is plain vanilla JS with **no build step, no bundler, and
no package.json** — files are loaded by the browser as-is.

`firefox-extension-logseq-quickcapture/` is a full clone of a *different, third-party* reference extension
(benjypng/firefox-extension-logseq-quickcapture) kept for comparison only. It is not part of this
extension's build and should not be edited as if it were.

## Commands

There is no npm/build tooling. Common operations:

- Load unpacked for development: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" →
  select `extension/manifest.json`. Note: Zen Browser cannot serve `moz-extension://` files from a
  temporary/directory-loaded add-on — it must be loaded as a packaged `.xpi` there (see
  `firefox-extension-logseq-project-zen-browser-xpi` decisions / commit history for the workarounds this
  required, e.g. avoiding `type: module` backgrounds and on-demand content-script injection).
- Package/sign as `.xpi`: `npx web-ext build` / `npx web-ext sign` from the `extension/` directory
  (`web-ext` is invoked via `npx`, not installed as a project dependency).
- No automated test suite exists. Verification is manual: load the extension, trigger it with
  `Alt+Shift+L` or the toolbar button, and exercise the modal against a real running Logseq instance
  with the HTTP API enabled (Settings → Developer → HTTP API server, with a Bearer token).

## Architecture

Three extension surfaces, no framework:

- `extension/background/service-worker.js` — the only piece with `host_permissions` for
  `http://localhost/*`. It does two things: (1) routes the `open-modal` command / toolbar click to the
  active tab, injecting `content/modal.js` on demand if it isn't already there (`browser.scripting.executeScript`
  + a `window.__lqcOpen` check, falling back to injection on failure); (2) proxies all Logseq HTTP API
  calls (`callLogseq`) on behalf of the content script, because content scripts cannot reliably make
  cross-origin `fetch` calls to `localhost` themselves. The content script talks to it via
  `browser.runtime.sendMessage({ type: 'LQC_API', method, args })`.
- `extension/content/modal.js` — injected on demand (not statically declared in the manifest) as an
  overlay modal directly in the page (see `docs/adr/0002-content-script-modal-over-popup.md` for why this
  is a content-script overlay and not a toolbar popup). Contains both extension modes: Web Clipper and
  Tag Properties. Listens for `{ type: 'LQC_OPEN' }` runtime messages and exposes `window.__lqcOpen`
  as the injection entry point.
- `extension/options/options.js` — the settings UI (API token/port, default capture page, and the
  static per-tag field config editor for Tag Properties mode).

Storage split:
- `browser.storage.sync` — user settings: `logseqApiToken`, `logseqApiPort`, `defaultCapturePage`,
  `tagConfigs` (the static tag→fields schema, see below).
- `browser.storage.local` — `lqcPending`, the in-flight modal form state, written on every change and
  cleared on successful save. This is the safety net described in "Save Failure Behavior" below.

### Key domain concepts (full glossary in `CONTEXT.md`)

- **Clip**: a top-level block `[Page Title](URL)` carrying all DB Tags, with optional child blocks for
  Notes and a Highlight. The top block is the anchor block — every DB Tag must be applied there so tag
  queries surface the URL/title.
- **DB Tag**: applied via Logseq DB's `:block/tags` relationship (first-class DB association). The
  file-based property syntax `tags:: [[value]]` must **never** be used in this project — this is a
  DB-graph-only extension.
- **Web Clipper mode** vs **Tag Properties mode**: Web Clipper captures URL/title/tags/notes/highlight
  freeform. Tag Properties mode picks one tag and renders its configured fields as DB typed properties
  via `upsertBlockProperty()` instead — no Notes/Highlight in this mode.
- **Static Tag Config**: Tag Properties mode's field schema (tag name → list of `{name, type}`, type is
  one of Logseq DB's 6 property types) is defined manually in extension settings, not read dynamically
  from Logseq (`getTag()`'s schema-return shape was unconfirmed at project start — see
  `docs/adr/0003-static-tag-config-over-dynamic-schema.md`). Read `docs/adr/0003-*` before adding any
  dynamic schema-reading feature — it documents exactly why this was deferred and what would need
  confirming first.
- **Save Failure Behavior**: on HTTP API failure, the modal stays open with an error + Retry button;
  it never silently drops user input.

### Design decisions to respect

The three ADRs in `docs/adr/` are load-bearing — re-read the relevant one before changing:
- Logseq integration transport (`0001`: HTTP API + Bearer token, not `x-callback-url`)
- Capture UI mechanism (`0002`: injected content-script modal, not a toolbar popup)
- Tag Properties schema source (`0003`: static settings config, not dynamic `getTag()` reads)

`specification.md` is the original feature spec. `specification-updates.md` lists capabilities that have
been requested but are **not yet implemented** (keyboard-only tag autocomplete, a graph selector, and
having Tag Properties mode read/write a tag's *existing* Logseq properties instead of extension-defined
duplicates) — check it before assuming a described behavior already exists in the code.
