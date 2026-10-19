# Chrome Web Store listing — Logseq Expanded Clipper

Copy for the dashboard, one section per tab. Item ID `aambbkcokmgbfhfnipfbbghaihmcgdgo`. Keep
the data wording identical to `docs/PRIVACY.md` and the options-page notice. Assets in this folder:
`icon-128.png` (store icon), `promo-440x280.png` (small promo tile); screenshots are 1280x800
PNGs named `screenshot-1-modal.png`, `screenshot-2-tag-properties.png`, `screenshot-3-settings.png`.

## Store Listing tab

**Title:** Logseq Expanded Clipper

**Short description** (under 132 characters, 94 used; the store takes this from the manifest `description` field, so edit it there and rebuild the zip):

> Capture the page you're reading into your Logseq DB graph: URL, title, tags, notes, highlight.

**Category:** Productivity → Tools

**Language:** English

**Detailed description:**

Save the page you are reading into a Logseq DB graph without leaving the browser. Press Alt+Shift+L (or the toolbar button), add tags and a note, and the clip lands in your graph as a block with native DB tags and typed properties.

Requires the Logseq desktop app with a DB graph and its HTTP API server enabled (Settings → Developer → HTTP API server). The extension talks only to that server on localhost. It does nothing without Logseq running.

Two modes:

• Web Clipper: captures URL and title, your tags (autocomplete from the graph), optional notes, and any selected text as a highlight. Saved as a [Title](URL) block with child blocks for notes and highlight, in today's journal or a page you choose per graph.

• Tag Properties: pick a tag, fill in its properties, save a fully formed table-view row. Fields render by type: dates get date pickers, checkboxes get checkboxes, choice properties get dropdowns of their allowed values, node properties autocomplete from existing values. If the tag has a URL property, the page URL is pre-filled.

Keyboard first: Tab moves between fields, Enter commits the first tag suggestion, Escape closes. If a save fails, the modal stays open with a Retry button; unsaved work is kept as a draft and offered next time.

Optional CLI tier (Linux): install the Logseq command-line tool and a small native messaging host from the source repository, and captures route straight to any graph, not only the open one, with tag schemas read live from the graph. Off by default; the HTTP tier works without it.

Privacy: captures go only to your Logseq on localhost. Your API token stays on this device unless you turn on the sync option in settings. Nothing is sent to the developer or any third party, and there is no analytics. Full policy: https://github.com/Brerlapn/logseq-expanded-clipper/blob/master/docs/PRIVACY.md

DB graphs only. The extension never writes file-graph property syntax.

Source, installer for the CLI tier, how-to, and issues: https://github.com/Brerlapn/logseq-expanded-clipper

**Official URL / Homepage:** https://github.com/Brerlapn/logseq-expanded-clipper

**Support URL:** https://github.com/Brerlapn/logseq-expanded-clipper/issues

## Privacy tab

**Single purpose:**

> Capture the current page (URL, title, selected text, your notes and tags, or a row of tag properties) into the user's own Logseq DB graph through Logseq's local HTTP API.

**Permission justifications:**

- `activeTab`: Read the URL, title and current selection of the tab the user invokes the clipper on, only when they press the shortcut or toolbar button.
- `scripting`: Inject the capture modal into the current tab on demand; it is not declared as an always-on content script.
- `storage`: Keep the user's settings (API port, target graph, tag field configs) and, on this device by default, their Logseq API token and an unsaved draft.
- `nativeMessaging` (optional): When the user opts in, communicate with the Logseq command-line tool on their computer through a native messaging host they install themselves, so captures can go to any graph. Off by default.
- Host permission `http://localhost/*`: Logseq's HTTP API server listens only on localhost on a user-chosen port; the extension sends captures there and nowhere else.

**Remote code:** No, I am not using remote code.

**Data usage, "what user data do you plan to collect":**

- ☑ Website content (the URL, title and selected text of the page the user clips, sent only to the user's own Logseq on localhost)
- ☑ Authentication information (the user's Logseq API token, stored on their device; placed in their browser account's sync store only if they turn on the sync option)
- ☐ everything else

**Certifications:** tick all three (not sold to third parties outside approved use cases; not used or transferred for purposes unrelated to the single purpose; not used or transferred to determine creditworthiness or for lending).

**Privacy policy URL:** https://github.com/Brerlapn/logseq-expanded-clipper/blob/master/docs/PRIVACY.md

## Distribution tab

Visibility: **Unlisted** for the first submission (plan R11). Free. All regions.

## Test instructions tab

> This extension only works alongside the Logseq desktop app (https://logseq.com, the DB-graph version) with its HTTP API server turned on. Everything it sends goes to http://localhost:<port> on the tester's own machine; it makes no other network requests.
>
> To test with Logseq: open Logseq with a DB graph, go to Settings → Developer, enable "HTTP API server", and copy the token. In the extension's options page paste the token and press "Test connection" (it should report OK). On any web page press Alt+Shift+L or click the toolbar icon: the capture modal opens. Add a tag and a note and press Save. The clip appears in today's journal in Logseq.
>
> To test without Logseq: the modal still opens on Alt+Shift+L and the options page still loads. Pressing Save shows a visible error with a Retry button and the form keeps its content. There is no silent behaviour.
>
> The nativeMessaging permission is optional and off by default. Enabling it requires a separate installer from the source repository and is not needed to review the extension.

## Screenshots to take (1280x800)

1. The capture modal over a real article, Web Clipper tab, with a tag typed and the autocomplete list open.
2. The modal on the Tag Properties tab showing typed fields (a date picker, a dropdown).
3. The options page with the data notice visible under Connection.
