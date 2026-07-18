# Markdown Annotator

Browser-only, single-page markdown annotator. No server, no build step, no package.json — `index.html` (markup + styles), `app.js` (app logic), and `annotator-core.js` (CriticMarkup engine) are the whole app.

## Architecture

- **`annotator-core.js`** — `window.AnnotatorCore` (UMD, also loadable in Node — the unit tests require it directly). Owns CriticMarkup parsing (`scanAnnotations`), the group model, accept/reject semantics (`acceptGroup`/`deleteGroup`), `docZone`, structure-preserving insertion (`analyzeTarget`/`applyInserts`/`suggestEdit`), and rendering helpers (`preprocessCriticMarkup`/`annHtml`). Change annotation semantics **here**, never in app.js.
- **`app.js`** — everything else: toolbar, rendering (markdown-it + mermaid + highlight.js from CDN), selection→source mapping, popups, document-comments panel, comments sidebar, folder mode, annotate/view modes, undo, file watching, theme, File System Access I/O, IndexedDB recents, PWA launch handling.
- **`index.html`** — markup + all CSS (design tokens in `:root`, dark set under `:root[data-theme="dark"]`). CDN deps are pinned to exact versions **with SRI hashes** — bumping a version means recomputing the hash (mermaid is pin-only; ESM chain can't use SRI).
- **Tests** — `node --test "tests/*.test.js"`; CI runs them on every push (`.github/workflows/ci.yml`). Core changes without a test are unfinished.

## Key concepts

- **Annotations are CriticMarkup in the source**: `{==text==}{>>comment<<}` pairs, `{>>comment<<}` points, and suggested edits `{--del--}` / `{++ins++}` / `{~~old~>new~~}`. A multi-block annotation = several `{==...==}` highlights + one trailing pair, bound into one *group* — all mutations operate on group ids from `Core.scanAnnotations`.
- **Suggested edits**: `deleteGroup` = reject (revert to original), `acceptGroup` = accept (apply the change). The annotation popup's "Suggest edit" tab only appears for single contiguous range targets.
- **Doc-level comments** = standalone point comments at the top of the file (after optional YAML frontmatter). Detected positionally (`Core.docZone`), shown in the top panel, never as inline badges. del/ins at the top do NOT count as doc comments.
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

- Design tokens live in `:root` ("proofreader's desk": paper/desk/ink/pen/mark) with a dark variant in `:root[data-theme="dark"]`. Use the CSS variables, don't hardcode colors — every hardcoded color needs a light + dark token pair. System font stacks only — no webfonts.
- File watching polls `getFile().lastModified` every 3s: clean → silent reload; dirty → conflict banner. Saves re-baseline `state.lastModified` so they don't self-trigger.
- Undo = `pushUndo()` before every source mutation. Adding a new mutation path without `pushUndo()` breaks Ctrl+Z silently.
- Watch CSS specificity: `#toolbar button` (id+element) beats `#btn-x` (id) — prefix overrides with `#toolbar`.
- Design specs for shipped features live in `docs/superpowers/specs/`.
- `.lab/` and `in/` are local scratch — never commit them.
