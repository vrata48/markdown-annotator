// ── State ──────────────────────────────────────────────────
const state = {
  rawMarkdown: '',
  fileName: '',
  dirty: false,
  pending: null,
  editingIdx: null,
  fileOpen: false,
  fileHandle: null,   // local file (File System Access API), or
  sample: false,      // in-memory onboarding document; first save asks for a file
  diskMoved: false,   // the on-disk version changed under us (survives banner dismissal)
  mode: 'annotate',   // 'annotate' | 'view' | 'raw'
};

const FS_SUPPORTED = typeof window.showOpenFilePicker === 'function';

// ── DOM refs ───────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const contentEl = $('#content');
const rawSourceEl = $('#raw-source');
const renderedView = $('#rendered-view');
const popup = $('#annotation-popup');
const annInput = $('#annotation-input');
const selectedPreview = $('#selected-preview');
const tabName = $('#tab-name');
const editPopup = $('#edit-popup');
const editInput = $('#edit-input');
const saveStatus = $('#save-status');
const Helpers = window.AnnotatorAppHelpers;

// Accessible app-owned modal dialogs replace native alert/confirm boxes and
// provide consistent focus trapping/restoration for every modal surface.
let activeModal = null;
let modalPreviousFocus = null;
let messageResolve = null;

function showModal(dialog, initialFocus) {
  modalPreviousFocus = document.activeElement;
  activeModal = dialog;
  $('#dialog-backdrop').classList.add('visible');
  dialog.classList.add('visible');
  requestAnimationFrame(() => (initialFocus || dialog.querySelector('button, input, textarea')).focus());
}

function hideModal(dialog) {
  if (!dialog || !dialog.classList.contains('visible')) return;
  dialog.classList.remove('visible');
  if (activeModal === dialog) {
    activeModal = null;
    $('#dialog-backdrop').classList.remove('visible');
    if (modalPreviousFocus && modalPreviousFocus.isConnected) modalPreviousFocus.focus();
    modalPreviousFocus = null;
  }
}

function showMessage(message, options) {
  const opts = options || {};
  $('#message-title').textContent = opts.title || 'Markdown Annotator';
  $('#message-text').textContent = message;
  $('#message-cancel').style.display = opts.confirm ? '' : 'none';
  $('#message-ok').textContent = opts.okText || 'OK';
  showModal($('#message-dialog'), opts.confirm ? $('#message-cancel') : $('#message-ok'));
  return new Promise(resolve => { messageResolve = resolve; });
}

function showAppAlert(message, title) { return showMessage(message, { title }); }
function askConfirmation(message, okText) { return showMessage(message, { confirm: true, okText: okText || 'Continue' }); }

function finishMessage(result) {
  hideModal($('#message-dialog'));
  const resolve = messageResolve;
  messageResolve = null;
  if (resolve) resolve(result);
}

$('#message-ok').addEventListener('click', () => finishMessage(true));
$('#message-cancel').addEventListener('click', () => finishMessage(false));

