# ADR 0004: Hybrid Transport — HTTP API Baseline, Optional CLI Upgrade

## Status
Accepted

## Context
The graph-selector requirement (specification-updates.md) asks for captures to be routed to a
designated graph. The Logseq HTTP API cannot do this: it operates exclusively on the graph
currently open in the app, and remote graph switching is only possible via the x-callback-url
mechanism rejected in ADR 0001.

The Logseq CLI (`logseq`, docs/cli/logseq-cli.md in the logseq repo) was spike-tested on
2026-07-02 against a throwaway graph with the app running. Findings:

- `logseq upsert block --graph <name>` writes to any named graph regardless of which graph the
  app has open — true routing works.
- Writes made while the app has that same graph open appear **live** in the app; app-side edits
  are immediately visible to subsequent CLI reads. App and CLI share the SQLite source of truth
  (`~/logseq/graphs/<name>`) with live change propagation. No refresh, no clobbering.
- Tag property schemas are fully readable: `list property --with-type` returns names, types and
  cardinality; a Datascript query on `:logseq.property.class/properties` returns the tag→property
  linkage. This is the schema data ADR 0003 recorded as unverifiable over the HTTP API.
- The CLI works with the app closed (it manages its own db-worker).

However, a WebExtension cannot spawn processes. Reaching the CLI requires a **native messaging
host**: a host manifest JSON in `~/.mozilla/native-messaging-hosts/` plus a host executable,
installed manually per user and per machine. AMO cannot install it. This is a meaningful setup
burden for casual public users, most of whom have a single graph and the app open while browsing.

## Decision
Two transports behind the existing single seam (`callLogseq()` in the background script, reached
via `LQC_API` runtime messages):

- **Baseline: HTTP API** (ADR 0001 unchanged). Works with only a pasted token. Graph targeting
  is enforced by the **Graph Guard**: the extension compares the capture's Target Graph against
  `logseq.App.getCurrentGraph()` at save time and blocks with a clear error on mismatch
  (Save Failure Behavior applies; user switches graphs and retries).
- **Upgrade: CLI via native messaging.** When the extension detects the native host, the guard
  becomes true routing (writes go directly to the Target Graph), and tag schemas can be read
  live from a graph instead of relying solely on Static Tag Config.

The extension detects host availability at runtime and degrades gracefully to baseline.

## Consequences
- Public users get a zero-native-install experience identical to today plus the Graph Guard.
- Users who install the native host get cross-graph routing and dynamic schema reading.
- ADR 0001 stands as the baseline transport decision.
- ADR 0003 is **superseded in part**: dynamic schema reading is now validated and available via
  the CLI transport. Static Tag Config remains the baseline mechanism and the fallback.
- Two transports must be maintained behind one interface; capability differences (routing,
  schema reads, graph listing) must be expressed as feature detection, not scattered `if`s.
- A native messaging host artifact (manifest + host script that locates and invokes `logseq`)
  must be built, documented, and distributed alongside the extension for those who want it.
- The CLI is young and evolving (spike ran against revision 302f798); CLI-transport features
  should fail soft back to baseline behavior when the CLI misbehaves.

### Chromium (added 2026-10-18, plan `docs/plans/2026-10-18-001-feat-chromium-port-plan.md`)
- The same `extension/` directory loads in Firefox and Chromium: both `background.scripts` and
  `background.service_worker` are declared, a one-line shim aliases `browser` to `chrome`, and
  every async `onMessage` reply goes through `sendResponse` because Chromium honours Promise
  returns only from Chrome 148 on a gradual rollout. A pinned manifest `key` fixes the Chromium
  extension ID so the host manifest can allow it.
- Chromium host manifests use `allowed_origins: ["chrome-extension://<id>/"]` and live per
  browser: `~/.config/google-chrome`, `~/.config/chromium`, `~/.config/BraveSoftware/Brave-Browser`,
  `~/.config/vivaldi` (each `/NativeMessagingHosts`), and `~/.var/app/<app-id>/config/...` for
  flatpak Chrome and Chromium. Each browser gets its own wrapper copy beside its manifest so a
  flatpak browser needs only the `--talk-name` override, not a filesystem grant.
- The Chromium service worker is ephemeral. All CLI state is rebuilt by `detectCli()` on boot
  and the native port is reopened lazily on the next request; an open port keeps the worker
  alive, so no keepalive loop is used.
- The API token and the CLI switch are stored in `storage.local` by default (on Chrome,
  `storage.sync` travels through the user's Google account); a per-profile toggle opts the
  token into sync. The host accepts only the `logseq` subcommands the transport uses.
