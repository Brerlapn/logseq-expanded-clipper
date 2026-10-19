# Privacy Policy — Logseq Expanded Clipper

Effective 2026-10-18. Applies to the Logseq Expanded Clipper browser extension for Firefox and
Chromium browsers, version 1.4.1 and later.

## The one-sentence version

Everything you capture goes to your own Logseq on your own computer, and nothing goes to the
developer or to anyone else.

## What the extension handles

The extension has a single purpose: capture the page you are reading (URL, title, selected
text, your notes and tags, or a row of tag properties) into a Logseq DB graph on this computer.
To do that it handles:

| Data | When | Where it goes |
|---|---|---|
| Page URL, title, and selected text of the current tab | Only when you press the shortcut or the toolbar button | Shown in the capture modal, then sent to your Logseq instance on `localhost` when you press Save |
| Notes, tags, and tag property values you type | When you type them | Same: your Logseq instance on `localhost` |
| An unsaved draft of the modal form | While the modal is open or after a failed save | `browser.storage.local` on this device; cleared on a successful save |
| Your Logseq HTTP API token | When you paste it into Settings | `browser.storage.local` on this device by default (see "Token sync" below) |
| Settings: API port, known graphs and their capture pages, target graph, tag field configs | When you change them | `browser.storage.sync`, your browser account's extension-settings store |
| Caches: tag names and recent tag configs read from your graph; the CLI on/off switch | As the extension reads your graph or you toggle the CLI | `browser.storage.local` on this device |

The store listing's vocabulary for this is **website content** (URL, title, selection) and
**authentication information** (the API token). The extension collects nothing else: no browsing
history, no page content from tabs you did not clip, no analytics, no crash reports, no
identifiers.

## Where data travels

- **To Logseq on this computer only.** Captures are sent to `http://localhost:<port>` where
  Logseq's HTTP API server listens, authenticated with your token. Nothing is sent to any other
  host. The extension's only host permission is `http://localhost/*`.
- **Optional CLI tier.** If you install the native messaging host and turn on CLI integration,
  captures instead go through a small program on this computer (`lqc_host.py`) to the Logseq
  command-line tool. This stays on your machine. It is off by default and needs a separate
  installer you run yourself.
- **Token sync (off by default).** Settings has a checkbox, "Sync the API token across my browser
  profiles". While it is off, the token never leaves this device. If you turn it on, the token is
  placed in your browser account's sync store, which means your browser vendor's servers (on
  Chrome, Google's; on Firefox, Mozilla's, end-to-end encrypted). Turning it off removes the
  synced copy.
- **Settings sync.** Non-secret settings (port, graph names, tag field configs)
  live in `browser.storage.sync` so a second profile of the same browser account gets the same
  setup. Graph names and tag names are therefore visible to your browser vendor's sync service
  if you have extension sync on. No capture content and no page data are stored there.

## What the developer receives

Nothing. The extension makes no network requests except to `localhost`. There is no telemetry,
no update ping of its own (browser stores handle updates), and no account.

## Sale, transfer, and other use

The extension does not sell data, does not transfer data to third parties, does not use data for
anything beyond its single purpose, and does not use data to determine creditworthiness or for
lending.

## Permissions, and why

| Permission | Why |
|---|---|
| `activeTab` | Read the URL, title and selection of the tab you invoke the clipper on, only at that moment |
| `scripting` | Inject the capture modal into the current tab on demand |
| `storage` | Keep your settings and, on this device, your token and unsaved draft |
| `http://localhost/*` | Reach Logseq's HTTP API server, which listens only on localhost |
| `nativeMessaging` (optional, off by default) | Talk to the Logseq command-line tool through the native host you install |

## Changes to this policy

Any change to what the extension handles or where it sends it will bump the extension version,
be recorded in the changelog below, and be shown once in the extension's Settings page after the
update.

## Contact and source

Source code, issue tracker, and this policy: https://github.com/Brerlapn/logseq-expanded-clipper

## Changelog

- 2026-10-18 — First version, written for the 1.4.1 Chrome Web Store submission. Describes the
  behaviour that has shipped since 1.4.0 (token on-device by default with an opt-in sync toggle).
