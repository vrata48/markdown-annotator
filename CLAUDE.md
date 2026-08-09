# Markdown Annotator

Browser-only, single-page markdown annotator. No server, no build step, no package.json — `index.html` (markup + styles), `app.js` (browser integration), `app-helpers.js` (testable application helpers), and `annotator-core.js` (CriticMarkup engine) are the whole app.

## Architecture

- **`annotator-core.js`** — `window.AnnotatorCore` (UMD, also loadable in Node — the unit tests require it directly). Owns CriticMarkup parsing (`scanAnnotations`), the group model, accept/reject semantics (`acceptGroup`/`deleteGroup`), `docZone`, structure-preserving insertion (`analyzeTarget`/`applyInserts`/`suggestEdit`), and rendering helpers (`preprocessCriticMarkup`/`annHtml`). Change annotation semantics **here**, never in app.js.
- **`app-helpers.js`** — `window.AnnotatorAppHelpers` (UMD, also loadable in Node). Owns pure GitLab blob-URL parsing/candidate generation, selection→source matching helpers, and compact annotation navigation models.
- **`app.js`** — browser integration: the pen-tray rail (left icon toolbar), rendering (markdown-it + mermaid + highlight.js from CDN), popups/dialogs, inline annotation navigation, folder mode, annotate/view modes, undo, file watching, theme, File System Access I/O, IndexedDB recents, PWA launch handling.
- **`index.html`** — markup + all CSS (design tokens in `:root`, dark set under `:root[data-theme="dark"]`). CDN deps are pinned to exact versions **with SRI hashes** — bumping a version means recomputing the hash (mermaid is pin-only; ESM chain can't use SRI).
- **Tests** — `node --test "tests/*.test.js"`; `tests/browser-e2e.cjs` drives real Chromium with OPFS. CI runs both on every push (`.github/workflows/ci.yml`). Core changes without a test are unfinished.

## Key concepts

- **Annotations are CriticMarkup in the source**: `{==text==}{>>comment<<}` pairs, `{>>comment<<}` points, and suggested edits `{--del--}` / `{++ins++}` / `{~~old~>new~~}`. A multi-block annotation = several `{==...==}` highlights + one trailing pair, bound into one *group* — all mutations operate on group ids from `Core.scanAnnotations`.
- **Suggested edits**: `deleteGroup` = reject (revert to original), `acceptGroup` = accept (apply the change). The UI renders and accepts/rejects edits found in the file but no longer creates them — the popup's "Suggest edit" tab was removed (2026-08) on user preference; `Core.suggestEdit` remains for external writers/tests.
- **`Core.docZone`** detects standalone point comments at the top of the file (after optional YAML frontmatter). The dedicated "Document comments" top panel was removed (2026-08); the app no longer calls `docZone` — top-of-file comments render as ordinary inline point badges. The core API + tests remain.
- **Placeholder trick**: annotations are swapped for `​ANN{i}​` tokens before markdown-it runs, then swapped back to HTML — keeps pipes/braces from breaking table parsing. Don't "simplify" this away.
- **Modes**: `state.mode` `'annotate' | 'view'`; view mode short-circuits annotation handlers and hides controls via body class `view-mode`.
- **Comments render inline** as badges beside their passage (`Core.annHtml`); a margin-rail card layout was built during the 2026-08 redesign and reverted on user preference — don't reintroduce it. The whole `.ann-wrap` (not just the badge) is the click-to-edit target. Chrome state rides body classes: `file-open`, `dirty`, `view-mode`.

## File I/O rules (Chromium-only, by decision)

- Open/save via File System Access API (`showOpenFilePicker`, `createWritable`); drag-drop via `getAsFileSystemHandle`. Non-Chromium gets a warning banner — do not add fallbacks without asking.
- **GitLab mode** (2026-08): a file can instead come from a GitLab repo — `state.remote` (`{base, projectId, projectPath, branch, path, lastCommitId}`) replaces `state.fileHandle`. All calls go through `glApi(path, opts, base)` straight from the browser (needs API CORS on self-hosted instances). **Tokens are per instance and memory-only by default**; explicit “Remember” opt-in writes `gitlab-tokens` as base → PAT (legacy single `gitlab-token` still migrates), while `gitlab-base` only remembers the last instance. Every remote call must pass its file's own `r.base`. Blob URLs preserve their ambiguous tail and resolve the longest valid slash-containing branch. Save = commit to the opened branch with `last_commit_id` as optimistic lock (400 → conflict banner), then re-reads the head and compares content, since a foreign commit can land between PUT and GET. Watching polls the commits API every 15s (vs 3s for disk). Every open/save/watch/recents path must handle both `state.fileHandle` and `state.remote`.
- Recents = `FileSystemFileHandle` objects **or** remote descriptors persisted in IndexedDB (`md-annotator`/`recents`), entries `{handle|null, remote|null, name, ts}`. Real paths are unavailable to web pages. Dedupe uses `isSameEntry` (async!) for local, field comparison (`sameRemote`) for remote — IndexedDB transactions auto-commit while awaiting, hence the deliberate two-phase read-then-write in `recordRecent`.
- Session restore: `tryRestoreLast()` — silent reopen after refresh if permission is still granted; otherwise nothing (the welcome recents list covers reopening — requestPermission needs a user gesture anyway).

## Testing / verification

- No test framework. Verify in a real Chromium via a local static server (`python -m http.server`) — the FS API does **not** work from `file://`.
- Automated end-to-end without native dialogs: OPFS handles are real `FileSystemFileHandle`s — `navigator.storage.getDirectory()` → `getFileHandle(name, {create:true})`, then drive `openHandle`/`saveFile` directly. Clean up IDB recents + OPFS files afterwards.

## Conventions

- Design tokens live in `:root` ("cool ink": white sheet on a cool slate desk, ultramarine accent — token names paper/desk/ink/pen/mark are kept from the old theme) with a dark variant in `:root[data-theme="dark"]`. Use the CSS variables, don't hardcode colors — every hardcoded color needs a light + dark token pair. Text on a `--pen` background must use `--on-pen` (ultramarine flips light↔dark). System font stacks only — no webfonts.
- File watching polls `getFile().lastModified` every 3s: clean → silent reload; dirty → conflict banner. Saves re-baseline `state.lastModified` so they don't self-trigger.
- Auto-save (opt-in toggle, **local files only** — remote auto-save would spam commits): `markDirty()` → `scheduleAutoSave()` debounces `saveFile({auto:true})` by 1.5s. It skips silently while `state.diskMoved` is set (the disk/remote version changed under us — set by `showDiskBanner`, it survives banner dismissal and clears only on save/reload/open) or before write permission was granted (the prompt needs a user gesture; the first manual Ctrl+S grants it). The auto path never calls `requestPermission` or `alert`, stats the file before writing to catch edits in the watcher's poll gap, and every open/close/reload path must `cancelAutoSave()` so a pending timer can't save a discarded or switched document.
- Undo = `pushUndo()` before every source mutation. Adding a new mutation path without `pushUndo()` breaks Ctrl+Z silently.
- Any path that replaces `state.rawMarkdown` from **outside** (open, reload, watcher pickup) must call `discardPendingEdits()`: `state.pending` holds source offsets and `state.editingIdx` a group id, both computed against the old text — committing them afterwards splices at the wrong position.
- Comment text is embedded verbatim between `{>>` and `<<}`, so it goes through `Core.safeComment()` (breaks a literal `<<}`) — skipping it lets a user's comment close its own annotation and spill into the document.
- Watch CSS specificity: `#rail button` (id+element) beats `#btn-x` (id) — prefix overrides with `#rail`. Same trap with `.content h2` vs `#welcome h2`.
- Design specs for shipped features live in `docs/superpowers/specs/`.
- `.lab/` and `in/` are local scratch — never commit them.
- Local scripts load with `?v=N` cache-busters (`app-helpers.js?v=1`, `annotator-core.js?v=10`, `app.js?v=42`). Bump core and app together when either interface changes — stale-cache mixes can throw "X is not a function" for users on plain reload. Bump the helper when its browser API changes.
