# ADR 0002: Content Script Modal over Browser Action Popup

## Status
Accepted

## Context
Browser extension UIs are typically implemented as popups attached to the toolbar icon. Popups close the instant the user clicks anywhere outside them — including while typing in a tags field or notes area. The specification asks for a modal that autocloses only on successful save and lets the user resume work in the browser immediately after.

## Decision
Implement the capture UI as a content script injected directly into the current page as an overlay modal, triggered by the keyboard shortcut `Alt+Shift+L`.

## Consequences
- The modal stays open until explicitly saved or dismissed — click-outside does not close it
- Can be triggered without touching the mouse (keyboard shortcut works from any point in the browsing flow)
- Form state survives accidental focus loss
- The modal cannot be opened on browser-internal pages (`about:`, `moz-extension://`) where content scripts are blocked — acceptable limitation
- More complex to implement than a popup (iframe isolation, z-index management, style isolation to avoid page CSS bleeding in)
- Requires the `activeTab` and `scripting` permissions in the manifest
