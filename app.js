// ── State ──────────────────────────────────────────────────
const state = {
  rawMarkdown: '',
  fileName: '',
  dirty: false,
  pending: null,
  editingIdx: null,
  fileOpen: false,
  fileHandle: null,   // local file (File System Access API), or
  remote: null,       // GitLab file: { base, projectId, projectPath, branch, path, lastCommitId }
  mode: 'annotate',   // 'annotate' | 'view'
};

const FS_SUPPORTED = typeof window.showOpenFilePicker === 'function';

// ── DOM refs ───────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const contentEl = $('#content');
const renderedView = $('#rendered-view');
const popup = $('#annotation-popup');
const annInput = $('#annotation-input');
const selectedPreview = $('#selected-preview');
const tabName = $('#tab-name');
const editPopup = $('#edit-popup');
const editInput = $('#edit-input');
const saveStatus = $('#save-status');

// ── Markdown-it setup ──────────────────────────────────────
const md = markdownit({
  html: true,
  linkify: true,
  typographer: true,
  highlight(str, lang) {
    if (lang && typeof hljs !== 'undefined' && hljs.getLanguage(lang)) {
      try { return hljs.highlight(str, { language: lang }).value; } catch (_) {}
    }
    return '';
  }
});

// Shared source-level annotation logic (also used by the headless test harness):
// classification (analyzeTarget), insertion (applyInserts), and the mermaid
// fence override. The local render helpers below stay as-is.
const Core = window.AnnotatorCore;
Core.configureMd(md);

// ── File I/O via the File System Access API ────────────────
// The app is a static page: the browser itself shows the open dialog and
// writes saves straight back to the local file. Chromium-only.
const FILE_TYPES = [{
  description: 'Markdown files',
  accept: { 'text/markdown': ['.md', '.markdown', '.mdx', '.txt'] },
}];

async function openHandle(handle, opts) {
  const silent = opts && opts.silent;
  if (state.dirty && !confirm('You have unsaved changes. Open another file anyway?')) return;
  try {
    // Read-only here: asking for readwrite at open time makes Chrome show a
    // confusing "Save changes to file?" prompt. Write access is requested on
    // the first actual save, where the prompt matches the user's intent.
    if (await handle.queryPermission({ mode: 'read' }) !== 'granted' &&
        await handle.requestPermission({ mode: 'read' }) !== 'granted') {
      if (!silent) showNotice('File access was not granted.');
      return;
    }
    const file = await handle.getFile();
    state.rawMarkdown = await file.text();
    state.fileHandle = handle;
    state.remote = null;
    state.fileName = file.name;
    state.displayPath = file.name;  // real paths are hidden from web pages
    state.dirty = false;
    state.fileOpen = true;
    state.lastModified = file.lastModified;
    clearUndo();
    render();
    recordRecent({ handle, name: handle.name });
    startWatch();
    // Refresh restores the file silently; a fresh tab starts on the welcome
    // screen. sessionStorage survives reload but not new tabs — exactly that.
    try { sessionStorage.setItem('had-file', '1'); } catch (_) {}
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (!silent) alert('Failed to open file: ' + e.message);
  }
}

// After a page refresh, reopen the last file if permission survived (it
// usually drops back to 'prompt' on reload, and requestPermission needs a
// user gesture). When it didn't survive, the recents list covers reopening.
async function tryRestoreLast() {
  if (!FS_SUPPORTED || state.fileOpen) return;
  let wasRefresh = false;
  try { wasRefresh = sessionStorage.getItem('had-file') === '1'; } catch (_) {}
  if (!wasRefresh) return;
  const rec = await fetchRecent();
  if (!rec.length) return;
  const last = rec[0];
  if (last.remote) {  // token needs no user gesture — reopen silently
    await openGitLabFile(last.remote, { silent: true });
    return;
  }
  try {
    if (await last.handle.queryPermission({ mode: 'read' }) === 'granted') {
      await openHandle(last.handle, { silent: true });
    }
  } catch (_) { /* dead handle — recents pruning will catch it */ }
}

async function pickFile() {
  if (!FS_SUPPORTED) return;
  try {
    const [handle] = await window.showOpenFilePicker({ types: FILE_TYPES });
    if (handle) await openHandle(handle);
  } catch (e) {
    if (e && e.name !== 'AbortError') alert('Failed to open file: ' + e.message);
  }
}

async function reloadFromDisk() {
  try {
    if (state.remote) {
      showProgress('Reloading from GitLab…');
      await reloadFromGitLab();
      showNotice('Reloaded from GitLab', 'ok');
      return;
    }
    if (!state.fileHandle) return;
    const file = await state.fileHandle.getFile();
    state.rawMarkdown = await file.text();
    state.dirty = false;
    state.lastModified = file.lastModified;
    clearUndo();
    hideDiskBanner();
    render();
    showNotice('Reloaded from disk', 'ok');
  } catch (e) {
    hideProgress();
    alert('Failed to reload file: ' + e.message);
  }
}

// ── File watching: catch external edits (e.g. an LLM rewriting the file) ──
// Local files poll lastModified every 3s; GitLab files poll the commits API
// every 15s (gentler on the server, same behavior).
let watchTimer = null;
function startWatch() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(checkDiskChange, state.remote ? 15000 : 3000);
}

async function checkDiskChange() {
  if (!state.fileOpen || document.hidden) return;
  if (state.remote) {
    try {
      const latest = await glLatestCommitId();
      if (!latest || latest === state.remote.lastCommitId) return;
      if (!state.dirty && getAutoReload()) {
        await reloadFromGitLab();
        showNotice('File changed on GitLab — reloaded');
      } else {
        state.remote.lastCommitId = latest;
        showDiskBanner(state.dirty);
      }
    } catch (_) { /* transient API failure — try again next tick */ }
    return;
  }
  if (!state.fileHandle) return;
  try {
    const file = await state.fileHandle.getFile();
    if (file.lastModified <= state.lastModified) return;
    if (!state.dirty && getAutoReload()) {
      // Opted in and no local changes — pick up the new content silently.
      state.rawMarkdown = await file.text();
      state.lastModified = file.lastModified;
      clearUndo();
      render();
      showNotice('File changed on disk — reloaded');
    } else {
      state.lastModified = file.lastModified;
      showDiskBanner(state.dirty);
    }
  } catch (_) { /* transient read failure — try again next tick */ }
}

function showDiskBanner(conflict) {
  const where = state.remote ? 'on GitLab' : 'on disk';
  $('#disk-banner-msg').textContent = conflict
    ? 'This file changed ' + where + ' and you have unsaved changes. Saving will overwrite that version.'
    : 'This file changed ' + where + '.';
  $('#btn-disk-reload').textContent = conflict ? 'Reload (discard mine)' : 'Reload';
  $('#disk-banner').style.display = 'flex';
}
function hideDiskBanner() { $('#disk-banner').style.display = 'none'; }

// ── Settings ────────────────────────────────────────────────
function getAutoReload() {
  try { return localStorage.getItem('auto-reload') === '1'; } catch (_) { return false; }
}
function refreshAutoReloadButton() {
  const on = getAutoReload();
  const btn = $('#btn-autoreload');
  btn.title = 'Auto-reload external changes: ' + (on ? 'on' : 'off');
  btn.classList.toggle('on', on);
}
$('#btn-autoreload').addEventListener('click', () => {
  try { localStorage.setItem('auto-reload', getAutoReload() ? '0' : '1'); } catch (_) {}
  refreshAutoReloadButton();
  updateToolbar();
});
refreshAutoReloadButton();

// ── Auto-save (local files only — a remote auto-save would spam commits) ──
function getAutoSave() {
  try { return localStorage.getItem('auto-save') === '1'; } catch (_) { return false; }
}
function refreshAutoSaveButton() {
  const on = getAutoSave();
  const btn = $('#btn-autosave');
  btn.title = 'Auto-save local files shortly after each change: ' + (on ? 'on' : 'off');
  btn.classList.toggle('on', on);
}
$('#btn-autosave').addEventListener('click', () => {
  try { localStorage.setItem('auto-save', getAutoSave() ? '0' : '1'); } catch (_) {}
  refreshAutoSaveButton();
  updateToolbar();
  scheduleAutoSave();  // just turned on with unsaved changes → save them
});
refreshAutoSaveButton();

