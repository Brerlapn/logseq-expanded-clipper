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
  + a `window.__lqcOpen` check, falling back to injection on failure); (2) owns all Logseq traffic
  behind one transport seam: the HTTP API (`callLogseq`), because content scripts cannot reliably make
  cross-origin `fetch` calls to `localhost` themselves, and, when enabled, the Logseq CLI through the
  native messaging host in `native-host/`. The content script talks to it via
  `browser.runtime.sendMessage` with `LQC_API` (HTTP passthrough), `LQC_OP` (reads such as tags and
  tag schemas) and `LQC_SAVE` (the save, composed in the background).
- `extension/content/modal.js` — injected on demand (not statically declared in the manifest) as an
  overlay modal directly in the page (see `docs/adr/0002-content-script-modal-over-popup.md` for why this
  is a content-script overlay and not a toolbar popup). Contains both extension modes: Web Clipper and
  Tag Properties. Listens for `{ type: 'LQC_OPEN' }` runtime messages and exposes `window.__lqcOpen`
  as the injection entry point.
- `extension/options/options.js` — the settings UI (API token/port, default capture page, and the
  static per-tag field config editor for Tag Properties mode).

Storage split:
- `browser.storage.sync` — user settings: `logseqApiToken`, `logseqApiPort`, `cliEnabled`,
  `graphSettings` (Known Graphs, each with its capture page), `webClipperTargetGraph` (the Target
  Graph shared by both modes), `tagConfigs` (pinned tags and their field schema, see below).
- `browser.storage.local` — `lqcPending`, the in-flight modal form state, written on every change and
  cleared on successful save (the safety net described in "Save Failure Behavior" below); plus caches:
  `tagCache`, `tagSuggestions`, `recentTagConfigs`.

### Key domain concepts (full glossary in `CONTEXT.md`)

- **Clip**: a top-level block `[Page Title](URL)` carrying all DB Tags, with optional child blocks for
  Notes and a Highlight. The top block is the anchor block — every DB Tag must be applied there so tag
  queries surface the URL/title.
- **DB Tag**: applied via Logseq DB's `:block/tags` relationship (first-class DB association). The
  file-based property syntax `tags:: [[value]]` must **never** be used in this project — this is a
  DB-graph-only extension.
- **Web Clipper mode** vs **Tag Properties mode**: Web Clipper captures URL/title/tags/notes/highlight
  freeform. Tag Properties mode picks one tag and writes its fields as DB typed properties
  instead: over the CLI transport by `db/ident` in the same `upsert block --update-properties` call
  that creates the clip, over HTTP by `upsertBlockProperty()` per field after resolving names to
  idents. It writes no Notes/Highlight; the modal lists anything typed that this mode won't save.
- **Tag schema source**: with the CLI transport, Tag Properties mode reads a tag's schema live from
  Logseq (`getTagSchema` in the service worker: properties keyed by `db/ident`, inherited ones
  included), and any tag in the Target Graph can be picked. **Static Tag Config** — tag name → list of
  `{name, type}` typed by hand in extension settings — is the baseline without the CLI and the source
  of the pinned tags. See `docs/adr/0003-static-tag-config-over-dynamic-schema.md` (why static came
  first) and `docs/adr/0004-*` (why dynamic reads go through the CLI, not `getTag()`).
- **Save Failure Behavior**: on HTTP API failure, the modal stays open with an error + Retry button;
  it never silently drops user input.

### Design decisions to respect

The four ADRs in `docs/adr/` are load-bearing — re-read the relevant one before changing:
- Logseq integration transport (`0001`: HTTP API + Bearer token, not `x-callback-url`)
- Capture UI mechanism (`0002`: injected content-script modal, not a toolbar popup)
- Tag Properties schema source (`0003`: static settings config, not dynamic `getTag()` reads)
- Transport (`0004`: HTTP API as the baseline, the Logseq CLI via a native messaging host as an
  optional upgrade that routes to any graph, lists graphs, and reads tag schemas)

`specification.md` is the original feature spec. `specification-updates.md` records later requests
(keyboard-only tag autocomplete, a graph selector, and having Tag Properties mode read/write a tag's
*existing* Logseq properties instead of extension-defined duplicates). All of them are **implemented**
as of 1.3.8; its status block at the top says how. Verified API behaviors and the message/storage
contracts live in `.claude/skills/logseq-clipper-dev/REFERENCE.md` — check it before guessing how
Logseq's HTTP API or CLI behaves.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
