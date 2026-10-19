# ADR 0003: Static Tag Config over Dynamic Schema Reading

## Status
Superseded in part by ADR 0004. The Context and Decision below are the 2026 project-start
record and are kept as written; the block that follows says what the extension does today.

## Current state (2026-10-19)
- **With the CLI transport** (native messaging host installed, ADR 0004), Tag Properties mode
  reads a tag's schema live from the graph: `getTagSchema` in the service worker returns the
  properties keyed by `db/ident`, inherited ones included, and any tag in the Target Graph can
  be picked. No manual field setup.
- **Static Tag Config survives in two roles only:** the fallback when the CLI is not installed,
  because the HTTP transport still cannot read schemas; and the source of the pinned tags shown
  first in the tag picker.
- **`getTag()` over the HTTP API is still never called.** The doubt recorded below was never
  resolved; the project went around it through the CLI instead.

## Context
Tag Properties mode needs to know which fields to show for a given tag (e.g., `#music-recs` → artist, album, recommended-by, rating, genre). The ideal implementation would read this schema dynamically from the Logseq DB via `logseq.Editor.getTag()`. However, research into the Logseq DB HTTP API revealed that while `getTag()` exists, it is unconfirmed whether it returns full property schema definitions (field names + types) in a form the extension can consume. The Logseq DB HTTP API was still evolving as of the project start.

## Decision
Use static configuration: the user manually defines tag schemas in extension settings (tag name + list of field name/type pairs). The extension does not call `getTag()` or any schema-reading endpoint.

## Consequences
- Tag Properties mode works reliably without depending on an unverified API shape
- One-time setup cost: users must re-enter field definitions they already have in Logseq DB
- If `getTag()` is later confirmed to return schemas, dynamic reading is a clean v2 upgrade — the static config UI can remain as a fallback/override
- Field types in the static config drive both the input control shown in the modal and the typed value passed to `upsertBlockProperty()`