let autoSaveTimer = null;
function scheduleAutoSave() {
  if (!getAutoSave() || !state.fileHandle || state.remote) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    if (!state.dirty || !getAutoSave() || !state.fileHandle || state.remote) return;
    // A conflict banner means the disk version moved — never overwrite it silently.
    if ($('#disk-banner').style.display === 'flex') return;
    // The browser's permission prompt needs a user gesture a timer doesn't have;
    // until the first manual save grants write access, stay dirty quietly.
    try {
      if (await state.fileHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') return;
    } catch (_) { return; }
    saveFile();
  }, 1500);
}

// ── Folder mode: browse a directory of markdown files ──────
const fileSidebar = $('#file-sidebar');
let folder = null;  // { name, files: [{path, handle}], currentPath }

async function pickFolder() {
  if (typeof window.showDirectoryPicker !== 'function') return;
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    const files = [];
    await collectMarkdownFiles(dir, '', files, 0);
    files.sort((a, b) => a.path.localeCompare(b.path));
    folder = { name: dir.name, files, currentPath: null };
    renderFileSidebar();
    fileSidebar.classList.add('visible');
    if (!files.length) return;
    if (files.length === 1) openFolderFile(files[0]);
  } catch (e) {
    if (e && e.name !== 'AbortError') alert('Failed to open folder: ' + e.message);
  }
}

async function collectMarkdownFiles(dir, prefix, out, depth) {
  if (depth > 6 || out.length >= 500) return;   // sanity caps for huge trees
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    if (handle.kind === 'directory') {
      await collectMarkdownFiles(handle, prefix + name + '/', out, depth + 1);
    } else if (/\.(md|markdown|mdx|txt)$/i.test(name)) {
      out.push({ path: prefix + name, handle });
    }
  }
}

function renderFileSidebar() {
  if (!folder) return;
  $('#folder-name').textContent = folder.name;
  $('#folder-name').title = folder.name;
  const list = $('#file-list');
  list.innerHTML = '';
  if (!folder.files.length) {
    list.innerHTML = '<div class="file-empty">No markdown files in this folder.</div>';
    return;
  }
  for (const f of folder.files) {
    const btn = document.createElement('button');
    btn.className = 'file-item' + (f.path === folder.currentPath ? ' current' : '');
    btn.textContent = f.path;
    btn.title = f.path;
    btn.addEventListener('click', () => openFolderFile(f));
    list.appendChild(btn);
  }
}

async function openFolderFile(f) {
  await openHandle(f.handle);
  if (state.fileOpen && state.fileHandle === f.handle) {
    folder.currentPath = f.path;
    state.displayPath = folder.name + '/' + f.path;
    updateToolbar();
    renderFileSidebar();
  }
}

// ── GitLab: open/annotate/commit repo files via the REST API ─────────────
// Browser-only: the page talks straight to the user's GitLab (gitlab.com or
// self-hosted) with a personal access token. Token + base URL live in
// localStorage; a remote file is state.remote instead of state.fileHandle.
function glConfig() {
  let base = '', token = '';
  try {
    base = localStorage.getItem('gitlab-base') || '';
    token = localStorage.getItem('gitlab-token') || '';
  } catch (_) {}
  return { base: (base || 'https://gitlab.com').replace(/\/+$/, ''), token };
}
function glSaveConfig(base, token) {
  try {
    localStorage.setItem('gitlab-base', base.trim());
    localStorage.setItem('gitlab-token', token.trim());
  } catch (_) {}
}

async function glApi(path, opts) {
  const { base, token } = glConfig();
  const headers = Object.assign({}, opts && opts.headers);
  if (token) headers['PRIVATE-TOKEN'] = token;
  let res;
  try {
    res = await fetch(base + '/api/v4' + path, Object.assign({}, opts, { headers }));
  } catch (e) {
    throw new Error('Could not reach ' + base + ' — network or CORS issue.');
  }
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try {
      const j = await res.json();
      if (j.message) msg = typeof j.message === 'string' ? j.message : JSON.stringify(j.message);
      else if (j.error) msg = j.error;
    } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// GitLab serves file content base64-encoded; decode/encode as UTF-8.
function glDecodeB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function openGitLabFile(desc, opts) {
  const silent = opts && opts.silent;
  if (state.dirty && !confirm('You have unsaved changes. Open another file anyway?')) return;
  showProgress('Opening ' + desc.path + ' from GitLab…');
  try {
    const f = await glApi('/projects/' + desc.projectId + '/repository/files/' +
      encodeURIComponent(desc.path) + '?ref=' + encodeURIComponent(desc.branch));
    state.rawMarkdown = glDecodeB64(f.content);
    state.fileHandle = null;
    state.remote = {
      base: glConfig().base,
      projectId: desc.projectId,
      projectPath: desc.projectPath,
      branch: desc.branch,
      path: desc.path,
      lastCommitId: f.last_commit_id,
    };
    state.fileName = desc.path.split('/').pop();
    state.displayPath = desc.projectPath + '/' + desc.path + ' @ ' + desc.branch;
    state.dirty = false;
    state.fileOpen = true;
    clearUndo();
    render();
    recordRecent({ remote: state.remote, name: state.displayPath });
    startWatch();
    try { sessionStorage.setItem('had-file', '1'); } catch (_) {}
    showNotice('Opened ' + state.fileName + ' from GitLab (' + desc.branch + ')', 'ok');
  } catch (e) {
    hideProgress();
    if (!silent) showNotice('GitLab: ' + e.message);
  }
}

// Save = commit to the branch the file was opened from. last_commit_id gives
// optimistic locking: GitLab rejects the commit if the file changed meanwhile.
async function glCommit(content) {
  const r = state.remote;
  await glApi('/projects/' + r.projectId + '/repository/files/' + encodeURIComponent(r.path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch: r.branch,
      content,
      commit_message: 'annotations: ' + r.path,
      last_commit_id: r.lastCommitId,
    }),
  });
  const f = await glApi('/projects/' + r.projectId + '/repository/files/' +
    encodeURIComponent(r.path) + '?ref=' + encodeURIComponent(r.branch));
  r.lastCommitId = f.last_commit_id;
}

// Latest commit touching the file on its branch — the remote "lastModified".
async function glLatestCommitId() {
  const r = state.remote;
  const commits = await glApi('/projects/' + r.projectId + '/repository/commits?ref_name=' +
    encodeURIComponent(r.branch) + '&path=' + encodeURIComponent(r.path) + '&per_page=1');
  return commits[0] && commits[0].id;
}

async function reloadFromGitLab() {
  const r = state.remote;
  const f = await glApi('/projects/' + r.projectId + '/repository/files/' +
    encodeURIComponent(r.path) + '?ref=' + encodeURIComponent(r.branch));
  state.rawMarkdown = glDecodeB64(f.content);
  r.lastCommitId = f.last_commit_id;
  state.dirty = false;
  clearUndo();
  hideDiskBanner();
  render();
}

// ── Remote commit dialog: current branch, or another branch (+ MR) ────────
// Shown on the first save of each remote file; the choice sticks for the
// session (switching branch re-points state.remote, so later saves, the
// watcher, and reloads all follow the annotation branch).
const commitDialog = $('#commit-dialog');

function cdSetStatus(msg, isError) {
  const el = $('#cd-status');
  el.textContent = msg || '';
  el.classList.toggle('gl-error', !!isError);
}

function showCommitDialog() {
  $('#cd-branch-name').textContent = state.remote.branch;
  $('#cd-mr-target').textContent = state.remote.branch;
  if (!$('#cd-branch').value.trim()) {
    $('#cd-branch').value = 'annotations/' + state.fileName.replace(/\.[^.]+$/, '').toLowerCase();
  }
  cdSetStatus('');
  cdSyncRows();
  commitDialog.classList.add('visible');
}
function hideCommitDialog() { commitDialog.classList.remove('visible'); }
function cdSyncRows() {
  $('#cd-other-row').classList.toggle('cd-disabled', !$('#cd-other').checked);
}

async function ensureMergeRequest(r, targetBranch) {
  const existing = await glApi('/projects/' + r.projectId + '/merge_requests?state=opened' +
    '&source_branch=' + encodeURIComponent(r.branch) + '&target_branch=' + encodeURIComponent(targetBranch));
  if (existing.length) {
    showNotice('Committed — merge request !' + existing[0].iid + ' is already open', 'ok');
    return;
  }
  const mr = await glApi('/projects/' + r.projectId + '/merge_requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_branch: r.branch,
      target_branch: targetBranch,
      title: 'Annotations: ' + r.path,
      remove_source_branch: true,
    }),
  });
  showNotice('Committed — merge request !' + mr.iid + ' opened', 'ok');
}

