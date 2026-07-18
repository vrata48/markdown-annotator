# Markdown Annotator

A single-file, browser-only tool for reviewing markdown documents like a proofreader: highlight passages, leave comments, and save them back into the file as [CriticMarkup](https://criticmarkup.com/) that any person or LLM can read and act on.

**No server, no build, no dependencies to install.** Open `index.html` from any static host and start annotating local files.

## Features

- **Annotate** — select text for a highlighted comment, click for a point comment, click a diagram to comment on it. Comments are embedded in the markdown source as CriticMarkup (`{==text==}{>>comment<<}`).
- **Document comments** — a panel at the top holds comments about the whole document (stored as standalone `{>> ... <<}` at the top of the file, after YAML frontmatter if present).
- **Annotate / View modes** — flip to View (Ctrl+E) to read, select, and copy without triggering annotation popups.
- **Local files, for real** — opens and saves directly to files on your disk via the File System Access API. Drag & drop a `.md` anywhere on the page.
- **Recent files & session restore** — recently opened files one click away; after a refresh the last file reopens (or offers to).
- **Mermaid diagrams** rendered inline; right-click to copy/download as image. Code highlighting via highlight.js.

## Requirements

Chromium browser (Chrome or Edge) — the File System Access API is not available in Firefox/Safari.

## Run

Any static file server, e.g.:

```
python -m http.server 8038
```

then open http://localhost:8038. (The File System Access API doesn't work from `file://` pages, so serve it.)

## Files

- `index.html` — the whole app: UI, styles, and app logic.
- `annotator-core.js` — shared CriticMarkup engine: parsing, group model, structure-preserving insertion (also usable headless for tests).
