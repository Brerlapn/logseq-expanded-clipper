# Logseq Expanded Clipper — Glossary

## Extension-wide Decisions (not glossary terms, recorded here for context)
- **Manifest version**: V3 (clean rebuild, not a fork of the existing MV2 extension)
- **Logseq integration**: HTTP API at `localhost:12315`, Bearer token auth — not x-callback-url
- **UI mechanism**: Content script modal injected into the page, not a popup
- **Data-handling changes are disclosed**: any change to what the extension collects, stores, or sends (a new permission, a new destination, a change to where the token lives) bumps the version, adds a dated entry to the changelog in `docs/PRIVACY.md`, updates the data-notice block in `options.html`, and shows a one-time notice in Settings on first open after the update. Chrome Web Store policy since 2026-08-01 requires the in-product disclosure; the one-time notice mechanism is built the first time a change needs it.
- **Keyboard shortcut**: `Alt+Shift+L` (user-overridable in Firefox `about:addons` or Chromium `chrome://extensions/shortcuts`)
- **Default capture target**: TODAY's journal page, with a per-graph override (each Known Graph may set its own capture page; graphs without one use the journal)
- **Readwise sync**: Out of scope for v1
- **Tag schema reading**: Static config is the baseline; live schema reading from a graph is available via the CLI transport (ADR 0004)
- **Transport**: Hybrid — HTTP API baseline, optional CLI upgrade via native messaging (ADR 0004)

---


## Clip
A web capture created by the extension. Consists of a top-level block whose content is `[Page Title](URL)`, with DB Tags applied to it. May have child blocks for Notes and a Highlight. The top block is the anchor — it must carry all DB Tags so that querying any tag returns the URL/title.

## DB Tag
A tag applied to a block via Logseq DB's `:block/tags` relationship — a first-class database association, not inline text. Distinct from file-based Logseq property syntax (`tags:: [[value]]`), which must never be used in this project.

## Tag Cache
The per-graph list of known tags that feeds autocomplete. Autocomplete always reads the Target
Graph's entry — never the open graph's — so suggestions are always from the right namespace, at
the cost of possible staleness on the baseline transport. Refreshed whenever the graph is
reachable (live on CLI; on baseline, whenever that graph is the open one, including on Retry
after a Graph Guard block).

## Known Graphs
The set of graphs the extension can offer as Target Graph choices. On the CLI transport this is
the live list of all graphs. On the baseline transport it is accumulated observation: every graph
the extension has seen open in Logseq is remembered. There is no manual way to add a graph — on
baseline, a graph the user has never had open cannot be saved to anyway (the Graph Guard would
block it), so opening it once in Logseq is both the registration and the prerequisite.

## Graph Guard
The baseline-transport enforcement of the Target Graph: at save time the extension compares the
Target Graph against the graph currently open in Logseq. On mismatch the save is blocked with an
error naming both graphs, and Save Failure Behavior applies (the user switches graphs in Logseq
and retries). When the CLI transport is available the guard is unnecessary — writes route
directly to the Target Graph.

## Highlight
Selected text from the current web page at capture time. Stored as a child block of the Clip. When a Highlight is present, the `#highlight` DB Tag is automatically applied to the parent Clip block (in addition to any user-entered tags).

## Notes
Optional free-text annotation entered by the user in the modal at capture time. Stored as a child block of the Clip (Web Clipper mode only).

## Save Failure Behavior
On HTTP API failure at save time: the modal stays open, shows an error, and presents a Retry button. Form state is persisted to `browser.storage.local` on every change as a safety net against tab navigation or accidental closure. State is cleared on successful save.

## Web Clipper Mode
The extension's general capture mode. Captures URL, page title, user-entered tags, optional notes, and optional highlighted text. Produces a Clip.

## Tag Properties Mode
The extension's structured data entry mode. The user selects a tag, and the modal shows a set of configurable fields for that tag (defined in extension settings). Produces a Clip whose top block carries the DB Tag and the configured fields as DB typed properties (set via `upsertBlockProperty()`). Notes and Highlights do not apply in this mode — the configured fields are the structured data.

## Target Graph
The Logseq graph a capture is intended for. Web Clipper mode has a single Target Graph selection
that persists until changed. Each Tag Config in Tag Properties mode is bound to its own Target
Graph (the graph that is the source of the tag). Enforced by the Graph Guard on the baseline
transport, or satisfied directly by routing on the CLI transport.

## Static Tag Config
The stored per-tag field schema (field names + types) that drives Tag Properties Mode. Each field has a name and one of Logseq DB's property types; the extension renders the appropriate input control per type. The graph's own tag schema is the source of truth: when the CLI transport is available, the config is refreshed from the tag's Target Graph at modal open and acts as a cache (last-known schema, used for instant render and as fallback). Hand-editing the config in extension settings remains available as the baseline-transport mechanism, but a config that has been successfully live-read is overwritten by the next refresh. Notes are not a built-in field in Tag Properties mode — if notes are wanted for a tag, the field must exist on the tag in the graph.