async function cdCommit() {
  const r = state.remote;
  if (!r) { hideCommitDialog(); return; }
  if (!$('#cd-other').checked) {
    r.saveConfigured = true;
    hideCommitDialog();
    await saveFile();
    return;
  }
  const target = $('#cd-branch').value.trim();
  if (!target) { cdSetStatus('Branch name is required.', true); return; }
  const src = r.branch;
  $('#cd-commit').disabled = true;
  cdSetStatus('Preparing branch…');
  try {
    let exists = true;
    try {
      await glApi('/projects/' + r.projectId + '/repository/branches/' + encodeURIComponent(target));
    } catch (_) { exists = false; }
    if (!exists) {
      await glApi('/projects/' + r.projectId + '/repository/branches?branch=' + encodeURIComponent(target) +
        '&ref=' + encodeURIComponent(src), { method: 'POST' });
    }
    // The open file now lives on the annotation branch; MRs point back home.
    r.mrTarget = src;
    r.branch = target;
    r.saveConfigured = true;
    state.displayPath = r.projectPath + '/' + r.path + ' @ ' + target;
    hideCommitDialog();
    await saveFile();
    if (!state.dirty && $('#cd-mr').checked) await ensureMergeRequest(r, src);
    recordRecent({ remote: r, name: state.displayPath });
    updateToolbar();
  } catch (e) {
    cdSetStatus('GitLab: ' + e.message, true);
  } finally {
    $('#cd-commit').disabled = false;
  }
}

$('#cd-close').addEventListener('click', hideCommitDialog);
$('#cd-commit').addEventListener('click', cdCommit);
$('#cd-current').addEventListener('change', cdSyncRows);
$('#cd-other').addEventListener('change', cdSyncRows);
$('#cd-branch').addEventListener('focus', () => { $('#cd-other').checked = true; cdSyncRows(); });
$('#cd-branch').addEventListener('keydown', (e) => { if (e.key === 'Enter') cdCommit(); });
document.addEventListener('mousedown', (e) => {
  if (commitDialog.classList.contains('visible') && !commitDialog.contains(e.target)) hideCommitDialog();
});

// ── GitLab dialog: one file link + one token ───────────────
const glDialog = $('#gitlab-dialog');
const glStatus = $('#gl-status');

function glSetStatus(msg, isError) {
  glStatus.textContent = msg || '';
  glStatus.classList.toggle('gl-error', !!isError);
}

function showGitLabDialog() {
  $('#gl-token').value = glConfig().token;  // remembered; the base comes from the link
  $('#gl-url').value = '';
  glSetStatus('');
  glDialog.classList.add('visible');
  $('#gl-url').focus();
}
function hideGitLabDialog() { glDialog.classList.remove('visible'); }

// Parse a pasted GitLab file URL: <base>/<group/sub/project>/-/blob/<ref>/<file path>
function parseGitLabUrl(input) {
  let u;
  try { u = new URL(input.trim()); } catch (_) { return null; }
  const m = u.pathname.match(/^\/(.+?)\/-\/blob\/([^/]+)\/(.+?)$/);
  if (!m) return null;
  return {
    base: u.origin,
    projectPath: decodeURIComponent(m[1]),
    ref: decodeURIComponent(m[2]),
    path: decodeURIComponent(m[3].split('?')[0].split('#')[0]),
  };
}

// Resolve the link and open the file. A ref that isn't a branch (pinned
// commit SHA) falls back to the default branch — commits need a branch.
async function glOpenFromDialog() {
  const parsed = parseGitLabUrl($('#gl-url').value);
  if (!parsed) {
    glSetStatus('Paste a link to a file in a GitLab repo — the URL contains /-/blob/.', true);
    return;
  }
  glSaveConfig(parsed.base, $('#gl-token').value);
  glSetStatus('Opening ' + parsed.projectPath + '/' + parsed.path + '…');
  try {
    const proj = await glApi('/projects/' + encodeURIComponent(parsed.projectPath));
    let branch = parsed.ref;
    try {
      await glApi('/projects/' + proj.id + '/repository/branches/' + encodeURIComponent(branch));
    } catch (_) {
      branch = proj.default_branch;
      showNotice('Link pins a commit — opened branch "' + branch + '" instead');
    }
    hideGitLabDialog();
    await openGitLabFile({ projectId: proj.id, projectPath: proj.path_with_namespace, branch, path: parsed.path });
  } catch (e) {
    glSetStatus('GitLab: ' + e.message, true);
  }
}

$('#btn-gitlab').addEventListener('click', (e) => {
  e.stopPropagation();
  if (glDialog.classList.contains('visible')) hideGitLabDialog();
  else showGitLabDialog();
});
$('#gl-close').addEventListener('click', hideGitLabDialog);
$('#gl-open').addEventListener('click', glOpenFromDialog);
$('#gl-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') glOpenFromDialog(); });
$('#gl-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') glOpenFromDialog(); });
document.addEventListener('mousedown', (e) => {
  if (glDialog.classList.contains('visible') && !glDialog.contains(e.target) && !e.target.closest('#btn-gitlab')) {
    hideGitLabDialog();
  }
});

// ── Recent files (file handles persisted in IndexedDB) ─────
// Web pages never see real paths; we keep the FileSystemFileHandle objects
// themselves (they are structured-cloneable) and re-request permission on use.
const IDB_NAME = 'md-annotator';
const IDB_STORE = 'recents';
const MAX_RECENT = 10;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function fetchRecent() {
  try {
    const db = await idbOpen();
    const all = await idbRequest(db.transaction(IDB_STORE).objectStore(IDB_STORE).getAll());
    db.close();
    return all.sort((a, b) => b.ts - a.ts);
  } catch (e) {
    return [];
  }
}

function sameRemote(a, b) {
  return a && b && a.base === b.base && String(a.projectId) === String(b.projectId) &&
    a.branch === b.branch && a.path === b.path;
}

