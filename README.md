# Markdown Annotator

[![CI](https://github.com/vrata48/markdown-annotator/actions/workflows/ci.yml/badge.svg)](https://github.com/vrata48/markdown-annotator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Markdown Annotator is a browser-only review tool for Markdown files. Select text, leave comments, review suggested edits, and save the feedback directly into the document as human- and LLM-readable [CriticMarkup](https://criticmarkup.com/). Share a document for a while and several people can annotate it live.

There is no app-specific account, build step, or upload pipeline. The runtime is a static HTML/JavaScript app. The optional shared-session feature adds one small relay you deploy yourself (see below); everything else runs in the browser.

The hosted copy lives at <https://vrata48.github.io/markdown-annotator/>.

## Quick start

1. Open the app in Chrome or Edge, either the hosted copy or a local server (below).
2. Choose **Try a sample document** to explore the UI without granting file access, or choose **Open file**.
3. Select a passage to comment on it, or click beside text to add a point comment.
4. Save with **Ctrl+S**. Comments remain inside the Markdown file as CriticMarkup.

To run the app locally:

```sh
python -m http.server 8038
```

Then open `http://localhost:8038`. Do not open `index.html` through `file://`; the File System Access API requires a secure context such as localhost or HTTPS.

The app can be installed as a tabbed PWA from Chrome or Edge. Opening a `.md` file from the OS then lands as a new tab in the running app window.

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
- Inline numbered markers with a floating card that can be edited or deleted in place; no separate sidebar for feedback.
- **Reply** on any comment starts a thread. Replies are extra `@Name: text` lines inside the same comment, so a conversation stays plain CriticMarkup and the navigator shows the first message with a `+N` reply count.
- A compact annotation navigator with count, previous/next actions, and an overview list.
- Keyboard-accessible comment and suggested-edit controls.
- Annotate, read-only rendered View (`Ctrl+E`), and exact Raw source (`Ctrl+Shift+E`) modes.
- Up to 50 annotation operations in the undo history (`Ctrl+Z`).
- Structure checks that refuse an annotation when inserting it would break the Markdown document. Selections that drag in a stray quote mark or start after a backslash escape are trimmed or widened so they still become one highlight.

### Markdown rendering

- Tables, lists, block quotes, links, fenced code, and syntax highlighting.
- Mermaid diagrams rendered inline, with image/SVG copy and PNG download actions.
- CriticMarkup-looking text inside fenced, inline, and indented code remains literal code. Indented-code detection follows CommonMark, so four-space nested list items are annotatable.
- Raw HTML in Markdown is intentionally rendered as text, not executed.
- Clean export to PDF (via print) and EPUB, with comments removed and suggested edits reverted.

### Local files

- Direct open and save through Chromium's File System Access API.
- Drag and drop for `.md`, `.markdown`, `.mdx`, and `.txt` files.
- Folder browsing with an explicit notice if the safety limits of 500 files or six nested directory levels are reached.
- Recent-file history stored locally in IndexedDB, and per-tab restore of the open file after a refresh.
- External-change detection, optional auto-reload, and conflict warnings for unsaved work.
- Optional debounced auto-save for local files. Permission prompts only happen during a manual save.

### Shared sessions

- **Share** in the rail turns the open document into a live session. Give a display name once, send the copied link, and everyone with it reads and annotates the same document in real time. Changes appear on other screens within a second; concurrent comments both survive and are numbered in document order everywhere.
- Comments made in a session are signed with the author's name (`{>>@Name: comment<<}`), so the file stays readable anywhere.
- Replies in a session are signed the same way and added as single insertions, so two people answering the same comment at once both keep their reply.
- The share panel shows the link, who is in the session, and the connection state. The same person in several tabs counts once. Ctrl+Z undoes only your own changes.
- The document is encrypted in the browser with a key that travels only in the link's `#fragment`. The relay stores ciphertext and forgets the session a day after the last change, or as soon as the host stops sharing.
- The host's file is the source. Starting a share turns auto-save on for the host, so the file follows the session by itself, and any change to the file on disk, from an editor or an LLM, reaches everyone in the session within seconds: text edits appear, comments the file kept stay, comments it lost are gone. Guests use **Save** to pick a copy wherever they like; their copy is an export and never flows back.
- A refresh rejoins the session silently; the host's file is reattached, and the first **Save** re-requests the file permission Chrome drops on refresh. The host closing the tab does not end the session. Stopping it leaves everyone with an editable local copy.
- Documents up to about 2.5 MB can be shared.
- The relay is a tiny Cloudflare Worker in [`relay/`](relay/README.md); deploy it once with `npx wrangler deploy` and point `RELAY_URL` in `collab.js` at it. On localhost the app talks to a local `wrangler dev` relay instead. Without a relay the rest of the app works exactly as before.

## Privacy and security

- Local document contents are read from and written to the selected file handle; they are not uploaded by the app. Shared sessions send only end-to-end encrypted updates to the relay, which cannot read them.
- Markdown raw HTML is disabled, and the app ships a restrictive Content Security Policy.
- Markdown rendering libraries are pinned to specific CDN versions; classic scripts and styles use integrity hashes where the browser supports them. The collaboration library (Yjs) is loaded only when a session starts.

## Current limitations

- Chrome or Edge is required for the supported local-file workflow. Firefox and Safari do not provide the required File System Access API.
- The app reviews suggested edits but does not create them through the UI.
- Comments cannot be nested inside existing annotations.
- CriticMarkup inside code is deliberately treated as literal content.
- Folder mode intentionally stops after 500 Markdown files and skips content deeper than six directory levels.
- Shared sessions need the relay to be reachable; on networks that block WebSockets to `workers.dev` the app keeps working on the local file only.

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
- `collab.js` — shared sessions: the Yjs document, encryption, the relay connection, presence, and the share UI.
- `app-helpers.js` — browser-independent source-mapping, folder, navigator, and collaboration helpers.
- `annotator-core.js` — CriticMarkup parsing, grouping, mutation semantics, and structure-preserving insertion.
- `mermaid-init.js` — pinned Mermaid module initialization.
- `relay/` — the Cloudflare Worker relay for shared sessions, with its own tests and README.
- `tests/` — Node unit tests, the annotate-flow fuzzer, and the real Chromium end-to-end harnesses.
- `docs/superpowers/specs/` — design notes for shipped features.

The production app remains build-free and has no runtime package installation.

## Testing

Install the test-only dependencies without adding them to the project manifest, then run the suites:

```sh
npm install --no-save --no-package-lock playwright@1.55.0 markdown-it@14.1.0 mermaid@11.16.0 yjs@13.6.27
npx playwright install chromium

node --test "tests/*.test.js"          # unit tests (a few use the real markdown-it)
node tests/fuzz-annotate.cjs 1 2000    # random documents and selections against the core
node tests/browser-e2e.cjs             # one real Chromium, local files via OPFS
node --test relay/test/relay.test.cjs  # relay protocol against a local wrangler dev
node tests/collab-e2e.cjs              # two browser contexts sharing through a local relay
```

The relay suites download wrangler on first run. CI runs all of them for pull requests and pushes to `main`.

## License

[MIT](LICENSE)
