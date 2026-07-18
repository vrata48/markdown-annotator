# Markdown Annotator

A browser-only tool for reviewing markdown documents like a proofreader: highlight passages, leave comments, suggest edits, and save everything back into the file as [CriticMarkup](https://criticmarkup.com/) that any person or LLM can read and act on.

**No server, no build, no install.** Serve the folder from any static host and start annotating files on your own disk.

![Markdown Annotator, light theme](docs/screenshots/annotator-light.png)

## Why

Reviewing LLM-generated (or human-written) markdown usually means pasting text back and forth. This tool keeps the feedback *in the file*: comments and suggested edits live in the markdown source as plain-text CriticMarkup, so an LLM working in the same folder can read your notes, address them, and rewrite the file — which the annotator picks up and shows you for the next round.

## Features

### Commenting
- **Inline comments** — select any text (a word, a phrase, across paragraphs) and attach a comment; the passage gets an amber highlight with a comment badge. Stored as `{==text==}{>>comment<<}`.
- **Point comments** — click anywhere in the text to drop a note at that exact spot (`{>>comment<<}`).
- **Diagram comments** — click a rendered mermaid diagram to comment on the whole diagram.
- **Document comments** — a panel at the top of the page holds comments about the document as a whole (stored at the top of the file, after YAML frontmatter if present).
- **Structure protection** — spots that can't be annotated without breaking the markdown formatting are refused with a notice; messy selections degrade gracefully to annotating what they can.

### Suggested edits
- Propose a **replacement** (`{~~old~>new~~}`), **deletion** (`{--gone--}`), or **insertion** (`{++added++}`) — via the "Suggest edit" tab in the annotation popup, or written by an LLM directly into the file.
- Rendered as red strikethrough / green underline; hover shows **✓ accept / ✗ reject**, which rewrite the source accordingly.

### Reviewing
- **Comments sidebar** — every comment and suggestion in one list; click an entry to jump to it in the document.
- **Annotate / View modes** (Ctrl+E) — View mode makes the document behave like a normal page: select, copy, click without popups; annotations stay visible but read-only.
- **Undo** (Ctrl+Z) — reverts annotation operations, 50 steps deep.

### Files
- **Real local files** — opens and saves directly to your disk via the File System Access API. No uploads, nothing leaves your machine.
- **Drag & drop** a `.md` anywhere on the page to open it.
- **Folder mode** — open a directory; a sidebar lists every markdown file in the tree.
- **Recent files** — one click away in the Open file dropdown; the last file reopens automatically after a page refresh (new tabs start clean).
- **Disk watching** — the app notices when the open file changes on disk (an LLM rewriting it, another editor saving). Default: a banner offers to reload. Flip the toolbar **Auto-reload** toggle to have clean files reload silently; conflicting unsaved changes always warn first.

### Comfort
- **Dark mode** (🌙, follows system preference), **installable as a PWA** (registers as a `.md` handler; installed apps also get persistent file permissions, so restores are silent), **mermaid diagrams** rendered inline with right-click copy/download as image, **code highlighting** via highlight.js.

![Markdown Annotator, dark theme](docs/screenshots/annotator-dark.png)

## The LLM workflow

1. Open the doc, mark it up — comments for questions, suggested edits for concrete fixes.
2. Save (Ctrl+S). The CriticMarkup is now in the file.
3. Point your LLM (Claude Code, etc.) at the file: *"address the CriticMarkup comments"*. The markup format is plain text and self-explanatory.
4. The LLM edits the file; the annotator sees the disk change and reloads (or offers to).
5. Review its suggested edits with ✓ / ✗. Repeat.

## Keyboard shortcuts

| Key | Action |
| --- | ------ |
| Ctrl+O | Open file |
| Ctrl+S | Save |
| Ctrl+E | Toggle Annotate / View mode |
| Ctrl+Z | Undo last annotation change |
| Esc | Close popup / menu |

## Requirements

A Chromium browser (Chrome or Edge) — the File System Access API is not available in Firefox/Safari.

## Run

Any static file server, e.g.:

```
python -m http.server 8038
```

then open http://localhost:8038. (The File System Access API doesn't work from `file://` pages, so serve it.)

## Development

- `index.html` — markup + styles (design tokens in `:root`, dark set under `:root[data-theme="dark"]`).
- `app.js` — all app logic (file I/O, rendering, selection mapping, UI).
- `annotator-core.js` — the CriticMarkup engine: parsing, group model, accept/reject, structure-preserving insertion. Pure functions, no DOM — also loads in Node.
- Tests: `node --test "tests/*.test.js"` (runs in CI on every push).

## License

MIT
