# Browser-Only Migration + UI Redesign — Design

Date: 2026-07-17
Status: Implemented

## Decision

The app becomes a fully static, client-only page (`index.html` + `annotator-core.js`), hostable on any static host (GitHub Pages, S3, nginx). The Python server is deleted. Chromium-only by choice: Firefox/Safari show a notice instead of a broken app.

## File access (File System Access API)

- Open: `showOpenFilePicker` (toolbar/welcome button, Ctrl+O) or drag-and-drop anywhere on the page (`getAsFileSystemHandle`). Accepted: `.md`, `.markdown`, `.mdx`, `.txt`.
- Save: `handle.createWritable()` writes straight back to the local file (Ctrl+S).
- Reload: re-reads `handle.getFile()`.
- Permissions: `queryPermission`/`requestPermission` with `readwrite` on open.
- Feature gate: `showOpenFilePicker` missing → warning banner on welcome screen, open buttons disabled.

## Recent files

- Real paths are invisible to web pages, so recents store the `FileSystemFileHandle` objects themselves (structured-cloneable) in IndexedDB (`md-annotator` / `recents`), with name + timestamp.
- Cap 10, dedupe via `handle.isSameEntry`, dead handles pruned. Best-effort: failures never block opening.
- Opening a recent re-requests permission (one prompt per session per file).
- Shown in toolbar ▾ dropdown and on the welcome screen.

## UI redesign — "the proofreader's desk"

- Metaphor: a paper manuscript on a desk. Document renders on a raised paper sheet (max 780px, serif — Charter/Sitka/Cambria stack), surrounded by a muted desk chrome (Segoe UI).
- Tokens: paper `#FCFBF8`, desk `#F1EFE9`, ink `#26251F`, editor's blue pencil `#35507B` (accent), highlighter amber `#FFE9A8`, proof red `#B3372B`. System fonts only — no webfont dependency.
- Signature element: segmented ✎ Annotate / 👁 View switch in the toolbar.
- Annotation highlights: amber marker gradient with darker amber underline; comment badges = blue-pencil pills.
- Document comments panel styled as a routing slip (pen-wash blue) clipped above the sheet.
- Welcome screen: serif masthead, primary open button, drop hint, shortcuts, recents.
- Drag-over shows a full-page dashed drop cue.

## Removed

- `server.py`, `recent.json`, all `/api/*` calls, CLI open flow.

## Hosting note

Any static host works. Locally, serve the folder (e.g. `python -m http.server`) — Chromium restricts the File System Access API on `file://` pages.