// entry: { handle, name } for local files, { remote, name } for GitLab files.
async function recordRecent(entry) {
  try {
    const db = await idbOpen();
    let all = await idbRequest(db.transaction(IDB_STORE).objectStore(IDB_STORE).getAll());
    // Dedupe: drop entries pointing at the same file and trim.
    const drop = [];
    for (const e of all) {
      if (entry.remote) {
        if (sameRemote(e.remote, entry.remote)) drop.push(e.id);
      } else if (e.handle) {
        try { if (await e.handle.isSameEntry(entry.handle)) drop.push(e.id); }
        catch (_) { drop.push(e.id); }  // dead/uncloneable handle — prune
      }
    }
    all = all.filter(e => !drop.includes(e.id)).sort((a, b) => b.ts - a.ts);
    for (const e of all.slice(MAX_RECENT - 1)) drop.push(e.id);
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    for (const id of drop) store.delete(id);
    store.add({ handle: entry.handle || null, remote: entry.remote || null, name: entry.name, ts: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (e) { /* recents are best-effort */ }
}

async function clearRecents() {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (_) { /* best-effort, like the rest of recents */ }
  refreshWelcomeRecent();
}

// ── Recent files UI ────────────────────────────────────────
const recentMenu = $('#recent-menu');
const welcomeRecent = $('#welcome-recent');
$('#btn-clear-recent').addEventListener('click', clearRecents);

function recentItemButton(f) {
  const btn = document.createElement('button');
  const name = document.createElement('span');
  name.className = 'recent-name';
  name.textContent = f.name;
  const meta = document.createElement('span');
  meta.className = 'recent-path';
  meta.textContent = (f.remote ? 'GitLab · ' : '') + 'opened ' + new Date(f.ts).toLocaleDateString();
  btn.append(name, meta);
  btn.addEventListener('click', () => {
    hideRecentMenu();
    if (f.remote) openGitLabFile(f.remote);
    else openHandle(f.handle);
  });
  return btn;
}

function hideRecentMenu() { recentMenu.classList.remove('visible'); }

// Dropdown beside the rail's Recent button: recently opened files.
async function showRecentMenu() {
  const files = await fetchRecent();
  recentMenu.innerHTML = '';
  if (files.length > 0) {
    files.forEach(f => recentMenu.appendChild(recentItemButton(f)));
    const sep = document.createElement('div');
    sep.className = 'recent-sep';
    recentMenu.appendChild(sep);
    const clear = document.createElement('button');
    clear.textContent = 'Clear recents';
    clear.addEventListener('click', () => { hideRecentMenu(); clearRecents(); });
    recentMenu.appendChild(clear);
  } else {
    const none = document.createElement('button');
    none.textContent = 'No recent files';
    none.disabled = true;
    recentMenu.appendChild(none);
  }
  // The button lives in the left rail — the menu flies out to its right.
  const rect = $('#btn-recent').getBoundingClientRect();
  recentMenu.style.left = (rect.right + 8) + 'px';
  recentMenu.style.top = Math.min(rect.top, window.innerHeight - 320) + 'px';
  recentMenu.classList.add('visible');
}

async function refreshWelcomeRecent() {
  if (state.fileOpen) return;
  const files = await fetchRecent();
  const list = $('#welcome-recent-list');
  list.innerHTML = '';
  files.forEach(f => list.appendChild(recentItemButton(f)));
  welcomeRecent.style.display = files.length ? 'block' : 'none';
}

let savePending = false;
async function saveFile() {
  if (!state.fileOpen || savePending) return;
  if (!state.fileHandle && !state.remote) return;
  // First save of a remote file: ask where the commit should go.
  if (state.remote && !state.remote.saveConfigured) { showCommitDialog(); return; }
  savePending = true;
  const content = state.rawMarkdown;
  try {
    if (state.remote) {
      showProgress('Committing to GitLab…');
      await glCommit(content);  // re-baselines lastCommitId itself
      hideProgress();
    } else {
      if (await state.fileHandle.queryPermission({ mode: 'readwrite' }) !== 'granted' &&
          await state.fileHandle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        alert('Write access was not granted — the file was not saved.');
        return;
      }
      const writable = await state.fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      // Re-baseline the watcher so our own write isn't reported as external.
      try { state.lastModified = (await state.fileHandle.getFile()).lastModified; } catch (_) {}
    }
    // Only clear dirty if nothing changed while the write was in flight.
    if (state.rawMarkdown === content) {
      state.dirty = false;
      updateToolbar();
    }
    flashSaved();
    hideDiskBanner();
  } catch (e) {
    hideProgress();
    // GitLab rejects the commit when the file moved under us (optimistic lock).
    if (state.remote && e.status === 400 && /changed/i.test(e.message)) {
      showDiskBanner(true);
    } else {
      alert('Save failed: ' + e.message);
    }
  } finally {
    savePending = false;
  }
}

function flashSaved() {
  saveStatus.classList.add('show');
  setTimeout(() => saveStatus.classList.remove('show'), 1500);
}

// ── Close the current document (× on the file tab) ─────────
function closeFile() {
  if (!state.fileOpen) return;
  if (state.dirty && !confirm('You have unsaved changes. Close anyway?')) return;
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  state.rawMarkdown = '';
  state.fileName = '';
  state.displayPath = '';
  state.fileHandle = null;
  state.remote = null;
  state.dirty = false;
  state.fileOpen = false;
  clearUndo();
  hideAnnotationPopup();
  hideEditPopup();
  hideDiskBanner();
  contentEl.innerHTML = '';
  setMode('annotate');
  if (folder) { folder.currentPath = null; renderFileSidebar(); }
  // A refresh after closing should land on the welcome screen, not reopen.
  try { sessionStorage.removeItem('had-file'); } catch (_) {}
  updateToolbar();
  refreshWelcomeRecent();
}
$('#btn-close-file').addEventListener('click', closeFile);


// ── Render ─────────────────────────────────────────────────
function render() {
  const scrollTop = renderedView.scrollTop;
  // Use the shared core: highlighted text is rendered as inline markdown, so a
  // highlight covering **bold**/links/`code` stays one annotation.
  const { preprocessed, count, placeholders } = Core.preprocessCriticMarkup(state.rawMarkdown);
  let rendered = md.render(preprocessed);
  // Swap placeholders back to annotation HTML after markdown-it is done,
  // so table/block parsing isn't broken by inline annotation spans.
  for (const e of placeholders) {
    rendered = rendered.split(e.placeholder).join(Core.annHtml(md, e));
  }
  rendered = rendered.replace(/<p>\s*<\/p>/g, '');
  contentEl.innerHTML = rendered;
  renderedView.scrollTop = scrollTop;

  contentEl.querySelectorAll('.ann-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.mode === 'view') return;
      deleteAnnotation(parseInt(btn.dataset.annGroup, 10));
    });
  });

  // Click anywhere on a comment annotation (highlight, point marker) → edit
  // the group's comment. Suggested edits keep their own accept/reject controls.
  contentEl.querySelectorAll('.ann-wrap:not(.ann-edit)').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('ann-delete')) return;
      e.stopPropagation();
      if (state.mode === 'view') return;
      openEditPopup(parseInt(el.dataset.annGroup, 10), el);
    });
  });

  // Suggested-edit controls: accept applies the change, reject reverts it.
  contentEl.querySelectorAll('.ann-accept').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.mode === 'view') return;
      pushUndo();
      state.rawMarkdown = Core.acceptGroup(state.rawMarkdown, parseInt(btn.dataset.annGroup, 10));
      markDirty();
      render();
    });
  });
  contentEl.querySelectorAll('.ann-reject').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.mode === 'view') return;
      deleteAnnotation(parseInt(btn.dataset.annGroup, 10));
    });
  });

  updateToolbar();

  initTableWrap();
  initTableResize();
  initCodeCopy();
  renderMermaid();
}

// Render every .mermaid block freshly produced by the markdown renderer.
// innerHTML is rebuilt on each render(), so each call gets unprocessed nodes.
let mermaidSeq = 0;
async function renderMermaid() {
  if (!window.mermaid) return;  // module still loading; it will re-invoke us
  const blocks = contentEl.querySelectorAll('.mermaid');
  if (!blocks.length) return;
  for (const el of blocks) {
    const source = el.textContent;
    try {
      const { svg } = await window.mermaid.render('mmd-' + (mermaidSeq++), source);
      el.innerHTML = svg;
      el.classList.remove('mermaid-error');
    } catch (e) {
      el.classList.add('mermaid-error');
      el.textContent = 'Mermaid error: ' + (e && e.message ? e.message : e);
    }
  }
}
window.renderMermaid = renderMermaid;

// ── Table overflow wrappers ────────────────────────────────
// A table whose min-content width exceeds the paper (e.g. long unbreakable
// code-span chains in cells) scrolls inside its own container instead of
// bursting out of the page — same idea as .code-wrap around <pre>. The
// wrapper carries no text, so the Range-based selection→source mapping
// never sees it.
function initTableWrap() {
  contentEl.querySelectorAll('table').forEach((table) => {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });
}

// ── Table column resizing ──────────────────────────────────
// Each rendered table gets drag grips on the header-cell borders. Widths are
// view-only: kept in memory as percentages per file+table so they survive the
// full innerHTML rebuild every render() does, but never touch the source and
// don't persist across page loads. Grips carry no text, so the Range-based
// selection→source mapping never sees them.
const tableWidths = new Map();
const COL_MIN_PX = 48;

function tableResizeKey(idx, colCount) {
  // Column count in the key invalidates saved widths if the table's structure
  // changes (e.g. an accepted suggested edit adds a column).
  return state.fileName + '::' + idx + '::' + colCount;
}

function applyColWidths(table, cells, widths) {
  table.style.tableLayout = 'fixed';
  cells.forEach((c, i) => { if (widths[i] != null) c.style.width = widths[i] + '%'; });
}

function initTableResize() {
  contentEl.querySelectorAll('table').forEach((table, idx) => {
    const headRow = table.querySelector('tr');
    if (!headRow) return;
    const cells = [...headRow.children];
    if (cells.length < 2) return;
    const key = tableResizeKey(idx, cells.length);
    const saved = tableWidths.get(key);
    if (saved) applyColWidths(table, cells, saved);
    cells.forEach((cell, i) => {
      if (i === cells.length - 1) return;  // outer edge: nothing to trade width with
      const grip = document.createElement('span');
      grip.className = 'col-grip';
      grip.addEventListener('click', (e) => e.stopPropagation());
      grip.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        tableWidths.delete(key);
        table.style.tableLayout = '';
        cells.forEach((c) => { c.style.width = ''; });
      });
      grip.addEventListener('pointerdown', (e) => startColDrag(e, grip, table, cells, i, key));
      cell.appendChild(grip);
    });
  });
}

