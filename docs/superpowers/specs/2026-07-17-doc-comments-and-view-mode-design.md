# Document Comments Panel + Annotate/View Mode — Design

Date: 2026-07-17
Status: Approved

## Feature 1: Document-level comments panel

Comments about the whole document, not anchored to any text.

### Storage (position-based, no new syntax)

- A document comment is a standalone CriticMarkup point comment `{>> ... <<}` located in the "doc zone" at the top of the source.
- Doc zone = optional YAML frontmatter (`---\n ... \n---\n` at offset 0), then a run of standalone `{>> <<}` comments separated only by whitespace. First non-comment content ends the zone.
- New doc comments are appended at the end of the zone (after existing doc comments, after frontmatter if present), followed by a blank line.

### UI

- Panel rendered above the document content whenever a file is open.
- Lists doc comments; each has edit (reuses existing edit popup flow) and delete (×).
- "+ Add comment" button opens inline input; save inserts into the zone, marks dirty, re-renders.
- Empty state: only the low-key "+ Add comment" button.
- Doc-zone comments are NOT rendered as inline point badges in the content; they appear only in the panel.
- Included in the annotation count.

## Feature 2: Annotate / View mode

- Toolbar toggle button right of Source; `Ctrl+E` shortcut. Default mode on open: **Annotate** (current behavior). Not persisted.
- **View mode**: reading mode — text selection, click, and copy behave natively.
  - Selection/click annotation handlers short-circuit.
  - Existing highlights and badges stay visible; hover tooltips work.
  - Badge click does nothing; delete × hidden (CSS by body class); doc-panel add/edit/delete disabled/hidden.
- Mode is pure client state (`state.mode`), body class `view-mode` drives CSS.

## Error handling

Nothing new server-side. Doc comment insert reuses existing dirty/save path.

## Testing

Manual:
1. Add doc comment on file without frontmatter → lands at offset 0, panel shows it, no inline badge.
2. Add on file with frontmatter → lands after closing `---`.
3. Edit/delete doc comment from panel → source updated correctly.
4. Toggle to View → selecting text/clicking produces no popups; copy works; badges visible, not clickable; × hidden.
5. Toggle back → annotation flow works again.
6. Annotation count includes doc comments.
