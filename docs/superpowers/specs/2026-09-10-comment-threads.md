# Comment threads (replies on annotations)

Status: shipped 2026-09-10.

## Goal

People in a shared session want to answer each other's comments, and the
answers sometimes become a short conversation. Give a comment a Reply action
without inventing a new file format, a new store, or a notion of identity the
app does not have.

## Storage: one comment, one `@Name: text` line per message

A thread is the existing CriticMarkup comment with one message per line:

```
{==the passage==}{>> @Ann: this number looks wrong
@Bob: it is from the Q2 report, see p. 12
@Ann: ok, then the caption needs updating <<}
```

- Comments made in a session are already signed `@Name: text`
  (`Helpers.tagAuthor`), and the scanner already allows newlines inside
  `{>> ... <<}`. A thread is therefore valid CriticMarkup that any editor,
  diff, or the review brief can read. An old single-line comment is a thread
  of one.
- A message starts at a line matching `@Name:` followed by a space or the
  end of the line (`Core.parseThread`). Any other line continues the previous
  message, so a multi-line reply keeps its line breaks. Text before the first
  signed line is an unsigned message.
- The group model does not change: a multi-block annotation still has exactly
  one trailing comment, so accept, reject, delete, numbering and the navigator
  keep working untouched.
- Threads are **not** stored in the relay or in Yjs metadata. The file stays
  the whole truth and a thread survives save, reload and hand-off by email.

## Replies are inserts, never replaces

`Core.replyToGroup(src, group, name, text)` inserts `\n@Name: text` right
after the last non-whitespace character of the comment body, so the source
changes by one contiguous insertion. `Collab.pushLocal` sends a prefix/suffix
diff, and Yjs merges concurrent insertions at the same position: two people
replying to one comment at the same moment both keep their reply. Rewriting
the whole comment (`Core.updateGroup`) would instead duplicate the original
text when two rewrites collide, so the edit popup keeps that path for editing
only.

## UI

- The floating card renders the thread as a list: an author line in small
  caps-like weight and the message below it, with a hairline between
  messages. Unsigned single comments render exactly as before.
- **Reply** sits beside **Delete** in the card actions. It opens the edit
  popup in reply mode: empty textarea, "Reply" button, and, when not in a
  session, a name field prefilled from the remembered share name and saved
  back to it. In a session the reply is signed with the session name and the
  field is hidden. The popup reuses the edit popup's Yjs anchoring, so a
  remote change while the reply box is open rebases the group instead of
  replying to the wrong comment.
- Edit and Delete stay whole-thread: the edit popup shows the raw thread text
  and Delete removes the annotation. Per-message edit/delete is a possible
  later step that the plain-text format leaves open.
- The rail navigator shows the first message and a `+N` reply count; the
  tooltip carries the whole thread.
- No resolved state. The file convention already says a comment is removed
  once addressed, so Delete is resolve.
- The review brief folds a thread onto one line, as it already folds any
  whitespace, so the "one entry per line" invariant holds.

## Tests

- `tests/core.test.js`: `parseThread` shapes, `replyToGroup` as a single
  insertion that leaves everything else byte-identical, thread rendering in
  `annHtml`, and `stripAnnotationHtml` removing the new markup.
- `tests/helpers.test.js`: `annotationGroups` carries the raw comment.
- `tests/collab-e2e.cjs`: a guest replies to the host's comment; host and
  guest reply to the same comment concurrently and both replies survive with
  identical documents on both sides.