function startColDrag(e, grip, table, cells, i, key) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const tableW = table.getBoundingClientRect().width;
  const leftW = cells[i].getBoundingClientRect().width;
  const rightW = cells[i + 1].getBoundingClientRect().width;
  // Freeze every column at its current percentage first, so only the dragged
  // pair moves and the rest of the table stays put.
  const widths = tableWidths.get(key) ||
    cells.map((c) => c.getBoundingClientRect().width / tableW * 100);
  applyColWidths(table, cells, widths);
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('dragging');
  document.body.classList.add('col-resizing');
  const onMove = (ev) => {
    const d = Math.max(-(leftW - COL_MIN_PX), Math.min(rightW - COL_MIN_PX, ev.clientX - startX));
    widths[i] = (leftW + d) / tableW * 100;
    widths[i + 1] = (rightW - d) / tableW * 100;
    cells[i].style.width = widths[i] + '%';
    cells[i + 1].style.width = widths[i + 1] + '%';
  };
  const onUp = () => {
    grip.classList.remove('dragging');
    document.body.classList.remove('col-resizing');
    grip.removeEventListener('pointermove', onMove);
    grip.removeEventListener('pointerup', onUp);
    grip.removeEventListener('pointercancel', onUp);
    tableWidths.set(key, widths);
  };
  grip.addEventListener('pointermove', onMove);
  grip.addEventListener('pointerup', onUp);
  grip.addEventListener('pointercancel', onUp);
}

// ── Code block copy buttons ────────────────────────────────
// Each <pre> gets a hover copy button. Icon-only (no text nodes), so the
// Range-based selection→source mapping never picks it up as context.
const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3.5v5A1.5 1.5 0 0 0 4 10h1.5"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg>';

function initCodeCopy() {
  contentEl.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.mermaid')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.title = 'Copy code';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = COPY_ICON;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code') || pre;
      // Annotations can live inside code blocks; strip their UI chrome so
      // only the actual code text is copied.
      const clone = code.cloneNode(true);
      clone.querySelectorAll('.ann-comment-badge, .ann-delete, .ann-accept, .ann-reject')
        .forEach((n) => n.remove());
      try {
        await navigator.clipboard.writeText(clone.textContent.replace(/\n$/, ''));
      } catch (_) { return; }
      btn.classList.add('copied');
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = COPY_ICON; }, 1500);
    });
    wrap.appendChild(btn);
  });
}

function updateToolbar() {
  tabName.textContent = state.displayPath || state.fileName || 'No file open';
  tabName.title = state.displayPath || state.fileName || '';
  // body classes drive the chrome: file tab visibility, sheet frame, dirty dots.
  document.body.classList.toggle('file-open', state.fileOpen);
  document.body.classList.toggle('dirty', state.dirty);
  const noFile = !state.fileOpen;
  // With auto-save on (local files), saving is automatic — the button only
  // lights up while something is unsaved (covers the first permission-granting
  // save, and the case where auto-save is quietly waiting for permission).
  $('#btn-save').disabled = noFile || (getAutoSave() && !state.remote && !state.dirty);
  // With auto-reload on and nothing unsaved, the watcher already covers manual
  // reloads; the button's only remaining job is "discard my changes".
  $('#btn-refresh').disabled = noFile || (getAutoReload() && !state.dirty);
  $('#btn-autoreload').disabled = noFile;
  $('#btn-autosave').disabled = noFile || !!state.remote;  // local files only
  $('#btn-export').disabled = noFile;
  $('#btn-mode-toggle').disabled = noFile;
}

function markDirty() {
  state.dirty = true;
  updateToolbar();
  scheduleAutoSave();
}

// ── Source mapping ──────────────────────────────────────────
function findInSource(selectedText, beforeCtx, afterCtx) {
  const src = state.rawMarkdown;
  const normalizedSel = selectedText.replace(/\r\n/g, '\n');

  let candidates = [];

  let pos = -1;
  while ((pos = src.indexOf(normalizedSel, pos + 1)) !== -1) {
    candidates.push({ start: pos, end: pos + normalizedSel.length, score: 0 });
  }

  const wrappers = [['**','**'],['*','*'],['__','__'],['_','_'],['`','`'],['~~','~~'],['***','***']];
  for (const [open, close] of wrappers) {
    let p = -1;
    const wrapped = open + normalizedSel + close;
    while ((p = src.indexOf(wrapped, p + 1)) !== -1) {
      candidates.push({ start: p + open.length, end: p + open.length + normalizedSel.length, score: 1 });
    }
  }

  if (candidates.length === 0) {
    // Typography-tolerant pass: markdown-it's typographer renders "x" as “x”,
    // -- as –, ... as … — the selection carries the pretty chars while the
    // source has the plain ones. Normalize BOTH sides the same way (with an
    // index map back into the raw source) and search again.
    const selNorm = normalizeTypography(normalizedSel).norm.trim();
    const { norm, map } = normalizeTypography(src);
    if (selNorm) {
      let cp = -1;
      while ((cp = norm.indexOf(selNorm, cp + 1)) !== -1) {
        const endOut = cp + selNorm.length;
        const end = endOut < map.length ? map[endOut] : src.length;
        candidates.push({ start: map[cp], end, score: -1 });
      }
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const normalizedBefore = stripMarkdownInline(beforeCtx).slice(-40);
  const normalizedAfter = stripMarkdownInline(afterCtx).slice(0, 40);

  for (const c of candidates) {
    const srcBefore = stripMarkdownInline(src.slice(Math.max(0, c.start - 80), c.start)).slice(-40);
    const srcAfter = stripMarkdownInline(src.slice(c.end, c.end + 80)).slice(0, 40);
    c.score += lcsLength(normalizedBefore, srcBefore) + lcsLength(normalizedAfter, srcAfter);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

// Canonicalize typographic characters and collapse whitespace, keeping a map
// from each output char to its input offset. Runs of '-' and '.' collapse to
// one char so that source `---`/`...` lines up with rendered `—`/`…`.
function normalizeTypography(str) {
  const out = [];
  const map = [];
  let inSpace = false;
  let last = '';
  for (let i = 0; i < str.length; i++) {
    let c = str[i];
    if (c === '‘' || c === '’' || c === 'ʼ') c = "'";
    else if (c === '“' || c === '”') c = '"';
    else if (c === '–' || c === '—') c = '-';
    else if (c === '…') c = '.';
    else if (c === ' ') c = ' ';
    if (/\s/.test(c)) {
      if (!inSpace) { out.push(' '); map.push(i); }
      inSpace = true;
      last = ' ';
      continue;
    }
    inSpace = false;
    if ((c === '-' || c === '.') && last === c) continue;  // collapse runs
    out.push(c);
    map.push(i);
    last = c;
  }
  return { norm: out.join(''), map };
}

function stripMarkdownInline(s) {
  return s
    .replace(/\*\*\*(.*?)\*\*\*/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');
}

function lcsLength(a, b) {
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const prev = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prevDiag = 0;
    for (let j = 1; j <= n; j++) {
      const temp = prev[j];
      if (a[i-1] === b[j-1]) prev[j] = prevDiag + 1;
      else prev[j] = Math.max(prev[j], prev[j-1]);
      prevDiag = temp;
    }
  }
  return prev[n];
}

// ── Undo (Ctrl+Z) — snapshots of the source before each mutation ──
const undoStack = [];
const UNDO_MAX = 50;
function pushUndo() {
  undoStack.push(state.rawMarkdown);
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}
function clearUndo() { undoStack.length = 0; }
function undo() {
  if (!state.fileOpen || !undoStack.length) return;
  state.rawMarkdown = undoStack.pop();
  markDirty();
  render();
}

// ── Annotation CRUD (by group — a multi-block annotation is one group) ──────
function deleteAnnotation(group) {
  pushUndo();
  state.rawMarkdown = Core.deleteGroup(state.rawMarkdown, group);
  markDirty();
  render();
}

function updateAnnotation(group, newComment) {
  pushUndo();
  state.rawMarkdown = Core.updateGroup(state.rawMarkdown, group, newComment);
  markDirty();
  render();
}

// ── Selection handling ─────────────────────────────────────
function getSelectionContext() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

  const text = sel.toString().trim();
  if (!text) return null;

  const range = sel.getRangeAt(0);
  if (!contentEl.contains(range.commonAncestorContainer)) return null;

  const preRange = document.createRange();
  preRange.setStartBefore(contentEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const beforeCtx = preRange.toString().slice(-80);

  const postRange = document.createRange();
  postRange.setStart(range.endContainer, range.endOffset);
  postRange.setEndAfter(contentEl);
  const afterCtx = postRange.toString().slice(0, 80);

  return { text, beforeCtx, afterCtx, rect: range.getBoundingClientRect() };
}

// True only if the click landed on an actual text glyph (not padding, blank
// space below the content, or the empty area past the end of a short line).
function clickedOnText(e) {
  let node = null, offset = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(e.clientX, e.clientY);
    if (p) { node = p.offsetNode; offset = p.offset; }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  if (!contentEl.contains(node)) return false;
  const text = node.textContent;
  const range = document.createRange();
  if (offset < text.length) { range.setStart(node, offset); range.setEnd(node, offset + 1); }
  else if (offset > 0) { range.setStart(node, offset - 1); range.setEnd(node, offset); }
  else return false;
  for (const rc of range.getClientRects()) {
    // Generous vertical tolerance: with line-height > 1 there's blank leading
    // above/below the glyph that still counts as "on the line". Horizontal stays
    // tight so clicks past the end of a short line are still rejected.
    const vpad = Math.max(6, rc.height * 0.6);
    if (e.clientX >= rc.left - 3 && e.clientX <= rc.right + 3 &&
        e.clientY >= rc.top - vpad && e.clientY <= rc.bottom + vpad) return true;
  }
  return false;
}

// Context for a single click (collapsed caret) — used for point comments.
function getCaretContext(e) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  if (!contentEl.contains(range.commonAncestorContainer)) return null;

  const preRange = document.createRange();
  preRange.setStartBefore(contentEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const beforeCtx = preRange.toString().slice(-80);

  const postRange = document.createRange();
  postRange.setStart(range.endContainer, range.endOffset);
  postRange.setEndAfter(contentEl);
  const afterCtx = postRange.toString().slice(0, 80);

  let rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    rect = { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY };
  }
  return { beforeCtx, afterCtx, rect };
}

// Map a caret (no selection) to a source offset by anchoring on the words
// just before the caret (falling back to the words just after it). Tries
// progressively shorter anchors so inline markdown is less likely to defeat
// the match. Returns the offset to insert the comment at, or null.
function findCaretPosInSource(beforeCtx, afterCtx) {
  const beforeWords = beforeCtx.replace(/\s+$/, '').split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, beforeWords.length); n >= 1; n--) {
    const anchor = beforeWords.slice(-n).join(' ');
    const m = findInSource(anchor, beforeWords.slice(0, -n).join(' '), afterCtx);
    if (m) return m.end;
  }
  const afterWords = afterCtx.replace(/^\s+/, '').split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, afterWords.length); n >= 1; n--) {
    const anchor = afterWords.slice(0, n).join(' ');
    const m = findInSource(anchor, beforeCtx, afterWords.slice(n).join(' '));
    if (m) return m.start;
  }
  return null;
}

