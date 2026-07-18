// ── State ──────────────────────────────────────────────────
const state = {
  rawMarkdown: '',
  fileName: '',
  dirty: false,
  pending: null,
  editingIdx: null,
  fileOpen: false,
  fileHandle: null,
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
const filenameDisplay = $('#filename-display');
const unsavedInd = $('#unsaved-indicator');
const annCount = $('#annotation-count');
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
    if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted' &&
        await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
      if (!silent) showNotice('File access was not granted.');
      return;
    }
    const file = await handle.getFile();
    state.rawMarkdown = await file.text();
    state.fileHandle = handle;
    state.fileName = file.name;
    state.dirty = false;
    state.fileOpen = true;
    state.lastModified = file.lastModified;
    clearUndo();
    render();
    recordRecent(handle);
    startWatch();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (!silent) alert('Failed to open file: ' + e.message);
  }
}

// After a page refresh, reopen the last file. Permission usually drops back
// to 'prompt' on reload and requestPermission needs a user gesture, so:
// still granted → reopen silently; otherwise → show the resume bar.
async function tryRestoreLast() {
  if (!FS_SUPPORTED || state.fileOpen) return;
  const rec = await fetchRecent();
  if (!rec.length) return;
  const last = rec[0];
  try {
    if (await last.handle.queryPermission({ mode: 'readwrite' }) === 'granted') {
      await openHandle(last.handle, { silent: true });
      if (state.fileOpen) return;
    }
  } catch (_) { return; }  // dead handle — recents pruning will catch it
  if (state.fileOpen) return;
  const bar = $('#resume-bar');
  $('#resume-name').textContent = last.name;
  bar.style.display = 'flex';
  $('#btn-resume').addEventListener('click', () => {
    bar.style.display = 'none';
    openHandle(last.handle);
  }, { once: true });
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
  if (!state.fileHandle) return;
  try {
    const file = await state.fileHandle.getFile();
    state.rawMarkdown = await file.text();
    state.dirty = false;
    state.lastModified = file.lastModified;
    clearUndo();
    hideDiskBanner();
    render();
  } catch (e) {
    alert('Failed to reload file: ' + e.message);
  }
}

// ── File watching: catch external edits (e.g. an LLM rewriting the file) ──
let watchTimer = null;
function startWatch() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(checkDiskChange, 3000);
}

async function checkDiskChange() {
  if (!state.fileHandle || !state.fileOpen || document.hidden) return;
  try {
    const file = await state.fileHandle.getFile();
    if (file.lastModified <= state.lastModified) return;
    if (!state.dirty) {
      // No local changes — pick up the new content silently, keep scroll.
      state.rawMarkdown = await file.text();
      state.lastModified = file.lastModified;
      clearUndo();
      render();
      showNotice('File changed on disk — reloaded');
    } else {
      // Local unsaved changes would be clobbered either way; let the user pick.
      state.lastModified = file.lastModified;
      showDiskBanner();
    }
  } catch (_) { /* transient read failure — try again next tick */ }
}

function showDiskBanner() { $('#disk-banner').style.display = 'flex'; }
function hideDiskBanner() { $('#disk-banner').style.display = 'none'; }

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
    renderFileSidebar();
  }
}

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

