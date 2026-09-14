# The host's file is the source of a shared session

Status: shipped 2026-09-14. Amends `2026-09-04-shared-sessions.md`, whose
"disk is an export while sharing" rule now applies to guests only.

## Why

Reviewers asked for corrections to the specification to reach the review
room after it was shared, without stopping and re-sharing. The spec owner
keeps editing the file in their editor; the room should show what the file
says.

## Rule

While the host shares, the host's file on disk is the truth. When it changes,
the session becomes the file: text edits appear for everyone, annotations the
file still contains stay, annotations it no longer contains disappear. No
conflict banner, no opt-in, no merge.

## How

- The host's disk watcher keeps polling while sharing. A newer `lastModified`
  runs `adoptDiskCopy`: the file replaces `state.rawMarkdown`, pending popups
  are discarded, the brief is re-synced, and `Collab.pushDisk` sends the
  difference to the shared text as one splice.
- The splice carries the `DISK` transaction origin: it travels to everyone
  like a local change, but the host's Yjs undo manager does not track it.
  Undoing a file change would let auto-save write the old session back over
  the edited file.
- Auto-save's own "did the disk move while I waited" check takes the same
  path for the host instead of showing the banner.
- Starting a share turns auto-save on for the host and takes write permission
  inside the name dialog's click, so the file always carries the session and a
  reload never drops annotations that lived only in the session. The host can
  still switch auto-save off; then a disk reload drops whatever was not saved.
- The reload button and the auto-reload knob stay disabled while sharing; the
  knob shows "on" for the host.
- Guests are unchanged: watcher and reload off, a "save as" copy is an export.

## Tests

`tests/collab-e2e.cjs`: auto-save is on right after sharing; an edit written
to the host's file reaches the guest, a kept annotation stays, a removed one
goes, the file is not written back over, and the host's Ctrl+Z does not undo
the disk change.