function positionPopup(el, rect) {
  let top = rect.bottom + 8;
  let left = rect.left;
  const popupWidth = 340;
  if (left + popupWidth > window.innerWidth - 16) left = window.innerWidth - popupWidth - 16;
  if (left < 16) left = 16;
  if (top + 200 > window.innerHeight) top = rect.top - 200;
  el.style.top = top + 'px';
  el.style.left = left + 'px';
}

// Map a DOM selection to a source [start,end] range. Try a contiguous match of
// the whole selected text first (best for simple in-line selections); otherwise
// map the start and end boundaries independently (handles selections that cross
// inline formatting or block boundaries — analyzeTarget then splits as needed).
function mapSelectionRange(selCtx) {
  const { text, beforeCtx, afterCtx } = selCtx;
  if (!text.includes('\t')) {
    const single = findInSource(text, beforeCtx, afterCtx);
    if (single) return { start: single.start, end: single.end };
  }
  const flat = text.replace(/\t/g, ' ');
  const start = findCaretPosInSource(beforeCtx, flat);
  const end = findCaretPosInSource((beforeCtx + ' ' + flat).slice(-200), afterCtx);
  if (start != null && end != null && end > start) return { start, end };
  return null;
}

function previewFor(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

// Show the comment box for an already-validated target. `pending.inserts` is the
// exact insertion analyzeTarget chose; commit just applies it.
const insCaret = $('#ins-caret');
function showInsCaret(rect) {
  insCaret.style.left = rect.left + 'px';
  insCaret.style.top = rect.top + 'px';
  insCaret.style.height = Math.max(14, (rect.bottom - rect.top) || 16) + 'px';
  insCaret.classList.add('visible');
}
function hideInsCaret() { insCaret.classList.remove('visible'); }

function showCommentPopup(pending) {
  state.pending = pending;
  // Don't echo the selected text back as a title; only show the small generic
  // hint for point/block comments.
  selectedPreview.textContent = pending.preview || '';
  selectedPreview.style.display = pending.preview ? '' : 'none';
  annInput.value = '';
  positionPopup(popup, pending.rect);
  popup.classList.add('visible');
  if (pending.caretRect) showInsCaret(pending.caretRect); else hideInsCaret();
  annInput.focus();
}

function hideAnnotationPopup() {
  popup.classList.remove('visible');
  hideInsCaret();
  state.pending = null;
}

function commitAnnotation() {
  const text = annInput.value.trim();
  if (!text || !state.pending) return;
  pushUndo();
  state.rawMarkdown = Core.applyInserts(state.rawMarkdown, state.pending.inserts, text);
  markDirty();
  render();
  hideAnnotationPopup();
}

// Toasts: transient notices (red by default, 'ok' green, 'info' blue) and a
// sticky progress variant with a spinner for slow operations (GitLab calls).
let noticeTimer = null;
function setToast(msg, kind, ms) {
  const el = $('#notice');
  el.textContent = msg;
  el.classList.remove('notice-ok', 'notice-info', 'loading');
  if (kind === 'ok') el.classList.add('notice-ok');
  else if (kind === 'info') el.classList.add('notice-info');
  el.classList.add('show');
  clearTimeout(noticeTimer);
  if (ms) noticeTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function showNotice(msg, kind) { setToast(msg, kind, 2600); }
function showProgress(msg) {
  setToast(msg, 'info');           // sticky — cleared by hideProgress or the next toast
  $('#notice').classList.add('loading');
}
function hideProgress() {
  const el = $('#notice');
  if (el.classList.contains('loading')) el.classList.remove('show', 'loading');
}

// ── Edit annotation popup ──────────────────────────────────
function openEditPopup(group, badgeEl) {
  state.editingIdx = group;
  editInput.value = Core.getGroupComment(state.rawMarkdown, group);

  const rect = badgeEl.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left;
  if (left + 340 > window.innerWidth - 16) left = window.innerWidth - 340 - 16;
  if (left < 16) left = 16;
  if (top + 180 > window.innerHeight) top = rect.top - 180;

  editPopup.style.top = top + 'px';
  editPopup.style.left = left + 'px';
  editPopup.classList.add('visible');
  editInput.focus();
  editInput.select();
}

function hideEditPopup() {
  editPopup.classList.remove('visible');
  state.editingIdx = null;
}

function commitEdit() {
  const newComment = editInput.value.trim();
  if (!newComment || state.editingIdx === null) return;
  updateAnnotation(state.editingIdx, newComment);
  hideEditPopup();
}

// ── Event listeners ────────────────────────────────────────
$('#btn-open').addEventListener('click', pickFile);
$('#btn-open-folder').addEventListener('click', pickFolder);
$('#btn-recent').addEventListener('click', (e) => {
  e.stopPropagation();
  if (recentMenu.classList.contains('visible')) hideRecentMenu();
  else showRecentMenu();
});
document.addEventListener('mousedown', (e) => {
  if (!recentMenu.contains(e.target) && !e.target.closest('#btn-recent')) hideRecentMenu();
});
window.addEventListener('scroll', hideRecentMenu, true);
$('#btn-save').addEventListener('click', saveFile);
$('#btn-refresh').addEventListener('click', async () => {
  if (!state.fileOpen) return;
  if (state.dirty && !confirm('You have unsaved changes. Reload anyway?')) return;
  await reloadFromDisk();
});

// ── Export (PDF via print, EPUB via JSZip) ──────────────────
// Exports are CLEAN: comments removed, suggested edits reverted to the
// original text (Core.stripAll).
const EXPORT_CSS = `
  body { font-family: Charter, "Sitka Text", Cambria, Georgia, serif; font-size: 12pt;
         line-height: 1.6; color: #222; max-width: 46em; margin: 2em auto; padding: 0 1em; }
  h1 { font-size: 1.8em; line-height: 1.25; }
  h2 { font-size: 1.4em; border-bottom: 1px solid #ccc; padding-bottom: 0.2em; }
  h3 { font-size: 1.15em; }
  pre { background: #f5f4f0; border: 1px solid #ddd; border-radius: 4px; padding: 10px 12px;
        font-size: 0.85em; overflow-x: auto; white-space: pre-wrap; }
  code { font-family: Consolas, monospace; font-size: 0.9em; }
  blockquote { border-left: 3px solid #888; margin-left: 0; padding-left: 1em; color: #444; }
  /* Print/EPUB can't scroll: cells must be allowed to break long unbreakable
     runs (code-span chains) or a wide table clips at the page edge. */
  table { border-collapse: collapse; max-width: 100%; }
  th, td { border: 1px solid #bbb; padding: 5px 9px; text-align: left; overflow-wrap: anywhere; }
  img, svg { max-width: 100%; height: auto; }
  a { color: #35507B; }
`;

// Render the clean document to HTML with mermaid diagrams as inline SVG.
async function buildCleanHtml() {
  const clean = Core.stripAll(state.rawMarkdown);
  const container = document.createElement('div');
  container.innerHTML = md.render(clean);
  for (const el of container.querySelectorAll('.mermaid')) {
    try {
      const { svg } = await window.mermaid.render('exp-' + (mermaidSeq++), el.textContent);
      el.innerHTML = svg;
    } catch (_) { /* leave the code text visible */ }
  }
  return container;
}

function exportBaseName() {
  return (state.fileName || 'document').replace(/\.(md|markdown|mdx|txt)$/i, '');
}

async function exportPdf() {
  const container = await buildCleanHtml();
  const win = window.open('', '_blank');
  if (!win) { alert('Popup was blocked — allow popups to export PDF.'); return; }
  win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
    Core.escapeHtml(exportBaseName()) + '</title><style>' + EXPORT_CSS + '</style></head><body>' +
    container.innerHTML + '</body></html>');
  win.document.close();
  // Give the new window a beat to lay out before the print dialog.
  setTimeout(() => { win.focus(); win.print(); }, 400);
}

let jszipPromise = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve();
  if (!jszipPromise) {
    jszipPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      s.integrity = 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG';
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => { jszipPromise = null; reject(new Error('Failed to load JSZip')); };
      document.head.appendChild(s);
    });
  }
  return jszipPromise;
}