async function recordRecent(handle) {
  try {
    const db = await idbOpen();
    let all = await idbRequest(db.transaction(IDB_STORE).objectStore(IDB_STORE).getAll());
    // Dedupe: drop entries pointing at the same file (isSameEntry) and trim.
    const drop = [];
    for (const e of all) {
      try { if (await e.handle.isSameEntry(handle)) drop.push(e.id); }
      catch (_) { drop.push(e.id); }  // dead/uncloneable handle — prune
    }
    all = all.filter(e => !drop.includes(e.id)).sort((a, b) => b.ts - a.ts);
    for (const e of all.slice(MAX_RECENT - 1)) drop.push(e.id);
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    for (const id of drop) store.delete(id);
    store.add({ handle, name: handle.name, ts: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  } catch (e) { /* recents are best-effort */ }
}

// ── Recent files UI ────────────────────────────────────────
const recentMenu = $('#recent-menu');
const welcomeRecent = $('#welcome-recent');

function recentItemButton(f) {
  const btn = document.createElement('button');
  const name = document.createElement('span');
  name.className = 'recent-name';
  name.textContent = f.name;
  const meta = document.createElement('span');
  meta.className = 'recent-path';
  meta.textContent = 'opened ' + new Date(f.ts).toLocaleDateString();
  btn.append(name, meta);
  btn.addEventListener('click', () => { hideRecentMenu(); openHandle(f.handle); });
  return btn;
}

function hideRecentMenu() { recentMenu.classList.remove('visible'); }

// Dropdown under the Open file button: "Browse files…" + recent files.
async function showRecentMenu() {
  const files = await fetchRecent();
  recentMenu.innerHTML = '';
  const browse = document.createElement('button');
  browse.className = 'recent-browse';
  browse.textContent = 'Browse files…';
  browse.addEventListener('click', () => { hideRecentMenu(); pickFile(); });
  recentMenu.appendChild(browse);
  const folderBtn = document.createElement('button');
  folderBtn.className = 'recent-browse';
  folderBtn.textContent = 'Open folder…';
  folderBtn.addEventListener('click', () => { hideRecentMenu(); pickFolder(); });
  recentMenu.appendChild(folderBtn);
  if (files.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'recent-sep';
    recentMenu.appendChild(sep);
    files.forEach(f => recentMenu.appendChild(recentItemButton(f)));
  }
  const rect = $('#btn-open').getBoundingClientRect();
  recentMenu.style.left = rect.left + 'px';
  recentMenu.style.top = (rect.bottom + 4) + 'px';
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
  if (!state.fileOpen || !state.fileHandle || savePending) return;
  savePending = true;
  const content = state.rawMarkdown;
  try {
    const writable = await state.fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    // Re-baseline the watcher so our own write isn't reported as external.
    try { state.lastModified = (await state.fileHandle.getFile()).lastModified; } catch (_) {}
    // Only clear dirty if nothing changed while the write was in flight.
    if (state.rawMarkdown === content) {
      state.dirty = false;
      updateToolbar();
    }
    flashSaved();
    hideDiskBanner();
  } catch (e) {
    alert('Save failed: ' + e.message);
  } finally {
    savePending = false;
  }
}

function flashSaved() {
  saveStatus.classList.add('show');
  setTimeout(() => saveStatus.classList.remove('show'), 1500);
}

// ── Document-level comments (top-of-file zone) ─────────────
const docZone = Core.docZone;

const docPanel = $('#doc-panel');
const docList = $('#doc-list');
const docAddForm = $('#doc-add-form');
const docAddInput = $('#doc-add-input');

function renderDocPanel(zone) {
  docList.innerHTML = '';
  for (const it of zone.items) {
    const row = document.createElement('div');
    row.className = 'doc-item';
    const icon = document.createElement('span');
    icon.textContent = '\u{1F4AC}';
    const text = document.createElement('span');
    text.className = 'doc-text';
    text.textContent = it.comment.trim();
    const del = document.createElement('button');
    del.className = 'doc-del';
    del.innerHTML = '&times;';
    del.title = 'Delete comment';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.mode === 'view') return;
      deleteAnnotation(it.group);
    });
    row.append(icon, text, del);
    row.addEventListener('click', () => {
      if (state.mode === 'view') return;
      openEditPopup(it.group, row);
    });
    docList.appendChild(row);
  }
  updateDocPanelVisibility(zone.items.length);
}

function updateDocPanelVisibility(count) {
  if (count === undefined) count = docList.children.length;
  const show = state.fileOpen && (count > 0 || state.mode === 'annotate');
  docPanel.style.display = show ? 'block' : 'none';
}

function hideDocAddForm() {
  docAddForm.style.display = 'none';
  docAddInput.value = '';
}

function addDocComment() {
  const comment = docAddInput.value.trim();
  if (!comment) return;
  pushUndo();
  const src = state.rawMarkdown;
  const { end } = docZone(src);
  const prefix = end > 0 && src[end - 1] !== '\n' ? '\n' : '';
  const rest = src.slice(end).replace(/^(\r?\n)+/, '');
  state.rawMarkdown = src.slice(0, end) + prefix + '{>> ' + comment + ' <<}\n\n' + rest;
  hideDocAddForm();
  markDirty();
  render();
}

// ── Annotation list sidebar ─────────────────────────────────
const annSidebar = $('#ann-sidebar');

