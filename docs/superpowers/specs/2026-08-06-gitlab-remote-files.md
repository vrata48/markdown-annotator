# GitLab Remote Files — Design

**Date:** 2026-08-06
**Status:** Shipped (read path verified against gitlab.com; commit path needs a token to exercise)

Annotate markdown living in a GitLab repo without leaving the browser-only architecture:
the page talks directly to the GitLab REST API (v4) — no middleman server, keeping the
"nothing leaves your machine except your own git host" privacy story.

## Decisions (user-confirmed)

- **GitLab first** (gitlab.com + self-hosted via configurable base URL); GitHub later if wanted.
- **Save = commit to the opened branch.** No auto-branching/MR flow in v1.
- **Auth = personal access token** (api scope), pasted once, stored in localStorage
  (`gitlab-base`, `gitlab-token`). OAuth device flow would need a server — rejected.

## Mechanics

- `state.remote` (`{base, projectId, projectPath, branch, path, lastCommitId}`) is the
  remote counterpart of `state.fileHandle`; exactly one is set for an open file. All
  open/save/watch/reload/recents paths branch on it.
- **Open**: repository files API (`GET /projects/:id/repository/files/:path?ref=`),
  base64 → UTF-8 (`glDecodeB64`). `last_commit_id` captured as the baseline.
- **Save**: `PUT` the same endpoint with `branch`, raw `content`, generated
  `commit_message` (`annotations: <path>`), and `last_commit_id` — GitLab rejects the
  commit (400 "changed") if the file moved, which maps onto the existing conflict banner.
  A follow-up GET re-baselines `lastCommitId`.
- **Watch**: commits API (`?ref_name=&path=&per_page=1`) polled every **15s** (local disk
  stays at 3s). Same auto-reload toggle and banner semantics as disk watching.
- **Picker dialog** (`#gitlab-dialog`): base URL + token config row, project search
  (membership-scoped when a token is set; `group/project` input also does a direct
  lookup), branch input prefilled with the default branch, markdown file list from the
  recursive tree API — capped at the first 500 tree entries (surfaced in the status line
  when hit), same sanity cap as folder mode.
- **Recents**: IndexedDB entries are now `{handle|null, remote|null, name, ts}`; remote
  dedupe compares base+project+branch+path (`sameRemote`). Remote entries silently
  restore on refresh (no permission gesture needed, unlike local handles).

## Caveats

- Self-hosted instances must serve CORS headers on `/api/v4` (gitlab.com does).
- Token in localStorage is readable by anything that can run JS on the origin — accepted
  for a local static page.
- Large repos: file list sees only the first 500 tree entries; use the filter on smaller
  branches or type paths precisely. Blob-search API would lift this later.
