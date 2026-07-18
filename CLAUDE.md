# Markdown Annotator

Browser-only, single-page markdown annotator. No server, no build step, no package.json — `index.html` (UI + app logic + styles) and `annotator-core.js` (CriticMarkup engine) are the whole app.

## Architecture

- **`annotator-core.js`** — `window.AnnotatorCore` (UMD, also loadable in Node for headless tests). Owns CriticMarkup parsing (`scanAnnotations`), the group model, structure-preserving insertion (`analyzeTarget` / `applyInserts`), and rendering helpers (`preprocessCriticMarkup` / `annHtml`). Change annotation semantics **here**, never in index.html.
- **`index.html`** — everything else: toolbar, rendering (markdown-it + mermaid + highlight.js from CDN), selection→source mapping, popups, document-comments panel, annotate/view modes, File System Access I/O, IndexedDB recents.

## Key concepts

- **Annotations are CriticMarkup in the source**: `{==text==}{>>comment<<}` pairs, `{>>comment<<}` points. A multi-block annotation = several `{==...==}` highlights + one trailing pair, bound into one *group* — edit/delete always operate on group ids from `Core.scanAnnotations`.
- **Doc-level comments** = standalone point comments at the top of the file (after optional YAML frontmatter). Detected positionally (`docZone()`), shown in the top panel, never as inline badges.
- **Placeholder trick**: annotations are swapped for `​ANN{i}​` tokens before markdown-it runs, then swapped back to HTML — keeps pipes/braces from breaking table parsing. Don't "simplify" this away.
- **Modes**: `state.mode` `'annotate' | 'view'`; view mode short-circuits annotation handlers and hides controls via body class `view-mode`.

## File I/O rules (Chromium-only, by decision)

- Open/save via File System Access API (`showOpenFilePicker`, `createWritable`); drag-drop via `getAsFileSystemHandle`. Non-Chromium gets a warning banner — do not add fallbacks without asking.
- Recents = `FileSystemFileHandle` objects persisted in IndexedDB (`md-annotator`/`recents`). Real paths are unavailable to web pages. Dedupe uses `isSameEntry` (async!) — IndexedDB transactions auto-commit while awaiting it, hence the deliberate two-phase read-then-write in `recordRecent`.
- Session restore: `tryRestoreLast()` — silent reopen if permission still granted, otherwise resume bar (requestPermission needs a user gesture).

## Testing / verification

- No test framework. Verify in a real Chromium via a local static server (`python -m http.server`) — the FS API does **not** work from `file://`.
- Automated end-to-end without native dialogs: OPFS handles are real `FileSystemFileHandle`s — `navigator.storage.getDirectory()` → `getFileHandle(name, {create:true})`, then drive `openHandle`/`saveFile` directly. Clean up IDB recents + OPFS files afterwards.

## Conventions

- Design tokens live in `:root` ("proofreader's desk": paper/desk/ink/pen/mark). Use the CSS variables, don't hardcode colors. System font stacks only — no webfonts.
- Watch CSS specificity: `#toolbar button` (id+element) beats `#btn-x` (id) — prefix overrides with `#toolbar`.
- Design specs for shipped features live in `docs/superpowers/specs/`.
- `.lab/` and `in/` are local scratch — never commit them.