// Serialize rendered HTML as XHTML (EPUB is XML — void tags must self-close).
function toXhtml(container) {
  const doc = document.implementation.createHTMLDocument('');
  const div = doc.createElement('div');
  div.innerHTML = container.innerHTML;
  const xml = new XMLSerializer().serializeToString(div);
  return xml.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');
}

async function exportEpub() {
  try {
    await loadJSZip();
    const container = await buildCleanHtml();
    const title = exportBaseName();
    const bodyXhtml = toXhtml(container);
    const uuid = 'urn:uuid:' + crypto.randomUUID();

    const chapter = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
      '<head><title>' + Core.escapeHtml(title) + '</title>' +
      '<link rel="stylesheet" type="text/css" href="styles.css"/></head>' +
      '<body>' + bodyXhtml + '</body></html>';

    const nav = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
      '<head><title>Contents</title></head><body>' +
      '<nav epub:type="toc"><h1>Contents</h1><ol><li><a href="chapter.xhtml">' +
      Core.escapeHtml(title) + '</a></li></ol></nav></body></html>';

    const opf = '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<dc:identifier id="uid">' + uuid + '</dc:identifier>' +
      '<dc:title>' + Core.escapeHtml(title) + '</dc:title>' +
      '<dc:language>en</dc:language>' +
      '<meta property="dcterms:modified">' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</meta>' +
      '</metadata><manifest>' +
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
      '<item id="ch" href="chapter.xhtml" media-type="application/xhtml+xml" properties="svg"/>' +
      '<item id="css" href="styles.css" media-type="text/css"/>' +
      '</manifest><spine><itemref idref="ch"/></spine></package>';

    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
      '</rootfiles></container>');
    zip.file('OEBPS/content.opf', opf);
    zip.file('OEBPS/nav.xhtml', nav);
    zip.file('OEBPS/chapter.xhtml', chapter);
    zip.file('OEBPS/styles.css', EXPORT_CSS);

    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = title + '.epub';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) {
    alert('EPUB export failed: ' + e.message);
  }
}

const exportMenu = $('#export-menu');
$('#btn-export').addEventListener('click', (e) => {
  e.stopPropagation();
  if (exportMenu.classList.contains('visible')) { exportMenu.classList.remove('visible'); return; }
  // Export button lives in the left rail — the menu flies out to its right.
  const rect = $('#btn-export').getBoundingClientRect();
  exportMenu.style.left = (rect.right + 8) + 'px';
  exportMenu.style.top = Math.min(rect.top, window.innerHeight - 110) + 'px';
  exportMenu.classList.add('visible');
});
exportMenu.addEventListener('click', (e) => {
  const fmt = e.target.dataset.fmt;
  exportMenu.classList.remove('visible');
  if (fmt === 'pdf') exportPdf();
  else if (fmt === 'epub') exportEpub();
});
document.addEventListener('mousedown', (e) => {
  if (!exportMenu.contains(e.target) && !e.target.closest('#btn-export')) {
    exportMenu.classList.remove('visible');
  }
});

// ── Theme (light / dark) ───────────────────────────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#hljs-light').disabled = theme === 'dark';
  $('#hljs-dark').disabled = theme !== 'dark';
  $('#theme-icon').setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
  $('#theme-label').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  $('#btn-theme').title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  try { localStorage.setItem('theme', theme); } catch (_) {}
  if (window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default' });
    if (state.fileOpen) render();  // re-render diagrams in the new theme
  }
}
function initTheme() {
  let theme = null;
  try { theme = localStorage.getItem('theme'); } catch (_) {}
  if (theme !== 'dark' && theme !== 'light') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(theme);
}
$('#btn-theme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ── Rail collapse (manual toggle; narrow screens force it) ─
const railMq = window.matchMedia('(max-width: 768px)');
function getRailPref() {
  try { return localStorage.getItem('rail-collapsed') === '1'; } catch (_) { return false; }
}
function applyRailCollapsed() {
  const collapsed = railMq.matches || getRailPref();
  document.body.classList.toggle('rail-collapsed', collapsed);
  $('#rail-toggle-icon').setAttribute('href', collapsed ? '#i-chev-r' : '#i-chev-l');
  $('#rail-toggle-label').textContent = collapsed ? 'Expand' : 'Collapse';
  $('#btn-rail-toggle').title = collapsed ? 'Expand the panel' : 'Collapse the panel';
}
railMq.addEventListener('change', applyRailCollapsed);
$('#btn-rail-toggle').addEventListener('click', () => {
  try { localStorage.setItem('rail-collapsed', getRailPref() ? '0' : '1'); } catch (_) {}
  applyRailCollapsed();
});
applyRailCollapsed();

// ── Annotate / View mode ───────────────────────────────────
function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('view-mode', mode === 'view');
  $('#btn-mode-toggle').classList.toggle('on', mode === 'view');
  if (mode === 'view') {
    hideAnnotationPopup();
    hideEditPopup();
  }
}
function toggleMode() { setMode(state.mode === 'annotate' ? 'view' : 'annotate'); }
$('#btn-mode-toggle').addEventListener('click', toggleMode);

// Selection → validate → annotation popup (or "unsupported" notice).
renderedView.addEventListener('mouseup', (e) => {
  if (state.mode === 'view') return;
  if (popup.contains(e.target) || editPopup.contains(e.target)) return;
  if (e.target.closest('.ann-comment-badge') || e.target.closest('.ann-delete')) return;

  setTimeout(() => {
    if (!state.fileOpen) return;
    const selCtx = getSelectionContext();
    if (!selCtx) return;
    const range = mapSelectionRange(selCtx);
    if (!range) { showNotice('Couldn’t locate that selection in the source — try a more unique passage.'); return; }
    const r = Core.analyzeTarget(state.rawMarkdown, { type: 'range', start: range.start, end: range.end }, md);
    if (!r.supported) { showNotice(r.reason || 'Can’t annotate this selection without breaking the formatting.'); return; }
    showCommentPopup({ inserts: r.inserts, rect: selCtx.rect, preview: '' });
  }, 10);
});

