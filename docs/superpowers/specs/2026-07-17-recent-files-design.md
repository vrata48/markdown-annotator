# Recent Files Menu — Design

Date: 2026-07-17
Status: Approved (design), pending spec review

## Goal

Let the user reopen recently used markdown files without going through the native Open dialog.

## Overview

Server-side recent list (`recent.json` beside `server.py`), exposed via two new API endpoints. UI shows the list in a toolbar dropdown next to the Open File button and as a clickable section on the welcome (no-file-open) screen.

## Server (`server.py`)

### Storage

- File: `recent.json` in the script directory (`Path(__file__).parent`).
- Format: JSON array of absolute file paths, newest first.
- Cap: 10 entries. Dedupe by absolute path (re-opening an existing entry moves it to the front).
- Write: dump to the file on every update; failure to read/write the file must never break file opening (wrap in try/except, degrade to empty list).

### Recording opens

Append to the recent list on every successful open:

1. CLI argument open in `main()`.
2. Native dialog open in `_handle_pick_file()`.
3. New `_handle_open_path()` (below).

### New endpoints

- `GET /api/recent`
  - Returns `{"files": [{"path": str, "name": str}, ...]}`.
  - Entries whose file no longer exists are filtered out of the response (and pruned from `recent.json`).
- `GET /api/open?path=<urlencoded absolute path>`
  - Validates: file exists, extension in `ALLOWED_EXTENSIONS` (same rules as `/api/pick`).
  - On success: sets `current_file`, records to recent list, returns `{content, name, path}` — same shape as `/api/pick`.
  - On failure: `{"error": ...}` with 400/404; `current_file` unchanged.

## UI (`index.html`)

### Toolbar dropdown

- New `▾` button immediately right of the Open File button.
- Click: fetch `/api/recent`, render dropdown list under the button.
  - Each item: filename (prominent) + full path (dimmed, middle-ellipsized via CSS).
  - Empty list: single disabled row "No recent files".
- Click item: call `/api/open?path=...`; on success load exactly like a pick result (reuse the existing load path used by `pickFile`).
- On open error (e.g. file deleted since listing): `alert` the error, re-fetch and re-render the list; current file stays loaded.
- Dismiss: click outside or Escape closes the dropdown (same pattern as the diagram right-click menu).

### Welcome screen

- "Recent files" section in the existing no-file-open welcome block.
- Same data source (`/api/recent`), same click behavior as dropdown items.
- Hidden entirely when the list is empty.
- Populated on page load when no file is open.

## Error handling summary

- Dead paths: filtered server-side on `/api/recent`; race (deleted between list and click) surfaces as alert + list refresh.
- `recent.json` corrupt/unreadable: treated as empty list; overwritten on next successful open.
- `/api/open` with bad extension or missing file: 400/404 JSON error, no state change.

## Non-goals

- No pinning, clearing, or per-entry remove UI.
- No cross-machine sync.
- No change to save flow or annotation logic.
- No new dependencies.

## Testing

Manual (project has no test harness):

1. Open several files via dialog → dropdown shows them newest-first, capped at 10, no duplicates.
2. Reopen from dropdown → file loads, entry moves to front.
3. Delete a listed file on disk → entry absent from next listing; clicking a stale entry alerts and refreshes.
4. Start server with CLI arg → that file appears in recents.
5. Corrupt `recent.json` by hand → app still opens files; list rebuilds.
6. Welcome screen shows recents when no file open; hidden when list empty.