// ── Markdown-it setup ──────────────────────────────────────
const md = markdownit({
  // Markdown comes from arbitrary local files. Keep raw HTML inert: rendered
  // content is inserted with innerHTML, and allowing tags here would let a
  // document execute event-handler JavaScript in the app's origin.
  html: false,
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

const SAMPLE_MARKDOWN = `# Product review sample

This document is safe to experiment with. Select any prose to add a comment, or click beside text for a point note.

## Existing feedback

The launch plan is {==clear and ambitious==}{>> Is the success metric defined anywhere? <<}, but the final milestone is still open.

An external reviewer can propose a change like {~~ship immediately~>run a small public beta first~~}. Use the visible accept or reject buttons to resolve it.

> A block quote can contain **formatting**, a [link](https://example.com), and comments across multiple lines.

| Area | Status | Owner |
| --- | --- | --- |
| Accessibility | In review | Casey |
| Documentation | Ready | Morgan |

\`\`\`js
// CriticMarkup inside code stays literal and is never treated as feedback.
const example = "{>> literal code <<}";
\`\`\`

\`\`\`mermaid
flowchart LR
  Draft --> Review --> Publish
\`\`\`
`;

// Any path that replaces the source from outside (open, reload, an external
// change picked up by the watcher) must drop in-flight annotation state:
// state.pending holds source OFFSETS and state.editingIdx a group id, both
// computed against the old text. Committing them afterwards splices at the
// wrong position and corrupts the document.
function discardPendingEdits() {
  hideAnnotationPopup();
  hideEditPopup();
}

// A live shared session (collab.js) owns the open document: opening or
// closing something else means leaving it first, and the user must agree.
async function leaveSharedSession(question) {
  if (!Collab.active) return true;
  if (!await askConfirmation(question, 'Leave')) return false;
  Collab.leave();
  return true;
}

async function openHandle(handle, opts) {
  const silent = opts && opts.silent;
  if (state.dirty && !await askConfirmation('You have unsaved changes. Open another file anyway?', 'Open file')) return;
  if (!await leaveSharedSession('You are in a shared session. Leave it and open this file?')) return;
  cancelAutoSave();  // the user just chose to discard — a pending timer must not save
  discardPendingEdits();
  try {
    // Read-only here: asking for readwrite at open time makes Chrome show a
    // confusing "Save changes to file?" prompt. Write access is requested on
    // the first actual save, where the prompt matches the user's intent —
    // except when auto-save is on: its timer has no user gesture for the
    // prompt, so the open gesture must secure write access up front.
    if (getAutoSave() && !silent &&
        await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      // Denied write still falls through to a plain read-only open below.
      try { await handle.requestPermission({ mode: 'readwrite' }); } catch (_) {}
    }
    if (await handle.queryPermission({ mode: 'read' }) !== 'granted' &&
        await handle.requestPermission({ mode: 'read' }) !== 'granted') {
      if (!silent) showNotice('File access was not granted.');
      return;
    }
    const file = await handle.getFile();
    state.rawMarkdown = await file.text();
    state.fileHandle = handle;
    state.sample = false;
    state.fileName = file.name;
    state.displayPath = file.name;  // real paths are hidden from web pages
    state.dirty = false;
    state.diskMoved = false;
    state.fileOpen = true;
    state.lastModified = file.lastModified;
    autoSaveBlockedNotified = false;
    autoSaveBlocked = false;
    clearUndo();
    render({ fresh: true });
    recordRecent({ handle, name: handle.name });
    startWatch();
    // Refresh restores this tab's file silently; a fresh tab (no tab id in
    // sessionStorage) starts on the welcome screen.
    recordSession({ handle, name: handle.name });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (!silent) showAppAlert('Failed to open file: ' + e.message, 'Could not open file');
  }
}

// After a page refresh, reopen THIS TAB's file if permission survived (it
// usually drops back to 'prompt' on reload, and requestPermission needs a
// user gesture). When it didn't survive, the recents list covers reopening.
async function tryRestoreLast() {
  if (!FS_SUPPORTED || state.fileOpen) return;
  let last = await fetchSession();
  if (!last) {
    // Pre-session-store tabs only carried a 'had-file' flag — fall back to
    // the newest recent once; the reopen records a proper session entry.
    let legacy = false;
    try { legacy = sessionStorage.getItem('had-file') === '1'; } catch (_) {}
    if (!legacy) return;
    last = (await fetchRecent())[0];
    if (!last) return;
  }
  if (!last.handle) return;
  // A share link in the URL wins: the shared document is what this tab shows,
  // and the restored handle only becomes its save target (host refresh).
  if (Collab.active || Collab.joining) { Collab.attachHandle(last.handle); return; }
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
    if (e && e.name !== 'AbortError') showAppAlert('Failed to open file: ' + e.message, 'Could not open file');
  }
}

async function reloadFromDisk() {
  cancelAutoSave();  // a pending save must not race the reload it would undo
  try {
    if (!state.fileHandle) return;
    const file = await state.fileHandle.getFile();
    discardPendingEdits();
    state.rawMarkdown = await file.text();
    state.dirty = false;
    state.diskMoved = false;
    state.lastModified = file.lastModified;
    clearUndo();
    hideDiskBanner();
    render();
    showNotice('Reloaded from disk', 'ok');
  } catch (e) {
    showAppAlert('Failed to reload file: ' + e.message, 'Could not reload file');
  }
}

// ── File watching: catch external edits (e.g. an LLM rewriting the file) ──
// Polls lastModified every 3s.
let watchTimer = null;
function startWatch() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(checkDiskChange, 3000);
}