function sideTrunc(s, n) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function renderAnnSidebar() {
  const list = $('#ann-sidebar-list');
  list.innerHTML = '';
  if (!state.fileOpen) return;
  const zone = Core.docZone(state.rawMarkdown);
  const docGroups = new Set(zone.items.map(i => i.group));
  const seen = new Set();
  const items = Core.scanAnnotations(state.rawMarkdown).filter(it => {
    if (seen.has(it.group)) return false;
    seen.add(it.group);
    return true;
  });
  if (!items.length) {
    list.innerHTML = '<div class="ann-side-empty">No comments yet.<br>Select text to add one.</div>';
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'ann-side-item';
    const kind = document.createElement('span');
    kind.className = 'kind';
    const body = document.createElement('span');
    let quote = '';
    if (docGroups.has(it.group)) {
      kind.classList.add('k-doc'); kind.textContent = 'doc';
      body.textContent = sideTrunc(it.comment, 140);
    } else if (it.kind === 'point') {
      kind.classList.add('k-comment'); kind.textContent = 'note';
      body.textContent = sideTrunc(it.comment, 140);
    } else if (it.kind === 'pair' || it.kind === 'highlight') {
      kind.classList.add('k-comment'); kind.textContent = 'comment';
      body.textContent = sideTrunc(Core.getGroupComment(state.rawMarkdown, it.group), 140);
      quote = sideTrunc(it.text, 60);
    } else {
      kind.classList.add('k-edit'); kind.textContent = 'edit';
      if (it.kind === 'del') body.textContent = 'remove “' + sideTrunc(it.text, 50) + '”';
      else if (it.kind === 'ins') body.textContent = 'insert “' + sideTrunc(it.text, 50) + '”';
      else body.textContent = '“' + sideTrunc(it.text, 35) + '” → “' + sideTrunc(it.text2 || '', 35) + '”';
    }
    row.append(kind, body);
    if (quote) {
      const q = document.createElement('span');
      q.className = 'quote';
      q.textContent = quote;
      row.appendChild(q);
    }
    const group = it.group, isDoc = docGroups.has(it.group);
    row.addEventListener('click', () => jumpToGroup(group, isDoc));
    list.appendChild(row);
  }
}

function jumpToGroup(group, isDoc) {
  const el = isDoc ? docPanel : contentEl.querySelector('[data-ann-group="' + group + '"]');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('ann-flash');
  void el.offsetWidth;  // restart the animation
  el.classList.add('ann-flash');
}

$('#annotation-count').addEventListener('click', () => annSidebar.classList.toggle('visible'));
$('#btn-sidebar-close').addEventListener('click', () => annSidebar.classList.remove('visible'));

