# Cool Ink UI Redesign — Design

**Date:** 2026-08-05
**Status:** Shipped

Retires the warm-parchment "proofreader's desk" identity. Mockups iterated in-conversation
(three toolbar directions considered: hairline bar, pen-tray rail, grouped top bar — rail chosen).

## Identity

- **Palette ("cool ink")** — white sheet (`--paper #FFFFFF`) on a cool slate desk
  (`--desk #E8ECF1`), one ultramarine accent (`--pen #3450B4`). Semantic colors are reserved
  for annotations: amber `--mark` for highlights, `--red-pen` for deletions, `--ok` for
  insertions. Token *names* are unchanged from the old theme so component CSS carried over.
- **`--on-pen`** — text color on an accent background. Ultramarine is dark in light mode
  (white text) but light in dark mode (near-black text); any `background: var(--pen)` must
  pair with `color: var(--on-pen)`.
- **Type** — document drops the Charter serif; both UI and document use the system sans
  stack. Document reads at 16px/1.7 on a full-width sheet.

## Pen-tray rail (replaces the horizontal toolbar)

- 184px vertical rail, left edge, labeled icon rows (icon + text — icon-only was tried and
  rejected as unreadable): app title, open file, open folder, recent (flyout menu of
  recents — originally one combined "Open" dropdown, split on request), save (floppy),
  reload, auto-reload toggle, divider,
  a "View mode" row with a settings-style on/off toggle (icon-only buttons, then a
  segmented Annotate/View control were both tried and rejected), comments (with count
  badge), export; GitHub + theme at the bottom.
- Icons are inline SVG `<defs>` referenced with `<use>`; stroke `currentColor`.
- Save shows a red dot when dirty (`body.dirty`). Dropdown menus (recents, export) fly out
  to the *right* of their rail button.
- File identity moved off the chrome: a tab clipped to the top of the sheet shows
  name/path + unsaved dot (`#file-tab`, visible via `body.file-open`).

## Margin comment rail (replaces the overlay sidebar + inline badges)

- `#rendered-view` is a two-column grid: `minmax(0, 1fr)` sheet + `300px` `#margin-rail`.
  The sheet stretches the full width (an 880px cap was tried and rejected — the original
  stretched layout was preferred). With no annotations (`body:not(.has-notes)`) the margin
  collapses.
- `renderMarginRail()` builds one card per group from `Core.scanAnnotations`; card kinds:
  Comment (amber left edge, quote + text), Note (point, ultramarine edge), Suggested edit
  (green edge, diff summary + Accept/Reject buttons).
- `positionMarginCards()` aligns each card with its first anchor
  (`[data-ann-group]` boundingRect diff against the rail), pushes overlapping cards down
  (12px gap), and sets the rail's height so the shared scroll reaches the lowest card.
  Re-run after mermaid renders, image loads, and window resize.
- Inline badges are gone for highlight groups — the highlight itself is the click-to-edit
  target (`.ann-wrap:not(.ann-edit)`). Point comments keep a compact dot marker (they have
  no text to stand on). Hover is bidirectional: card ↔ anchor (`.hot` class).
- View mode keeps cards visible but inert (`body.view-mode` hides card actions).

## Welcome screen

The app always shows paper: the start page is itself a white sheet (640px card) — app mark
+ title header, one-line pitch, recent files as a list with dates right-aligned, shortcuts
as a footnote row. Iteratively stripped on request: the "continue where you left off"
resume bar (recents cover it; silent restore on refresh remains), the "Open a markdown
file" button, and the drop-zone hint all came out — opening lives in the rail + Ctrl+O +
global drag-drop only. A floating
frameless version was tried and rejected. `#welcome` is a *sibling* of `.content`, toggled
by `body.file-open` — it must not live inside the sheet, or the first render destroys it
(matters for the file tab's × close button, which returns here).

## Not done (considered, deferred)

- Multiple open files as real tabs on the sheet (the tab visual invites it; needs per-file
  dirty/watch state).
- Per-file annotation counts in the folder list (needs reading every file in the tree).
