# Annotation review brief

## Goal

An LLM opening an annotated Markdown file should see the unresolved work before
it has to scan the full document. Annotated files therefore carry a generated
brief near the start of their source.

## Source format

- Exact HTML-comment boundary markers identify app-owned content.
- The block is inserted at byte zero, except that a BOM and YAML frontmatter
  remain first so frontmatter semantics are preserved.
- The introduction explains the CriticMarkup review workflow.
- One index entry per logical annotation group includes its type, final source
  line, target or nearby context, and comment/replacement text.
- User-derived values use safe variable-length Markdown code spans and are
  flattened/truncated so they cannot create annotations or forge a boundary.
- The block preserves the document's LF or CRLF convention.

## Lifecycle

`Core.syncReviewBrief` removes any prior generated block and rebuilds it from
`Core.scanAnnotations`. It is idempotent. The app runs it before every render,
so opening an old or externally changed annotated file makes the corrected
source dirty until it is saved. Resolving the last annotation removes the
brief. Undo snapshots include the brief like any other source content.

The app omits the brief from the rendered document because its annotation
navigator already provides the interactive overview, and duplicated target text
would make selection-to-source mapping ambiguous. `Core.stripAll` also removes
the brief from clean exports.

## Verification

Core tests cover all annotation shapes, exact source lines, idempotence,
frontmatter, CRLF, hostile marker/CriticMarkup-like text, refresh/removal, and
clean export. The browser test checks that the brief exists in saved source but
does not appear in the document view.
