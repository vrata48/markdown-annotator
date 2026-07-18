# Markdown Annotator

A browser-only tool for reviewing markdown documents like a proofreader: highlight passages, leave comments, suggest edits, and save everything back into the file as [CriticMarkup](https://criticmarkup.com/) that any person or LLM can read and act on.

**No server, no build, no install.** Serve the folder from any static host and start annotating local files.

## Features

- **Comments** — select text for a highlighted comment, click for a point comment, click a diagram to comment on it. Stored as `{==text==}{>>comment<<}` in the source.
- **Suggested edits** — propose replacements (`{~~old~>new~~}`), deletions (`{--gone--}`), insertions (`{++added++}`); accept ✓ or reject ✗ inline. Great for reviewing LLM output — or letting an LLM suggest and a human decide.
- **Document comments** — panel at the top for comments about the whole document.
- **Comments sidebar** — every comment and suggestion in one list; click to jump.
- **Annotate / View modes** (Ctrl+E) — flip to View to read, select, and copy without popups.
- **Local files, for real** — File System Access API; drag & drop a `.md` anywhere; folder mode lists a whole directory tree.
- **Stays in sync** — watches the file on disk; picks up external edits (e.g. an LLM rewriting the file) automatically, or warns when they collide with yours.
- **Undo** (Ctrl+Z), recent files, session restore after refresh, dark mode, installable as a PWA.
- **Mermaid diagrams** rendered inline (right-click to copy/download as image), code highlighting via highlight.js.

## Requirements

Chromium browser (Chrome or Edge) — the File System Access API is not available in Firefox/Safari.

## Run

Any static file server, e.g.:

```
python -m http.server 8038
```

then open http://localhost:8038. (The File System Access API doesn't work from `file://` pages, so serve it.)

## Development

- `index.html` — markup + styles (design tokens in `:root`).
- `app.js` — all app logic (file I/O, rendering, selection mapping, UI).
- `annotator-core.js` — the CriticMarkup engine: parsing, group model, structure-preserving insertion. Pure functions, no DOM — also loads in Node.
- Tests: `node --test "tests/*.test.js"` (runs in CI on every push).