async function checkDiskChange() {
  if (!state.fileOpen || document.hidden || Collab.active) return;  // sharing: the session is the truth, disk is an export
  if (!state.fileHandle) return;
  try {
    const file = await state.fileHandle.getFile();
    if (file.lastModified <= state.lastModified) return;
    if (!state.dirty && getAutoReload()) {
      // Opted in and no local changes — pick up the new content silently.
      discardPendingEdits();
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
  // Record the conflict in state, not just the DOM: dismissing the banner must
  // not re-arm auto-save — only an explicit save or reload resolves it.
  state.diskMoved = true;
  $('#disk-banner-msg').textContent = conflict
    ? 'This file changed on disk and you have unsaved changes. Saving will overwrite that version.'
    : 'This file changed on disk.';
  $('#btn-disk-reload').textContent = conflict ? 'Reload (discard mine)' : 'Reload';
  $('#disk-banner').style.display = 'flex';
  updateToolbar();  // diskMoved re-lights the save button under auto-save
}
function hideDiskBanner() { $('#disk-banner').style.display = 'none'; }

// ── Settings ────────────────────────────────────────────────
// One localStorage boolean protocol for every toggle (storage can be unavailable).
function getFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch (_) { return false; }
}
function setFlag(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch (_) {}
}

function getAutoReload() { return getFlag('auto-reload'); }
function refreshAutoReloadButton() {
  const on = getAutoReload();
  const btn = $('#btn-autoreload');
  btn.title = 'Auto-reload external changes: ' + (on ? 'on' : 'off');
  btn.classList.toggle('on', on);
}
$('#btn-autoreload').addEventListener('click', () => {
  setFlag('auto-reload', !getAutoReload());
  refreshAutoReloadButton();
  updateToolbar();
});
refreshAutoReloadButton();

// ── Auto-save ──
function getAutoSave() { return getFlag('auto-save'); }
// The one definition of "auto-save covers the open document" — the scheduler,
// the timer, saveFile and the toolbar must all agree on it.
// Sharing doesn't change it: with a file behind the document, auto-save keeps
// the disk copy in step with the session (remote changes schedule it too).
function autoSaveActive() { return getAutoSave() && !!state.fileHandle; }
function refreshAutoSaveButton() {
  const on = getAutoSave();
  const btn = $('#btn-autosave');
  btn.title = 'Auto-save shortly after each change: ' + (on ? 'on' : 'off');
  btn.classList.toggle('on', on);
}
$('#btn-autosave').addEventListener('click', async () => {
  const on = !getAutoSave();
  setFlag('auto-save', on);
  refreshAutoSaveButton();
  updateToolbar();
  // Turning it on IS a user gesture — grab write permission now, because the
  // gesture-less timer never can (it would silently stay dirty until a manual save).
  if (on && state.fileHandle) {
    try {
      if (await state.fileHandle.requestPermission({ mode: 'readwrite' }) === 'granted') {
        autoSaveBlocked = false;
        updateToolbar();
      }
    } catch (_) {}
  }
  scheduleAutoSave();  // turned on with unsaved changes → save them; off → cancels the pending save
});
refreshAutoSaveButton();

let autoSaveTimer = null;
let autoSaveBlockedNotified = false;  // one notice per document, reset on open
let autoSaveBlocked = false;          // auto-save is stalled on write permission — lights the manual save button
function cancelAutoSave() { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
function scheduleAutoSave() {
  cancelAutoSave();
  if (!autoSaveActive()) return;
  autoSaveTimer = setTimeout(() => {
    if (!state.dirty || !autoSaveActive()) return;
    // The disk version moved (conflict banner, even if dismissed since) —
    // never overwrite it silently; a manual save or reload resolves it.
    if (state.diskMoved) return;
    saveFile({ auto: true });
  }, 1500);
}

// ── Folder mode: browse a directory of markdown files ──────
const fileSidebar = $('#file-sidebar');
const fileSidebarGrip = $('#file-sidebar-grip');
// Lazily loaded tree: a directory's entries are read only when it is first
// expanded. node = { name, path, kind, handle, children: null|[node], expanded }
let folder = null;  // { name, root: node, currentPath }

// ── Folder file-list resizing ─────────────────────────────
const FOLDER_SIDEBAR_MIN = 180;
const FOLDER_SIDEBAR_MAX = 520;
const FOLDER_SIDEBAR_DEFAULT = 240;
const FOLDER_SIDEBAR_STORAGE_KEY = 'folder-sidebar-width';

function clampFolderSidebarWidth(width) {
  const max = Math.min(FOLDER_SIDEBAR_MAX, Math.max(FOLDER_SIDEBAR_MIN, window.innerWidth * 0.5));
  return Math.round(Math.max(FOLDER_SIDEBAR_MIN, Math.min(max, width)));
}

function setFolderSidebarWidth(width, persist = true) {
  const value = clampFolderSidebarWidth(width);
  fileSidebar.style.setProperty('--folder-sidebar-width', value + 'px');
  fileSidebarGrip.setAttribute('aria-valuenow', String(value));
  if (persist) {
    try { localStorage.setItem(FOLDER_SIDEBAR_STORAGE_KEY, String(value)); } catch (_) {}
  }
}

function initFolderSidebarResize() {
  let saved = NaN;
  try { saved = Number(localStorage.getItem(FOLDER_SIDEBAR_STORAGE_KEY)); } catch (_) {}
  setFolderSidebarWidth(Number.isFinite(saved) && saved > 0 ? saved : FOLDER_SIDEBAR_DEFAULT, false);

  fileSidebarGrip.addEventListener('dblclick', () => setFolderSidebarWidth(FOLDER_SIDEBAR_DEFAULT));
  fileSidebarGrip.addEventListener('keydown', (e) => {
    const current = parseFloat(getComputedStyle(fileSidebar).width) || FOLDER_SIDEBAR_DEFAULT;
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      setFolderSidebarWidth(current + (e.key === 'ArrowRight' ? step : -step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFolderSidebarWidth(FOLDER_SIDEBAR_MIN);
    } else if (e.key === 'End') {
      e.preventDefault();
      setFolderSidebarWidth(FOLDER_SIDEBAR_MAX);
    }
  });
  fileSidebarGrip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = fileSidebar.getBoundingClientRect().width;
    fileSidebarGrip.setPointerCapture(e.pointerId);
    fileSidebarGrip.classList.add('dragging');
    document.body.classList.add('col-resizing');
    const onMove = (ev) => setFolderSidebarWidth(startWidth + ev.clientX - startX, false);
    const onUp = () => {
      fileSidebarGrip.classList.remove('dragging');
      document.body.classList.remove('col-resizing');
      fileSidebarGrip.removeEventListener('pointermove', onMove);
      fileSidebarGrip.removeEventListener('pointerup', onUp);
      fileSidebarGrip.removeEventListener('pointercancel', onUp);
      const width = parseFloat(getComputedStyle(fileSidebar).width) || FOLDER_SIDEBAR_DEFAULT;
      setFolderSidebarWidth(width);
    };
    fileSidebarGrip.addEventListener('pointermove', onMove);
    fileSidebarGrip.addEventListener('pointerup', onUp);
    fileSidebarGrip.addEventListener('pointercancel', onUp);
  });
  window.addEventListener('resize', () => setFolderSidebarWidth(parseFloat(getComputedStyle(fileSidebar).width) || FOLDER_SIDEBAR_DEFAULT, false));
}

initFolderSidebarResize();

async function pickFolder() {
  if (typeof window.showDirectoryPicker !== 'function') return;
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    const root = { name: dir.name, path: '', kind: 'directory', handle: dir, children: null, expanded: true };
    await loadFolderNode(root);
    folder = { name: dir.name, root, currentPath: null };
    renderFileSidebar();
    fileSidebar.classList.add('visible');
    // A folder whose top level is exactly one markdown file → open it right away.
    if (root.children.length === 1 && root.children[0].kind !== 'directory') {
      openFolderFile(root.children[0]);
    }
  } catch (e) {
    if (e && e.name !== 'AbortError') showAppAlert('Failed to open folder: ' + e.message, 'Could not open folder');
  }
}

async function openSample() {
  if (state.dirty && !await askConfirmation('You have unsaved changes. Open the sample document anyway?', 'Open sample')) return;
  if (!await leaveSharedSession('You are in a shared session. Leave it and open the sample?')) return;
  cancelAutoSave();
  discardPendingEdits();
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  state.rawMarkdown = Core.syncReviewBrief(SAMPLE_MARKDOWN);
  state.fileName = 'annotation-sample.md';
  state.displayPath = 'Sample document — save to create your own copy';
  state.fileHandle = null;
  state.sample = true;
  state.dirty = false;
  state.diskMoved = false;
  state.fileOpen = true;
  clearUndo();
  render({ fresh: true });
  showNotice('Sample opened — try selecting a passage', 'info');
}