// Single click (no selection) → validate → point/block comment (or notice).
let pointClickTimer = null;
renderedView.addEventListener('click', (e) => {
  if (!state.fileOpen) return;
  if (state.mode === 'view') return;
  if (popup.contains(e.target) || editPopup.contains(e.target)) return;
  if (e.target.closest('.ann-comment-badge') || e.target.closest('.ann-delete')) return;

  // Clicking a rendered diagram → comment on the whole diagram (block comment
  // before its fence in source); annotating inside the SVG isn't possible.
  const mermaidEl = e.target.closest('.mermaid');
  if (mermaidEl) {
    const all = [...contentEl.querySelectorAll('.mermaid')];
    const di = all.indexOf(mermaidEl);
    const mfences = Core.codeFenceRanges(state.rawMarkdown).filter(([s]) => {
      const nl = state.rawMarkdown.indexOf('\n', s);
      return /^(`{3,}|~{3,})\s*mermaid\b/i.test(state.rawMarkdown.slice(s, nl === -1 ? undefined : nl));
    });
    const f = mfences[di];
    if (f) {
      const r = Core.analyzeTarget(state.rawMarkdown, { type: 'point', pos: f[0] }, md);
      if (r.supported) { showCommentPopup({ inserts: r.inserts, rect: mermaidEl.getBoundingClientRect(), preview: 'Comment on this diagram' }); return; }
    }
    showNotice('Can’t annotate inside a diagram.');
    return;
  }

  if (e.detail > 1) return;                  // part of a double/triple click
  if (!clickedOnText(e)) return;             // clicked empty space → no dialog
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed) return;

  // Wait past the double-click window: if a word-selection appears (double-click)
  // the selection handler owns it; only a lone caret click drops a point comment.
  clearTimeout(pointClickTimer);
  pointClickTimer = setTimeout(() => {
    const sel2 = window.getSelection();
    if (!sel2 || !sel2.isCollapsed) return;
    const ctx = getCaretContext(e);
    if (!ctx) return;
    const pos = findCaretPosInSource(ctx.beforeCtx, ctx.afterCtx);
    if (pos == null) { showNotice('Couldn’t locate the cursor in the source — try clicking next to some text.'); return; }
    const r = Core.analyzeTarget(state.rawMarkdown, { type: 'point', pos }, md);
    if (!r.supported) { showNotice(r.reason || 'Can’t annotate here.'); return; }
    const preview = r.kind === 'point' ? 'Point comment at cursor'
      : r.kind === 'block' ? 'Comment on this block'
      : r.kind === 'line' ? 'Comment on this line'
      : 'Comment';
    showCommentPopup({ inserts: r.inserts, rect: ctx.rect, preview, caretRect: ctx.rect });
  }, 220);
});

// ── Diagram export (right-click a rendered mermaid diagram) ────────────────
const diagramMenu = $('#diagram-menu');
let menuSvg = null;

// Rasterize a (self-contained, inline-styled) mermaid SVG to a PNG blob.
async function svgToPngBlob(svg, scale = 2, bg = '#ffffff') {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const r = svg.getBoundingClientRect();
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const w = (vb && vb.width) || r.width || 800;
  const h = (vb && vb.height) || r.height || 600;
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  const data = new XMLSerializer().serializeToString(clone);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('SVG render failed')); img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  const ctx = canvas.getContext('2d');
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.drawImage(img, 0, 0, w, h);
  return await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'));
}

async function copyDiagramPng(svg) {
  try {
    const blob = await svgToPngBlob(svg);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    showNotice('Diagram copied as image');
  } catch (e) { showNotice('Copy failed: ' + (e.message || e)); }
}

async function copyDiagramSvg(svg) {
  try {
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    await navigator.clipboard.writeText(new XMLSerializer().serializeToString(clone));
    showNotice('Diagram SVG copied');
  } catch (e) { showNotice('Copy failed: ' + (e.message || e)); }
}

async function downloadDiagramPng(svg) {
  try {
    const blob = await svgToPngBlob(svg);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.fileName ? state.fileName.replace(/\.[^.]+$/, '') : 'diagram') + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showNotice('Diagram downloaded');
  } catch (e) { showNotice('Download failed: ' + (e.message || e)); }
}

function hideDiagramMenu() { diagramMenu.classList.remove('visible'); menuSvg = null; }

renderedView.addEventListener('contextmenu', (e) => {
  const m = e.target.closest('.mermaid');
  const svg = m && m.querySelector('svg');
  if (!svg) return;            // not a diagram → keep the native menu
  e.preventDefault();
  menuSvg = svg;
  const mw = 170, mh = 120;
  diagramMenu.style.left = Math.min(e.clientX, window.innerWidth - mw - 8) + 'px';
  diagramMenu.style.top = Math.min(e.clientY, window.innerHeight - mh - 8) + 'px';
  diagramMenu.classList.add('visible');
});

diagramMenu.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  const svg = menuSvg;
  hideDiagramMenu();
  if (!act || !svg) return;
  if (act === 'png') copyDiagramPng(svg);
  else if (act === 'svg') copyDiagramSvg(svg);
  else if (act === 'download') downloadDiagramPng(svg);
});

document.addEventListener('mousedown', (e) => { if (!diagramMenu.contains(e.target)) hideDiagramMenu(); });
window.addEventListener('scroll', hideDiagramMenu, true);

$('#btn-ann-save').addEventListener('click', commitAnnotation);
$('#btn-ann-cancel').addEventListener('click', hideAnnotationPopup);
$('#btn-edit-save').addEventListener('click', commitEdit);
$('#btn-edit-cancel').addEventListener('click', hideEditPopup);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (commitDialog.classList.contains('visible')) { hideCommitDialog(); return; }
    if (glDialog.classList.contains('visible')) { hideGitLabDialog(); return; }
    if (recentMenu.classList.contains('visible')) { hideRecentMenu(); return; }
    if (diagramMenu.classList.contains('visible')) { hideDiagramMenu(); return; }
    if (editPopup.classList.contains('visible')) { hideEditPopup(); return; }
    if (popup.classList.contains('visible')) { hideAnnotationPopup(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
    e.preventDefault();
    pickFile();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
    e.preventDefault();
    toggleMode();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    undo();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveFile();
  }
});

annInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitAnnotation(); }
});

editInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitEdit(); }
});

document.addEventListener('mousedown', (e) => {
  if (popup.classList.contains('visible') && !popup.contains(e.target)) {
    setTimeout(() => {
      if (!popup.contains(document.activeElement)) hideAnnotationPopup();
    }, 200);
  }
  if (editPopup.classList.contains('visible') && !editPopup.contains(e.target) && !e.target.closest('.ann-comment-badge')) {
    hideEditPopup();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ── Drag & drop a file anywhere on the page ────────────────
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if ([...e.dataTransfer.items].some(i => i.kind === 'file')) {
    dragDepth++;
    document.body.classList.add('dragging');
  }
});
window.addEventListener('dragleave', () => {
  if (dragDepth > 0 && --dragDepth === 0) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const item = [...e.dataTransfer.items].find(i => i.kind === 'file');
  if (!item || !item.getAsFileSystemHandle) return;
  // Grab the handle promise synchronously — DataTransfer items die with the event.
  const handlePromise = item.getAsFileSystemHandle();
  handlePromise.then((h) => {
    if (!h || h.kind !== 'file') return;
    if (!/\.(md|markdown|mdx|txt)$/i.test(h.name)) {
      showNotice('Drop a markdown file (.md, .markdown, .mdx, .txt)');
      return;
    }
    openHandle(h);
  });
});

// ── Init ───────────────────────────────────────────────────
$('#btn-disk-reload').addEventListener('click', () => { state.dirty = false; reloadFromDisk(); });
$('#btn-disk-dismiss').addEventListener('click', hideDiskBanner);
$('#btn-folder-close').addEventListener('click', () => {
  fileSidebar.classList.remove('visible');
  folder = null;
});
if (!FS_SUPPORTED) {
  $('#browser-warning').style.display = 'block';
  $('#btn-open').disabled = true;
  $('#btn-open-folder').disabled = true;
  $('#btn-recent').disabled = true;
}
// Installed-PWA file handling: opening a .md "with" the app lands here.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer((params) => {
    if (params.files && params.files.length) openHandle(params.files[0]);
  });
}

initTheme();
updateToolbar();
refreshWelcomeRecent();
tryRestoreLast();