// ── Render ─────────────────────────────────────────────────
function render() {
  const scrollTop = renderedView.scrollTop;
  // Use the shared core: highlighted text is rendered as inline markdown, so a
  // highlight covering **bold**/links/`code` stays one annotation.
  const { preprocessed, count, placeholders } = Core.preprocessCriticMarkup(state.rawMarkdown);
  // Doc-zone comments render in the top panel, not as inline badges.
  const zone = docZone(state.rawMarkdown);
  const docGroups = new Set(zone.items.map(it => it.group));
  let rendered = md.render(preprocessed);
  // Swap placeholders back to annotation HTML after markdown-it is done,
  // so table/block parsing isn't broken by inline annotation spans.
  for (const e of placeholders) {
    const html = (e.kind === 'point' && docGroups.has(e.group)) ? '' : Core.annHtml(md, e);
    rendered = rendered.split(e.placeholder).join(html);
  }
  rendered = rendered.replace(/<p>\s*<\/p>/g, '');
  contentEl.innerHTML = rendered;
  renderDocPanel(zone);
  renderAnnSidebar();
  renderedView.scrollTop = scrollTop;

  contentEl.querySelectorAll('.ann-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.mode === 'view') return;
      deleteAnnotation(parseInt(btn.dataset.annGroup, 10));
    });
  });

  // Click a badge or any highlighted block of a group → edit the group's comment.
  contentEl.querySelectorAll('.ann-comment-badge, .ann-hl').forEach(el => {
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
  const groups = new Set(placeholders.map(p => p.group)).size;
  annCount.textContent = groups > 0 ? `${groups} annotation${groups > 1 ? 's' : ''}` : '';

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

function updateToolbar() {
  filenameDisplay.textContent = state.fileName || 'No file open';
  filenameDisplay.title = state.fileName || '';
  unsavedInd.style.display = state.dirty ? 'inline' : 'none';
  const noFile = !state.fileOpen;
  $('#btn-save').disabled = noFile;
  $('#btn-refresh').disabled = noFile;
  $('#btn-mode-annotate').disabled = noFile;
  $('#btn-mode-view').disabled = noFile;
}

function markDirty() {
  state.dirty = true;
  updateToolbar();
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
    const collapsedSel = normalizedSel.replace(/\s+/g, ' ').trim();
    const { collapsed, map } = collapseWithMap(src);
    let cp = -1;
    while ((cp = collapsed.indexOf(collapsedSel, cp + 1)) !== -1) {
      candidates.push({ start: map[cp], end: map[cp + collapsedSel.length - 1] + 1, score: -1 });
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

function collapseWithMap(str) {
  const collapsed = [];
  const map = [];
  let inSpace = false;
  for (let i = 0; i < str.length; i++) {
    if (/\s/.test(str[i])) {
      if (!inSpace) { collapsed.push(' '); map.push(i); inSpace = true; }
    } else {
      collapsed.push(str[i]); map.push(i); inSpace = false;
    }
  }
  return { collapsed: collapsed.join(''), map };
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
  pending.suggest = false;
  // A suggestion replaces one contiguous span, so only offer the tab when the
  // target maps to exactly one simple range insert.
  pending.canSuggest = pending.inserts.length === 1 && pending.inserts[0].type === 'pair';
  $('#tab-suggest').disabled = !pending.canSuggest;
  setPopupTab(false);
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

function setPopupTab(suggest) {
  if (!state.pending) return;
  state.pending.suggest = suggest;
  $('#tab-comment').classList.toggle('on', !suggest);
  $('#tab-suggest').classList.toggle('on', suggest);
  if (suggest) {
    const ins = state.pending.inserts[0];
    annInput.placeholder = 'Replacement text...';
    annInput.value = state.rawMarkdown.slice(ins.start, ins.end);
    $('#btn-ann-save').textContent = 'Suggest';
  } else {
    annInput.placeholder = 'Add your comment...';
    annInput.value = '';
    $('#btn-ann-save').textContent = 'Add Comment';
  }
  annInput.focus();
}
$('#tab-comment').addEventListener('click', () => setPopupTab(false));
$('#tab-suggest').addEventListener('click', () => setPopupTab(true));

function hideAnnotationPopup() {
  popup.classList.remove('visible');
  hideInsCaret();
  state.pending = null;
}

function commitAnnotation() {
  const text = annInput.value.trim();
  if (!text || !state.pending) return;
  pushUndo();
  if (state.pending.suggest) {
    const ins = state.pending.inserts[0];
    if (text === state.rawMarkdown.slice(ins.start, ins.end).trim()) { undoStack.pop(); hideAnnotationPopup(); return; }
    state.rawMarkdown = Core.suggestEdit(state.rawMarkdown, ins.start, ins.end, text);
  } else {
    state.rawMarkdown = Core.applyInserts(state.rawMarkdown, state.pending.inserts, text);
  }
  markDirty();
  render();
  hideAnnotationPopup();
}

// Transient toast for "can't annotate here" notices.
let noticeTimer = null;
function showNotice(msg) {
  const el = $('#notice');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove('show'), 2600);
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
$('#btn-open').addEventListener('click', (e) => {
  e.stopPropagation();
  if (recentMenu.classList.contains('visible')) hideRecentMenu();
  else showRecentMenu();
});
document.addEventListener('mousedown', (e) => {
  if (!recentMenu.contains(e.target) && !e.target.closest('#btn-open')) hideRecentMenu();
});
window.addEventListener('scroll', hideRecentMenu, true);
$('#btn-save').addEventListener('click', saveFile);
$('#btn-refresh').addEventListener('click', async () => {
  if (!state.fileOpen) return;
  if (state.dirty && !confirm('You have unsaved changes. Reload anyway?')) return;
  await reloadFromDisk();
});

// ── Theme (light / dark) ───────────────────────────────────
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#hljs-light').disabled = theme === 'dark';
  $('#hljs-dark').disabled = theme !== 'dark';
  $('#btn-theme').innerHTML = theme === 'dark' ? '&#9728;&#65039;' : '&#127769;';
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

// ── Annotate / View mode ───────────────────────────────────
function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('view-mode', mode === 'view');
  $('#btn-mode-annotate').classList.toggle('on', mode === 'annotate');
  $('#btn-mode-view').classList.toggle('on', mode === 'view');
  if (mode === 'view') {
    hideAnnotationPopup();
    hideEditPopup();
    hideDocAddForm();
  }
  updateDocPanelVisibility();
}
function toggleMode() { setMode(state.mode === 'annotate' ? 'view' : 'annotate'); }
$('#btn-mode-annotate').addEventListener('click', () => setMode('annotate'));
$('#btn-mode-view').addEventListener('click', () => setMode('view'));

// ── Document comments panel events ─────────────────────────
$('#btn-doc-add').addEventListener('click', () => {
  if (state.mode === 'view') return;
  docAddForm.style.display = 'block';
  docAddInput.focus();
});
$('#btn-doc-save').addEventListener('click', addDocComment);
$('#btn-doc-cancel').addEventListener('click', hideDocAddForm);
docAddInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addDocComment(); }
  if (e.key === 'Escape') { e.stopPropagation(); hideDocAddForm(); }
});

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
$('#btn-welcome-open').addEventListener('click', pickFile);
$('#btn-disk-reload').addEventListener('click', () => { state.dirty = false; reloadFromDisk(); });
$('#btn-disk-dismiss').addEventListener('click', hideDiskBanner);
$('#btn-folder-close').addEventListener('click', () => {
  fileSidebar.classList.remove('visible');
  folder = null;
});
if (!FS_SUPPORTED) {
  $('#browser-warning').style.display = 'block';
  $('#btn-welcome-open').disabled = true;
  $('#btn-open').disabled = true;
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