// Read one directory's entries on demand. Filtering and ordering live in the
// pure helper; this just attaches paths and handles.
async function loadFolderNode(node) {
  const entries = [];
  for await (const [name, handle] of node.handle.entries()) {
    entries.push({ name, kind: handle.kind, handle });
  }
  node.children = Helpers.folderChildren(entries).map(e => ({
    name: e.name,
    path: node.path ? node.path + '/' + e.name : e.name,
    kind: e.kind,
    handle: e.handle,
    children: null,
    expanded: false,
  }));
}

async function toggleFolderNode(node) {
  if (!node.expanded && node.children === null) {
    try { await loadFolderNode(node); }
    catch (e) { showNotice('Could not read folder: ' + e.message); return; }
  }
  node.expanded = !node.expanded;
  renderFileSidebar();
}

function renderFileSidebar() {
  if (!folder) return;
  $('#folder-name').textContent = folder.name;
  $('#folder-name').title = folder.name;
  const list = $('#file-list');
  list.innerHTML = '';
  if (!folder.root.children.length) {
    const empty = document.createElement('div');
    empty.className = 'file-empty';
    empty.textContent = 'No markdown files or subfolders in this folder.';
    list.appendChild(empty);
    return;
  }
  renderFileTreeLevel(folder.root.children, list, 0);
}

