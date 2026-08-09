# Raw source mode

## Goal

Let a reviewer inspect the exact Markdown currently held by the app, including
CriticMarkup and the generated annotation review brief, without leaving the
document workflow.

## Interaction

- A dedicated **Raw source** rail button toggles the mode.
- `Ctrl+Shift+E` / `Cmd+Shift+E` provides the keyboard equivalent.
- Raw source is read-only. All mutations continue through core annotation
  operations so undo snapshots and source offsets remain valid.
- Entering Raw starts at the top so the generated review brief is immediately
  visible. Leaving it restores the rendered document's previous scroll offset.
- The existing View control remains a separate rendered, read-only mode.

## Rendering and safety

The raw `<pre>` receives `state.rawMarkdown` through `textContent`, never
`innerHTML`. Arbitrary source therefore remains inert. While Raw is active, the
rendered document and annotation navigator are hidden, annotation handlers
short-circuit, and open annotation popups are dismissed.

The raw element is refreshed on every normal `render()`, covering local files,
GitLab files, samples, watcher reloads, undo, and annotation mutations.
