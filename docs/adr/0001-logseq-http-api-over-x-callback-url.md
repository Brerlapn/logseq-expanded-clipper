# ADR 0001: Logseq HTTP API over x-callback-url

## Status
Accepted

## Context
The existing reference extension (benjypng/firefox-extension-logseq-quickcapture) uses the `logseq://x-callback-url/quickCapture` protocol to write to Logseq. This approach requires no configuration beyond Logseq being installed, but it has two hard limits: it cannot read any data back from Logseq (no tag autocomplete, no schema queries), and it hijacks browser focus by opening a logseq:// URL in a temporary tab.

The specification requires tag autocomplete and explicitly asks for captures to happen "without leaving the browser window." Both requirements are incompatible with x-callback-url.

## Decision
Use the Logseq local HTTP API (`POST http://localhost:12315/api`, Bearer token auth) for all reads and writes.

## Consequences
- Tag autocomplete is possible via `logseq.Editor.getAllTags()`
- Writes use `appendBlockInPage()` + `upsertBlockProperty()` — no focus switch, no temporary tab
- Users must enable the HTTP API in Logseq settings (Settings → Developer → HTTP API server) and paste an API token into extension settings — a one-time setup step
- If Logseq is not running, the extension degrades gracefully (modal stays open, Retry button, form state persisted locally)
- x-callback-url compatibility is dropped entirely