// One flat run of buttons, indented per depth via --depth — full-width rows
// keep the hover/current background stretching across the panel.
function renderFileTreeLevel(nodes, list, depth) {
  for (const n of nodes) {
    const btn = document.createElement('button');
    btn.style.setProperty('--depth', depth);
    btn.title = n.path;
    if (n.kind === 'directory') {
      btn.className = 'file-item dir';
      btn.setAttribute('aria-expanded', String(n.expanded));
      btn.innerHTML = '<svg class="tree-twisty" viewBox="0 0 18 18" aria-hidden="true"><use href="#i-chev-r"/></svg>' +
        '<svg class="tree-ico" viewBox="0 0 18 18" aria-hidden="true"><use href="#i-folder"/></svg>' +
        '<span class="file-label"></span>';
      btn.querySelector('.file-label').textContent = n.name;
      btn.addEventListener('click', () => toggleFolderNode(n));
      list.appendChild(btn);
      if (n.expanded && n.children) {
        if (n.children.length) {
          renderFileTreeLevel(n.children, list, depth + 1);
        } else {
          const none = document.createElement('div');
          none.className = 'file-tree-empty';
          none.style.setProperty('--depth', depth + 1);
          none.textContent = 'no markdown files';
          list.appendChild(none);
        }
      }
    } else {
      btn.className = 'file-item' + (n.path === folder.currentPath ? ' current' : '');
      btn.innerHTML = '<svg class="tree-ico" viewBox="0 0 18 18" aria-hidden="true"><use href="#i-file"/></svg>' +
        '<span class="file-label"></span>';
      btn.querySelector('.file-label').textContent = n.name;
      btn.addEventListener('click', () => openFolderFile(n));
      list.appendChild(btn);
    }
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

// ── Recent files (file handles persisted in IndexedDB) ─────
// Web pages never see real paths; we keep the FileSystemFileHandle objects
// themselves (they are structured-cloneable) and re-request permission on use.
const IDB_NAME = 'md-annotator';
const IDB_STORE = 'recents';
const IDB_SESSION = 'sessions';  // per-tab "what THIS tab had open", keyed by tab id
const MAX_RECENT = 10;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(IDB_SESSION)) db.createObjectStore(IDB_SESSION);
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

// entry: { handle, name }
async function recordRecent(entry) {
  try {
    const db = await idbOpen();
    let all = await idbRequest(db.transaction(IDB_STORE).objectStore(IDB_STORE).getAll());
    // Dedupe: drop entries pointing at the same file and trim.
    const drop = [];
    for (const e of all) {
      if (e.handle) {
        try { if (await e.handle.isSameEntry(entry.handle)) drop.push(e.id); }
        catch (_) { drop.push(e.id); }  // dead/uncloneable handle — prune
      }
    }
    all = all.filter(e => !drop.includes(e.id)).sort((a, b) => b.ts - a.ts);
    for (const e of all.slice(MAX_RECENT - 1)) drop.push(e.id);
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    for (const id of drop) store.delete(id);
    store.add({ handle: entry.handle || null, name: entry.name, ts: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (e) { /* recents are best-effort */ }
}

// ── Per-tab session (refresh-restore) ──────────────────────
// Each tab restores ITS OWN file after a refresh — two tabs with two documents
// must not both reopen the globally most recent one. sessionStorage survives
// reload but is per-tab and absent in new tabs: a random tab id there keys a
// record in IndexedDB (handles aren't storable in sessionStorage itself).
function tabId(create) {
  try {
    let id = sessionStorage.getItem('tab-id');
    if (!id && create) {
      id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      sessionStorage.setItem('tab-id', id);
    }
    return id;
  } catch (_) { return null; }
}

async function recordSession(entry) {
  const id = tabId(true);
  if (!id) return;
  try {
    const db = await idbOpen();
    // Read-then-write in separate transactions (auto-commit while awaiting);
    // both read requests are issued before awaiting so the tx stays alive.
    const ro = db.transaction(IDB_SESSION).objectStore(IDB_SESSION);
    const keysReq = ro.getAllKeys(), rowsReq = ro.getAll();
    const keys = await idbRequest(keysReq);
    const rows = await idbRequest(rowsReq);
    // Prune rows left behind by tabs that closed for good.
    const cutoff = Date.now() - 30 * 864e5;
    const stale = keys.filter((k, i) => k !== id && (!rows[i] || rows[i].ts < cutoff));
    const tx = db.transaction(IDB_SESSION, 'readwrite');
    const store = tx.objectStore(IDB_SESSION);
    for (const k of stale) store.delete(k);
    store.put({ handle: entry.handle || null, name: entry.name, ts: Date.now() }, id);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (_) { /* best-effort, like recents */ }
}

async function fetchSession() {
  const id = tabId(false);
  if (!id) return null;
  try {
    const db = await idbOpen();
    const rec = await idbRequest(db.transaction(IDB_SESSION).objectStore(IDB_SESSION).get(id));
    db.close();
    return rec || null;
  } catch (_) { return null; }
}

async function clearSession() {
  const id = tabId(false);
  try { sessionStorage.removeItem('tab-id'); sessionStorage.removeItem('had-file'); } catch (_) {}
  if (!id) return;
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_SESSION, 'readwrite');
    tx.objectStore(IDB_SESSION).delete(id);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (_) {}
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
  meta.textContent = 'opened ' + new Date(f.ts).toLocaleDateString();
  btn.append(name, meta);
  btn.addEventListener('click', () => {
    hideRecentMenu();
    openHandle(f.handle);
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
async function saveFile(opts) {
  const auto = !!(opts && opts.auto);  // timer-fired: no gestures, no modal dialogs
  if (!state.fileOpen) return;
  if (savePending) { scheduleAutoSave(); return; }  // in flight — retry shortly if auto-save is on
  // A refreshed host's file only needs its permission back — this click is
  // the gesture that can ask for it; only then fall back to the picker.
  if (!state.fileHandle && !auto && Collab.active) await Collab.reattachFile();
  // No file behind the document (the sample, or a shared session joined by
  // link): the first save picks where it goes.
  if (!state.fileHandle) {
    if (auto || typeof window.showSaveFilePicker !== 'function') return;
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: state.fileName, types: FILE_TYPES });
      if (!handle) return;
      state.fileHandle = handle;
      state.sample = false;
      state.fileName = handle.name;
      state.displayPath = handle.name;
      state.lastModified = 0;
    } catch (e) {
      if (e && e.name !== 'AbortError') showAppAlert('Failed to choose a save location: ' + e.message, 'Could not save sample');
      return;
    }
  }
  if (!state.fileHandle) return;
  if (auto && (!autoSaveActive() || state.diskMoved)) return;
  savePending = true;
  const content = state.rawMarkdown;
  // Snapshot the handle: an open() completing during our awaits must not
  // retarget this write at the newly opened file.
  const handle = state.fileHandle;
  try {
    if (auto) {
      // A timer has no user gesture for the permission prompt: only proceed
      // once a manual save has granted write access; until then stay dirty,
      // but tell the user once instead of leaving the dot a mystery.
      if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        autoSaveBlocked = true;
        updateToolbar();  // light the save button — it's the way out of the stall
        if (!autoSaveBlockedNotified) {
          autoSaveBlockedNotified = true;
          showNotice('Auto-save needs write access — save once with Ctrl+S to grant it.', 'info');
        }
        return;
      }
      // The watcher only polls every 3s (and not while hidden) — catch an
      // external write that landed in the gap instead of clobbering it.
      const onDisk = await handle.getFile();
      if (onDisk.lastModified > state.lastModified) {
        state.lastModified = onDisk.lastModified;
        showDiskBanner(true);
        return;
      }
    } else if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted' &&
        await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
      showAppAlert('Write access was not granted — the file was not saved.', 'Save cancelled');
      return;
    }
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    // Re-baseline the watcher so our own write isn't reported as external.
    try { state.lastModified = (await handle.getFile()).lastModified; } catch (_) {}
    if (!auto) recordRecent({ handle, name: handle.name });
    state.diskMoved = false;  // a completed save is the deliberate overwrite
    autoSaveBlocked = false;  // this save proved we can write
    // Only clear dirty if nothing changed while the write was in flight.
    if (state.rawMarkdown === content) {
      state.dirty = false;
      updateToolbar();
    } else {
      scheduleAutoSave();  // more edits arrived mid-write — pick them up too
    }
    flashSaved();
    hideDiskBanner();
  } catch (e) {
    if (auto) {
      autoSaveBlocked = true;  // stalled — light the save button as the manual way out
      updateToolbar();
      showNotice('Auto-save failed: ' + e.message);  // a timer must not raise modal alerts
    } else {
      showAppAlert('Save failed: ' + e.message, 'Could not save file');
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
async function closeFile() {
  if (!state.fileOpen) return;
  if (state.dirty && !await askConfirmation('You have unsaved changes. Close anyway?', 'Close file')) return;
  if (!await leaveSharedSession(Collab.host
    ? 'Close this document and leave the shared session? Others can keep working until it expires.'
    : 'Leave the shared session?')) return;
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  cancelAutoSave();
  state.rawMarkdown = '';
  state.fileName = '';
  state.displayPath = '';
  state.fileHandle = null;
  state.sample = false;
  state.dirty = false;
  state.diskMoved = false;
  state.fileOpen = false;
  clearUndo();
  hideAnnotationPopup();
  hideEditPopup();
  hideDiskBanner();
  contentEl.innerHTML = '';
  updateAnnotationNavigator();
  setMode('annotate');
  if (folder) { folder.currentPath = null; renderFileSidebar(); }
  // A refresh after closing should land on the welcome screen, not reopen.
  clearSession();
  updateToolbar();
  refreshWelcomeRecent();
}
$('#btn-close-file').addEventListener('click', closeFile);


// ── Render ─────────────────────────────────────────────────
let annotationNavGroups = [];
let annotationNavIndex = -1;

function renderAnnotationNavigatorText() {
  const item = annotationNavGroups[annotationNavIndex];
  if (!item) return;
  $('#ann-nav-count').textContent = (annotationNavIndex + 1) + ' / ' + annotationNavGroups.length;
  $('#ann-nav-cycle .rail-count').textContent = String(annotationNavGroups.length);
  $('#ann-nav-cycle').title = 'Next annotation (' + (annotationNavIndex + 1) + ' / ' + annotationNavGroups.length + ')';
  [...$('#ann-nav-list').children].forEach((button, index) => {
    button.classList.toggle('current', index === annotationNavIndex);
    if (index === annotationNavIndex) button.scrollIntoView({ block: 'nearest' });
  });
}

function clearCurrentAnnotation() {
  contentEl.querySelectorAll('.ann-current').forEach(el => el.classList.remove('ann-current'));
  if (document.activeElement && contentEl.contains(document.activeElement)) document.activeElement.blur();
}

function focusAnnotation(index) {
  if (!annotationNavGroups.length) return;
  annotationNavIndex = (index + annotationNavGroups.length) % annotationNavGroups.length;
  const item = annotationNavGroups[annotationNavIndex];
  contentEl.querySelectorAll('.ann-current').forEach(el => el.classList.remove('ann-current'));
  const matches = [...contentEl.querySelectorAll('.ann-wrap[data-ann-group="' + item.group + '"]')];
  matches.forEach(el => el.classList.add('ann-current'));
  const target = matches[0];
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (target.matches('[tabindex]')) target.focus({ preventScroll: true });
  }
  renderAnnotationNavigatorText();
}

function updateAnnotationNavigator() {
  const currentGroup = annotationNavGroups[annotationNavIndex] && annotationNavGroups[annotationNavIndex].group;
  annotationNavGroups = Helpers.annotationGroups(Core.scanAnnotations(state.rawMarkdown));
  if (!annotationNavGroups.length) {
    annotationNavIndex = -1;
    $('#rail-ann').hidden = true;
    return;
  }
  const retained = annotationNavGroups.findIndex(item => item.group === currentGroup);
  annotationNavIndex = retained >= 0 ? retained : Math.min(Math.max(annotationNavIndex, 0), annotationNavGroups.length - 1);
  $('#rail-ann').hidden = false;
  renderAnnotationNavigatorText();
  const list = $('#ann-nav-list');
  list.innerHTML = '';
  let commentNo = 0;  // inline markers number comment groups only; keep the list in step
  annotationNavGroups.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'listitem');
    button.title = item.label || 'Annotation';
    button.classList.toggle('current', index === annotationNavIndex);
    const number = document.createElement('span');
    const isComment = item.kind === 'pair' || item.kind === 'point' || item.kind === 'highlight';
    number.className = 'ann-list-index' + (isComment ? '' : ' ann-list-edit');
    number.textContent = isComment ? String(++commentNo) : '±';
    number.title = isComment ? 'Comment' : 'Suggested edit';
    const label = document.createElement('span');
    label.className = 'ann-list-label';
    label.textContent = item.label || 'Annotation';
    button.append(number, label);
    button.addEventListener('click', () => focusAnnotation(index));
    list.appendChild(button);
  });
}

// Re-renders keep the reader's place (annotating must not jump the page);
// opening a *different* document passes {fresh: true} to start at the top.
function render(opts) {
  const fresh = !!(opts && opts.fresh);
  const scrollTop = fresh ? 0 : renderedView.scrollTop;
  // A new document also invalidates the position remembered for leaving raw mode.
  if (fresh) renderedScrollBeforeRaw = 0;
  // Keep the generated source-level review brief truthful even when an older
  // annotated file, or an externally edited one, is opened. A changed brief is
  // a real in-memory source change and therefore remains dirty until saved.
  const synced = Core.syncReviewBrief(state.rawMarkdown);
  if (synced !== state.rawMarkdown) {
    state.rawMarkdown = synced;
    state.dirty = true;
  }
  // textContent keeps arbitrary Markdown inert and displays the exact source,
  // including CriticMarkup and the generated review brief.
  rawSourceEl.textContent = state.rawMarkdown;
  // Use the shared core: highlighted text is rendered as inline markdown, so a
  // highlight covering **bold**/links/`code` stays one annotation.
  // The brief is for source consumers (especially an LLM); the app already has
  // its compact annotation navigator, so hiding it here avoids duplicated text
  // and prevents users from accidentally annotating generated metadata.
  const renderSource = Core.removeReviewBrief(state.rawMarkdown);
  const { preprocessed, placeholders } = Core.preprocessCriticMarkup(renderSource);
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
      if (state.mode !== 'annotate') return;
      deleteAnnotation(parseInt(btn.dataset.annGroup, 10));
    });
  });

  // Click anywhere on a comment annotation (highlight, point marker) → edit
  // the group's comment. Suggested edits keep their own accept/reject controls.
  contentEl.querySelectorAll('.ann-wrap:not(.ann-edit)').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.ann-badge-actions')) return;
      e.stopPropagation();
      if (state.mode !== 'annotate') return;
      openEditPopup(parseInt(el.dataset.annGroup, 10), el);
    });
    el.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
        e.preventDefault();
        if (state.mode === 'annotate') openEditPopup(parseInt(el.dataset.annGroup, 10), el);
      }
    });
  });

  // Suggested-edit controls: accept applies the change, reject reverts it.
  contentEl.querySelectorAll('.ann-accept').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.mode !== 'annotate') return;
      pushUndo();
      state.rawMarkdown = Core.acceptGroup(state.rawMarkdown, parseInt(btn.dataset.annGroup, 10));
      markDirty();
      render();
    });
  });
  contentEl.querySelectorAll('.ann-reject').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.mode !== 'annotate') return;
      deleteAnnotation(parseInt(btn.dataset.annGroup, 10));
    });
  });

  updateToolbar();
  updateAnnotationNavigator();
  setMode(state.mode);

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
  // In the tabbed PWA the browser's tab strip is the file tab (ours is hidden
  // by CSS), so the window title carries the file name and the dirty mark.
  // The browser tab is narrow — file name first, app name only when idle.
  document.title = state.fileOpen
    ? (state.dirty ? '• ' : '') + (state.fileName || 'Untitled')
    : 'Markdown Annotator';
  // body classes drive the chrome: file tab visibility, sheet frame, dirty dots.
  document.body.classList.toggle('file-open', state.fileOpen);
  document.body.classList.toggle('dirty', state.dirty);
  const noFile = !state.fileOpen;
  // With auto-save on (local files), saving is automatic — the button stays
  // dark even while an edit sits in the debounce window (no flicker), and only
  // lights up when auto-save is stalled with unsaved changes: waiting for write
  // permission, or refusing to overwrite a disk version that moved under us.
  $('#btn-save').disabled = noFile ||
    (autoSaveActive() && !(state.dirty && (autoSaveBlocked || state.diskMoved)));
  // With auto-reload on and nothing unsaved, the watcher already covers manual
  // reloads; the button's only remaining job is "discard my changes" — and with
  // auto-save also covering the edit, dirty is transient (the debounce window),
  // so the button stays dark unless the unsaved state will actually persist.
  const dirtyLasting = state.dirty && (!autoSaveActive() || autoSaveBlocked || state.diskMoved);
  // Reload/watch/auto-save need a file behind the document. Reload and the
  // watcher also step aside while a shared session owns it (they would push
  // the disk copy over everyone's session); auto-save keeps working, since
  // it only flows the other way.
  const noDisk = noFile || !state.fileHandle;
  $('#btn-refresh').disabled = noDisk || Collab.active || (getAutoReload() && !dirtyLasting);
  $('#btn-autoreload').disabled = noDisk || Collab.active;
  $('#btn-autosave').disabled = noDisk;
  refreshAutoSaveButton();  // its knob/title reflect the open file's type
  $('#btn-export').disabled = noFile;
  $('#btn-share').disabled = noFile;
  Collab.refreshUi();
  $('#btn-mode-toggle').disabled = noFile;
  $('#btn-raw-toggle').disabled = noFile;
}

