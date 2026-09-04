# Markdown Annotator

[![CI](https://github.com/vrata48/markdown-annotator/actions/workflows/ci.yml/badge.svg)](https://github.com/vrata48/markdown-annotator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Markdown Annotator is a browser-only review tool for Markdown files. Select text, leave comments, review suggested edits, and save the feedback directly into the document as human- and LLM-readable [CriticMarkup](https://criticmarkup.com/).

There is no app-specific account, build step, or upload pipeline. The runtime is a static HTML/JavaScript app. The optional shared-session feature adds one small relay you deploy yourself (see below); everything else runs in the browser.

## Quick start

1. Open the app in Chrome or Edge through a localhost server or an HTTPS host.
2. Choose **Try a sample document** to explore the UI without granting file access, or choose **Open file**.
3. Select a passage to comment on it, or click beside text to add a point comment.
4. Save with **Ctrl+S**. Comments remain inside the Markdown file as CriticMarkup.

To run the app locally:

```sh
python -m http.server 8038
```

Then open `http://localhost:8038`. Do not open `index.html` through `file://`; the File System Access API requires a secure context such as localhost or HTTPS.

## What it stores

Comments and suggested edits are plain text in the document:

```md
{==A passage under review==}{>>Explain this claim.<<}

{>>A point comment.<<}

{~~original wording~>suggested wording~~}
{--suggested deletion--}
{++suggested insertion++}
```

The app creates comments. Suggested edits are expected to come from an external writer, collaborator, or LLM; the app renders them and provides **Accept** and **Reject** controls.

## Features

### Commenting and review

- Inline comments on words, formatted text, table cells, and multi-paragraph selections.
- Point comments at a cursor position and whole-diagram comments on Mermaid blocks.
- Inline badges that can be edited or deleted without moving feedback into a separate sidebar.
- A compact annotation navigator with count, previous/next actions, and an overview list.
- Keyboard-accessible comment and suggested-edit controls.
- Annotate, read-only rendered View (`Ctrl+E`), and exact Raw source (`Ctrl+Shift+E`) modes.
- Up to 50 annotation operations in the undo history (`Ctrl+Z`).
- Structure checks that refuse an annotation when inserting it would break the Markdown document.

### Markdown rendering

- Tables, lists, block quotes, links, fenced code, and syntax highlighting.
- Mermaid diagrams rendered inline, with image/SVG copy and PNG download actions.
- CriticMarkup-looking text inside fenced, inline, and indented code remains literal code.
- Raw HTML in Markdown is intentionally rendered as text, not executed.

### Local files

- Direct open and save through Chromium's File System Access API.
- Drag and drop for `.md`, `.markdown`, `.mdx`, and `.txt` files.
- Folder browsing with an explicit notice if the safety limits of 500 files or six nested directory levels are reached.
- Recent-file history stored locally in IndexedDB.
- External-change detection, optional auto-reload, and conflict warnings for unsaved work.
- Optional debounced auto-save for local files. Permission prompts only happen during a manual save.

### Shared sessions

- **Share** turns the open document into a live session: send the link, and everyone with it reads and annotates the same document in real time.
- Comments made in a session are signed with the author's name (`{>>@Name: comment<<}`), so the file stays readable anywhere.
- The document is encrypted in the browser with a key that travels only in the link's `#fragment`. The relay stores ciphertext and forgets the session a day after the last change.
- Disk stays the deliverable: the host's **Save** writes the session to the original file (with auto-save on, the file follows the session by itself), guests save a copy wherever they like. Stopping the session leaves everyone with an editable local copy.
- The relay is a tiny Cloudflare Worker in [`relay/`](relay/README.md); deploy it once with `npx wrangler deploy` and point `RELAY_URL` in `collab.js` at it. Without a relay the rest of the app works exactly as before.

## Privacy and security

- Local document contents are read from and written to the selected file handle; they are not uploaded by the app. Shared sessions send only end-to-end encrypted updates to the relay.
- Markdown raw HTML is disabled, and the app ships a restrictive Content Security Policy.
- Markdown rendering libraries are pinned to specific CDN versions; classic scripts and styles use integrity hashes where the browser supports them.

## Current limitations

- Chrome or Edge is required for the supported local-file workflow. Firefox and Safari do not provide the required File System Access API.
- The app reviews suggested edits but does not create them through the UI.
- Comments cannot be nested inside existing annotations.
- CriticMarkup inside code is deliberately treated as literal content.
- Folder mode intentionally stops after 500 Markdown files and skips content deeper than six directory levels.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` / `Cmd+O` | Open a file |
| `Ctrl+S` / `Cmd+S` | Save |
| `Ctrl+E` / `Cmd+E` | Toggle Annotate / View mode |
| `Ctrl+Shift+E` / `Cmd+Shift+E` | Toggle exact Raw Markdown source |
| `Ctrl+Z` / `Cmd+Z` | Undo the last annotation operation |
| `Ctrl+Enter` / `Cmd+Enter` | Submit the active comment form |
| `Esc` | Close the active popup or dialog |

## Typical LLM workflow

1. Open a document and add comments describing questions or requested changes.
2. Save the file so the CriticMarkup and its generated review brief become part of the source. The brief appears at the start of the file (after YAML frontmatter, when present) and gives an LLM a direct index of annotation types, source lines, passages, and comments.
3. Ask an LLM working in the same repository to address the CriticMarkup comments and optionally express proposed changes as CriticMarkup suggestions.
4. Let the annotator reload the externally modified file, or confirm the reload when prompted.
5. Review the result and accept or reject suggested edits. Repeat as needed.

The generated review brief is refreshed whenever the file is rendered in Markdown Annotator and disappears after the final annotation is resolved. It is intentionally hidden in the app's document view because the annotation navigator already provides the same overview there. Clean export removes both CriticMarkup and the brief.

## Project structure

- `index.html` — application markup, design tokens, and component styles.
- `app.js` — browser integration, file I/O, rendering, dialogs, recents, and UI behavior.
- `app-helpers.js` — browser-independent source-mapping, folder, and navigator helpers.
- `annotator-core.js` — CriticMarkup parsing, grouping, mutation semantics, and structure-preserving insertion.
- `mermaid-init.js` — pinned Mermaid module initialization.
- `tests/` — Node unit tests and the real Chromium end-to-end harness.

The production app remains build-free and has no runtime package installation.

## Testing

Run the Node tests:

```sh
node --test "tests/*.test.js"
```

For the Chromium end-to-end test, install the CI-only dependencies without adding them to the project manifest:

```sh
npm install --no-save --no-package-lock playwright@1.55.0 markdown-it@14.1.0 mermaid@11.16.0
npx playwright install chromium
node tests/browser-e2e.cjs
```

CI runs both suites for pull requests and pushes to `main`.

## License

[MIT](LICENSE)
