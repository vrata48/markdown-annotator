# Shared sessions (live multi-user annotation)

Status: shipped 2026-09-04.

## Goal

Let several people annotate one markdown document at the same time, for a
limited time, without the app growing accounts, a database, or a place where
documents rest in plaintext. The document on disk stays the deliverable; the
session is a temporary, encrypted meeting point.

## Shape

- **Static app + one tiny relay.** `relay/` is a Cloudflare Worker with one
  Durable Object per room. It stores and replays opaque strings. It never
  decrypts, and it does not even load Yjs.
- **End-to-end encryption.** The share link is `https://app/#share=<room>.<key>`.
  The 256-bit AES-GCM key sits in the URL fragment, which browsers never send.
  Every Yjs update is encrypted before it leaves the browser.
- **Rooms are sessions, not documents.** No listing, no history, no identity.
  A room dies 24 hours after its last message, or when the host stops sharing.
- **CRDT over the body only.** The shared text is the markdown *without* the
  generated review brief; every client regenerates the brief locally. Sharing
  derived text would make concurrent edits fight over it.

## Workflow

1. The host opens a local file and presses **Share** in the rail, gives a
   display name, and gets the link copied. Sharing is on: rail label shows
   the participant count, the share panel shows the link, people, and status.
2. A guest opens the link, gives a name, and sees the document. No file
   picker. Comments they make are signed `@Name: text` in the CriticMarkup so
   the file stays readable anywhere.
3. Everyone annotates as usual; changes appear on other screens within a
   second. Concurrent comments both survive; numbering follows document order
   everywhere. Ctrl+Z undoes only your own changes.
4. **Disk is an export.** The host's Ctrl+S writes the session to its file,
   and with auto-save on the file follows the session by itself (remote
   changes schedule a save like local ones). Guests use Save to pick a
   location, after which auto-save applies to them too. The disk watcher and
   reload are disabled while a session is live: they flow the wrong way.
5. Stop sharing (host) deletes the room; guests keep an editable local copy
   and see a banner. A guest can leave at any time. The host closing the tab
   does not end the room, and a host refresh rejoins it with the file handle
   reattached (per-tab session store plus a `share-host` sessionStorage flag).

## Implementation notes

- `collab.js` (loaded before `app.js`): Yjs is imported on demand from
  jsDelivr's `+esm` bundle; the session holds a `Y.Text` for the body and a
  `Y.Map` with the file name. `markDirty()` calls `Collab.pushLocal()`, which
  diffs `state.rawMarkdown` (brief removed) against the shared text and
  applies the single splice; remote updates trigger `applyFromDoc()`, which
  regenerates the brief and re-renders.
- Popups hold source offsets. `Collab.anchorPending` / `anchorEdit` pin them
  as Yjs relative positions and `rebasePending()` moves them when a remote
  change lands, so an open comment box survives someone else's comment
  before it.
- The relay protocol (see `relay/src/index.js`) is a numbered log with
  snapshots: joiners send `?since=<seq>`; a client that sees more than 40
  updates since the last snapshot uploads an encrypted full state so the log
  stays short.
- Tests: `tests/helpers.test.js` (diff, link parsing, author tag),
  `relay/test/relay.test.cjs` (protocol against `wrangler dev`),
  `tests/collab-e2e.cjs` (two browser contexts through a local relay).

## Rejected alternatives

- **Peer to peer (WebRTC)** — no server at all, but fails on corporate
  networks with no fallback.
- **Hosted CRDT service** — no relay code, but an account, a vendor, and
  plaintext on their side unless encrypted anyway.
- **Shared synced folder + merge on reload** — zero infrastructure, but not
  live and not for external collaborators.