function markDirty() {
  state.dirty = true;
  updateToolbar();
  scheduleAutoSave();
  Collab.pushLocal();  // in a shared session, the change goes out to everyone
}

// ── Source mapping ──────────────────────────────────────────
function findInSource(selectedText, beforeCtx, afterCtx) {
  return Helpers.findInSource(state.rawMarkdown, selectedText, beforeCtx, afterCtx);
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
  if (!state.fileOpen) return;
  if (Collab.active) { Collab.undo(); return; }  // per-user undo over the shared text
  if (!undoStack.length) return;
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
  Collab.anchorPending(pending);  // offsets survive remote changes while the box is open
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
  // Shared sessions sign comments with the author's name; local files don't.
  const comment = Collab.active ? Helpers.tagAuthor(Collab.name, text) : text;
  state.rawMarkdown = Core.applyInserts(state.rawMarkdown, state.pending.inserts, comment);
  markDirty();
  render();
  hideAnnotationPopup();
}

// Toasts: transient notices (red by default, 'ok' green, 'info' blue).
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

// ── Edit annotation popup ──────────────────────────────────
function openEditPopup(group, badgeEl) {
  state.editingIdx = group;
  Collab.anchorEdit(group);
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
$('#btn-welcome-open').addEventListener('click', pickFile);
$('#btn-sample').addEventListener('click', openSample);
$('#ann-nav-prev').addEventListener('click', () => focusAnnotation(annotationNavIndex - 1));
$('#ann-nav-next').addEventListener('click', () => focusAnnotation(annotationNavIndex + 1));
$('#ann-nav-cycle').addEventListener('click', () => focusAnnotation(annotationNavIndex + 1));
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
  if (state.dirty && !await askConfirmation('You have unsaved changes. Reload anyway?', 'Reload file')) return;
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
  if (!win) { showAppAlert('Popup was blocked — allow popups to export PDF.', 'Could not export PDF'); return; }
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
    showAppAlert('EPUB export failed: ' + e.message, 'Could not export EPUB');
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
  // Window frame / tabbed-PWA tab strip: a shade darker than the desk so the
  // tabs read as tabs instead of blending into the app background.
  $('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#0C0F13' : '#C7D0DB');
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
function getRailPref() { return getFlag('rail-collapsed'); }
function applyRailCollapsed() {
  const collapsed = railMq.matches || getRailPref();
  document.body.classList.toggle('rail-collapsed', collapsed);
  $('#rail-toggle-icon').setAttribute('href', collapsed ? '#i-chev-r' : '#i-chev-l');
  $('#rail-toggle-label').textContent = collapsed ? 'Expand' : 'Collapse';
  $('#btn-rail-toggle').title = collapsed ? 'Expand the panel' : 'Collapse the panel';
}
railMq.addEventListener('change', applyRailCollapsed);
$('#btn-rail-toggle').addEventListener('click', () => {
  setFlag('rail-collapsed', !getRailPref());
  applyRailCollapsed();
});
applyRailCollapsed();

// ── Annotate / View / Raw modes ────────────────────────────
let renderedScrollBeforeRaw = 0;
let modeBeforeRaw = 'annotate';
function setMode(mode) {
  if (mode !== 'annotate' && mode !== 'view' && mode !== 'raw') mode = 'annotate';
  const previous = state.mode;
  if (mode === 'raw' && previous !== 'raw') {
    renderedScrollBeforeRaw = renderedView.scrollTop;
    modeBeforeRaw = previous;
  }
  state.mode = mode;
  document.body.classList.toggle('view-mode', mode === 'view');
  document.body.classList.toggle('raw-mode', mode === 'raw');
  $('#btn-mode-toggle').classList.toggle('on', mode === 'view');
  $('#btn-mode-toggle').setAttribute('aria-pressed', String(mode === 'view'));
  $('#btn-raw-toggle').classList.toggle('active', mode === 'raw');
  $('#btn-raw-toggle').setAttribute('aria-pressed', String(mode === 'raw'));
  contentEl.querySelectorAll('.ann-wrap:not(.ann-edit)').forEach(el => {
    el.tabIndex = mode === 'annotate' ? 0 : -1;
    el.setAttribute('aria-disabled', mode === 'annotate' ? 'false' : 'true');
  });
  if (mode !== 'annotate') {
    hideAnnotationPopup();
    hideEditPopup();
  }
  if (previous !== mode) {
    requestAnimationFrame(() => {
      renderedView.scrollTop = mode === 'raw' ? 0
        : previous === 'raw' ? renderedScrollBeforeRaw : renderedView.scrollTop;
    });
  }
}
function toggleMode() { setMode(state.mode === 'view' ? 'annotate' : 'view'); }
function toggleRawMode() { setMode(state.mode === 'raw' ? modeBeforeRaw : 'raw'); }
$('#btn-mode-toggle').addEventListener('click', toggleMode);
$('#btn-raw-toggle').addEventListener('click', toggleRawMode);

// Selection → validate → annotation popup (or "unsupported" notice).
renderedView.addEventListener('mouseup', (e) => {
  if (state.mode !== 'annotate') return;
  if (popup.contains(e.target) || editPopup.contains(e.target)) return;
  if (e.target.closest('.ann-comment-badge') || e.target.closest('.ann-delete')) return;

  setTimeout(() => {
    if (!state.fileOpen || state.mode !== 'annotate') return;
    const selCtx = getSelectionContext();
    if (!selCtx) return;
    const selection = window.getSelection();
    const selectedRange = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    if (selectedRange && [...contentEl.querySelectorAll('.ann-wrap')].some(el => selectedRange.intersectsNode(el))) {
      showNotice('Edit an existing annotation instead of annotating inside it.');
      return;
    }
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
  // A click outside any annotation releases the card pinned by the navigator.
  if (!e.target.closest('.ann-wrap')) clearCurrentAnnotation();
  if (state.mode !== 'annotate') return;
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
      // Fences may be indented up to 3 spaces, and codeFenceRanges now reports
      // those too — keep this index-matched with the rendered .mermaid list.
      return /^(?:[ \t]*>\s*)*[ \t]*(`{3,}|~{3,})\s*mermaid\b/i.test(state.rawMarkdown.slice(s, nl === -1 ? undefined : nl));
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
    if (state.mode !== 'annotate') return;
    const sel2 = window.getSelection();
    if (!sel2 || !sel2.isCollapsed) return;
    const ctx = getCaretContext(e);
    if (!ctx) return;
    const pos = findCaretPosInSource(ctx.beforeCtx, ctx.afterCtx);
    if (pos == null) { showNotice('Couldn’t locate the cursor in the source — try clicking next to some text.'); return; }
    const r = Core.analyzeTarget(state.rawMarkdown, { type: 'point', pos }, md);
    if (!r.supported) { showNotice(r.reason || 'Can’t annotate here.'); return; }
    // Only block/line placements need explaining; a plain point comment
    // lands where the click was, so the label would just repeat the obvious.
    const preview = r.kind === 'block' ? 'Comment on this block'
      : r.kind === 'line' ? 'Comment on this line'
      : '';
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
  if (activeModal && e.key === 'Tab') {
    const focusable = [...activeModal.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null);
    if (focusable.length) {
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  if (e.key === 'Escape') {
    if ($('#message-dialog').classList.contains('visible')) { finishMessage(false); return; }
    if (recentMenu.classList.contains('visible')) { hideRecentMenu(); return; }
    if (exportMenu.classList.contains('visible')) { exportMenu.classList.remove('visible'); return; }
    if (diagramMenu.classList.contains('visible')) { hideDiagramMenu(); return; }
    if (editPopup.classList.contains('visible')) { hideEditPopup(); return; }
    if (popup.classList.contains('visible')) { hideAnnotationPopup(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
    e.preventDefault();
    pickFile();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    toggleRawMode();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    toggleMode();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    undo();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    // Mirror the Save button: with auto-save covering a clean file, a forced
    // rewrite would only bump the mtime and wake external watchers.
    if (!(autoSaveActive() && !state.dirty)) saveFile();
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
  // A guest's unsaved copy of a shared session lives on in the session — no nag.
  if (state.dirty && !(Collab.active && !state.fileHandle)) { e.preventDefault(); e.returnValue = ''; }
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
// No dirty pre-clear here: reloadFromDisk clears it on success, and a failed
// reload must leave the edits marked unsaved (beforeunload, Save button).
$('#btn-disk-reload').addEventListener('click', () => { reloadFromDisk(); });
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
Collab.init();  // before the session restore: a share link in the URL takes precedence
updateToolbar();
refreshWelcomeRecent();
tryRestoreLast();
