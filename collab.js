/*
 * collab.js — shared sessions.
 *
 * While a session is live the open document is a Yjs text (the markdown body
 * WITHOUT the generated review brief, which every client regenerates locally
 * so concurrent edits never fight over derived text). Local mutations keep
 * flowing through app.js exactly as before: markDirty() calls pushLocal(),
 * which diffs state.rawMarkdown against the shared text and applies the one
 * splice. Remote changes arrive as Yjs updates, land in the shared text, and
 * applyFromDoc() writes them back into state.rawMarkdown and re-renders.
 *
 * Transport is the relay in relay/: a dumb per-room log of opaque strings.
 * Every update is AES-GCM encrypted here with a key that lives only in the
 * share link's URL fragment, so the relay stores ciphertext it cannot read.
 *
 * Loaded before app.js; it touches app.js globals (state, render, ...) only
 * from event handlers, after both scripts have run.
 */
(function () {
  'use strict';

  const YJS_URL = 'https://cdn.jsdelivr.net/npm/yjs@13.6.27/+esm';
  // The deployed relay (see relay/README.md). A `wrangler dev` relay is used
  // automatically when the app itself runs on localhost; localStorage
  // 'relay-url' overrides both.
  const RELAY_URL = 'wss://md-annotator-relay.vratacermak.workers.dev';
  const DEV_RELAY_URL = 'ws://127.0.0.1:8787';

  const LOCAL = 'local';    // Yjs transaction origins: our own splices ...
  const REMOTE = 'remote';  // ... and updates received from the relay
  const KEEPALIVE_MS = 25000;
  const PRESENCE_MS = 20000;
  const SNAPSHOT_AFTER = 40;   // compact the relay log once this many updates pile up
  const NAME_KEY = 'share-name';
  const HOST_KEY = 'share-host';  // sessionStorage: the room this tab created

  const $ = (sel) => document.querySelector(sel);
  const Helpers = () => window.AnnotatorAppHelpers;
  const utf8 = { enc: new TextEncoder(), dec: new TextDecoder() };

  let s = null;          // the live session (see createSession)
  let pendingAttach = null;  // host refresh: the tab's file handle, attached once the session is adopted
  let yjsPromise = null;
  let menuOpen = false;

  const Collab = window.Collab = {
    active: false,   // a document is being shared right now
    joining: false,  // a share link is being opened (set synchronously on load)
    get host() { return !!(s && s.host); },
    get name() { return s ? s.name : getName(); },
    init, share, stopSharing, leave, pushLocal, undo, canUndo,
    anchorPending, rebasePending, anchorEdit, attachHandle, refreshUi,
    session: () => s,
  };

  // ── Config / small utilities ───────────────────────────────
  function relayUrl() {
    try { const o = localStorage.getItem('relay-url'); if (o) return o.replace(/\/$/, ''); } catch (_) {}
    const h = location.hostname;
    return (h === 'localhost' || h === '127.0.0.1') ? DEV_RELAY_URL : RELAY_URL;
  }
  function getName() {
    try { return localStorage.getItem(NAME_KEY) || ''; } catch (_) { return ''; }
  }
  function setName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch (_) {}
  }
  function hostRoom() {
    try { return sessionStorage.getItem(HOST_KEY) || ''; } catch (_) { return ''; }
  }
  function setHostRoom(room) {
    try { room ? sessionStorage.setItem(HOST_KEY, room) : sessionStorage.removeItem(HOST_KEY); } catch (_) {}
  }

  const b64url = {
    encode(bytes) {
      let str = '';
      for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    decode(text) {
      const bin = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
  };

  function importKey(raw) {
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async function encrypt(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return b64url.encode(out);
  }
  async function decrypt(key, text) {
    const bytes = b64url.decode(text);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
  }

  function loadYjs() {
    if (!yjsPromise) {
      yjsPromise = import(YJS_URL).catch(e => { yjsPromise = null; throw e; });
    }
    return yjsPromise;
  }

  function shareLink(room, key) {
    return location.origin + location.pathname + Helpers().shareHash(room, key);
  }

  // ── Session ────────────────────────────────────────────────
  function createSession(Y, room, keyBytes, cryptoKey, host) {
    const doc = new Y.Doc();
    const text = doc.getText('md');
    const session = {
      Y, doc, text, meta: doc.getMap('meta'), room, key: b64url.encode(keyBytes), cryptoKey, host,
      name: getName(),
      ws: null, status: 'connecting', retry: 0, ended: false,
      seq: 0,             // highest relay seq we hold (replayed, live, or acked)
      queue: [],          // frames to send once the socket is open
      sendChain: Promise.resolve(),  // encryption is async; keep frames in order
      recvChain: Promise.resolve(),  // so is decryption
      synced: false,      // the first replay finished
      replaying: false,   // between 'hi' and 'sync': apply quietly, render once
      adopted: false,     // state.rawMarkdown mirrors the shared text
      peers: new Map(),   // relay client id → { name, ts }
      cid: 0,
      timers: {},
      undo: new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 }),
    };
    doc.on('update', (update, origin) => { if (origin !== REMOTE) queueUpdate(session, update); });
    text.observe((ev, tr) => { if (tr.origin !== LOCAL && session.adopted && !session.replaying) applyFromDoc(); });
    return session;
  }

  // Start sharing the open document: new room, new key, our text as update #1.
  async function share() {
    if (s || !state.fileOpen) return;
    const name = await askName('share');
    if (name == null) return;
    let Y;
    try { Y = await loadYjs(); }
    catch (_) { showAppAlert('The collaboration library could not be loaded. Check your connection and try again.', 'Sharing unavailable'); return; }
    if (s || !state.fileOpen) return;  // something changed while the dialog was up
    const room = b64url.encode(crypto.getRandomValues(new Uint8Array(16)));
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    s = createSession(Y, room, keyBytes, await importKey(keyBytes), true);
    s.name = name;
    s.adopted = true;
    s.doc.transact(() => {
      s.text.insert(0, Core.removeReviewBrief(state.rawMarkdown));
      s.meta.set('name', state.fileName || 'document.md');
    }, LOCAL);
    s.undo.clear();
    setHostRoom(room);
    history.replaceState(null, '', Helpers().shareHash(room, s.key));
    enterSession();
    connect(true);
    const link = shareLink(room, s.key);
    try { await navigator.clipboard.writeText(link); showNotice('Sharing on — link copied', 'ok'); }
    catch (_) { showNotice('Sharing on — copy the link from the Share panel', 'info'); }
    openMenu();
  }

  // Open a share link: connect, replay, then adopt the shared text.
  async function joinFromHash(parsed) {
    Collab.joining = true;
    try {
      let keyBytes;
      try { keyBytes = b64url.decode(parsed.key); } catch (_) { keyBytes = null; }
      if (!keyBytes || keyBytes.length !== 32) {
        await showAppAlert('This share link is not valid.', 'Cannot join');
        clearHash();
        return;
      }
      const name = await askName('join');
      if (name == null) { clearHash(); return; }
      let Y;
      try { Y = await loadYjs(); }
      catch (_) { await showAppAlert('The collaboration library could not be loaded. Check your connection and reload the link.', 'Cannot join'); return; }
      if (s) return;
      s = createSession(Y, parsed.room, keyBytes, await importKey(keyBytes), hostRoom() === parsed.room);
      s.name = name;
      connect(false);
    } finally {
      if (!s) Collab.joining = false;
    }
  }

  function enterSession() {
    Collab.active = true;
    Collab.joining = false;
    document.body.classList.add('sharing');
    s.timers.presence = setInterval(sendPresence, PRESENCE_MS);
    updateToolbar();
    refreshUi();
  }

  // First replay done for a joiner: the shared text becomes the open document.
  function adoptDocument() {
    cancelAutoSave();
    if (typeof watchTimer !== 'undefined' && watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    discardPendingEdits();
    hideDiskBanner();
    const name = s.meta.get('name') || 'shared-document.md';
    state.rawMarkdown = Core.syncReviewBrief(s.text.toString());
    state.fileName = name;
    state.displayPath = name + ' — shared session';
    state.fileHandle = null;
    state.sample = false;
    state.dirty = false;
    state.diskMoved = false;
    state.fileOpen = true;
    clearUndo();
    s.adopted = true;
    s.undo.clear();
    render({ fresh: true });
    enterSession();
    showNotice('Joined the shared session', 'ok');
    if (pendingAttach) { const h = pendingAttach; pendingAttach = null; attachHandle(h); }
  }

  // Tear the session down; the document stays open as it is.
  function teardown() {
    if (!s) return;
    const session = s;
    s = null;
    pendingAttach = null;
    session.ended = true;
    for (const t of Object.values(session.timers)) { clearTimeout(t); clearInterval(t); }
    if (session.ws) { try { session.ws.onclose = null; session.ws.close(); } catch (_) {} }
    try { session.undo.destroy(); session.doc.destroy(); } catch (_) {}
    if (hostRoom() === session.room) setHostRoom('');
    Collab.active = false;
    Collab.joining = false;
    document.body.classList.remove('sharing');
    clearHash();
    closeMenu();
    if (state.fileOpen && !state.sample) {
      state.displayPath = state.fileHandle ? state.fileName : state.fileName + ' — copy of the shared session';
    }
    updateToolbar();
    refreshUi();
  }

  function clearHash() {
    if (Helpers().parseShareHash(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }

  async function leave() {
    if (!s) return;
    teardown();
    showNotice('Left the shared session', 'info');
  }

  async function stopSharing() {
    if (!s) return;
    if (!await askConfirmation('Stop sharing? Everyone else loses the live session; their copies stay open so they can save them.', 'Stop sharing')) return;
    if (!s) return;
    if (s.ws && s.ws.readyState === WebSocket.OPEN) {
      s.stoppedByUs = true;
      s.ws.send(JSON.stringify({ t: 'end' }));
      // The relay answers with {t:'end'} and closes; don't wait for it.
    }
    teardown();
    showNotice('Sharing stopped', 'ok');
  }

  // ── Relay connection ───────────────────────────────────────
  function connect(create) {
    if (!s || s.ended) return;
    const session = s;
    const url = relayUrl() + '/room/' + session.room + '?since=' + session.seq + (create ? '&create=1' : '');
    let ws;
    try { ws = new WebSocket(url); }
    catch (_) { scheduleReconnect(); return; }
    session.ws = ws;
    setStatus('connecting');
    ws.onopen = () => {
      if (s !== session || session.ws !== ws) return;
      session.retry = 0;
      setStatus('connected');
      for (const frame of session.queue) ws.send(JSON.stringify(frame));
      session.queue = [];
      session.timers.keepalive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, KEEPALIVE_MS);
      sendPresence();
    };
    ws.onmessage = (ev) => {
      if (s !== session) return;
      session.recvChain = session.recvChain.then(() => handleFrame(session, ev.data)).catch(() => {});
    };
    ws.onclose = (ev) => {
      if (s !== session || session.ws !== ws) return;
      clearInterval(session.timers.keepalive);
      session.ws = null;
      if (session.ended) return;
      if (ev.code === 4404) { roomGone(); return; }
      scheduleReconnect();
    };
    ws.onerror = () => { /* the close event follows */ };
  }

  function scheduleReconnect() {
    if (!s || s.ended) return;
    setStatus('reconnecting');
    const delay = Math.min(15000, 1000 * Math.pow(2, s.retry++));
    clearTimeout(s.timers.reconnect);
    s.timers.reconnect = setTimeout(() => connect(false), delay);
  }

  function setStatus(status) {
    if (!s) return;
    s.status = status;
    refreshUi();
  }

  function sendFrame(frame) {
    if (!s) return;
    if (s.ws && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(frame));
    else if (frame.t !== 'p') s.queue.push(frame);
  }

  function queueUpdate(session, update) {
    session.sendChain = session.sendChain.then(async () => {
      if (s !== session) return;
      const d = await encrypt(session.cryptoKey, update);
      if (s === session) sendFrame({ t: 'u', d });
    }).catch(() => {});
  }

  async function handleFrame(session, data) {
    if (typeof data !== 'string' || data === 'pong') return;
    let m;
    try { m = JSON.parse(data); } catch (_) { return; }
    if (s !== session) return;
    switch (m.t) {
      case 'hi':
        session.cid = m.c;
        session.replaying = true;
        session.peers.clear();
        for (const c of m.peers || []) session.peers.set(c, { name: '', ts: Date.now() });
        refreshUi();
        break;
      case 's':
      case 'u': {
        let bytes;
        try { bytes = await decrypt(session.cryptoKey, m.d); }
        catch (_) { badKey(); return; }
        if (s !== session) return;
        session.Y.applyUpdate(session.doc, bytes, REMOTE);
        if (m.n > session.seq) session.seq = m.n;
        break;
      }
      case 'ack':
        if (m.n > session.seq) session.seq = m.n;
        break;
      case 'sync':
        session.replaying = false;
        if (!session.synced) {
          session.synced = true;
          if (!session.adopted) adoptDocument();
        }
        applyFromDoc();
        if (m.count >= SNAPSHOT_AFTER) sendSnapshot(session, m.n);
        break;
      case 'join':
        session.peers.set(m.c, { name: '', ts: Date.now() });
        sendPresence();
        refreshUi();
        break;
      case 'leave':
        session.peers.delete(m.c);
        refreshUi();
        break;
      case 'p': {
        let info = null;
        try { info = JSON.parse(utf8.dec.decode(await decrypt(session.cryptoKey, m.d))); } catch (_) {}
        if (s !== session) return;
        if (info && typeof info.name === 'string') session.peers.set(m.c, { name: info.name.slice(0, 40), ts: Date.now() });
        refreshUi();
        break;
      }
      case 'end':
        roomEnded();
        break;
      case 'gone':
        roomGone();
        break;
      case 'err':
        showNotice('Shared session: ' + (m.m || 'the relay refused a message'));
        break;
      default:
        break;
    }
  }

  // Replace the relay's log with one encrypted snapshot of everything up to n.
  function sendSnapshot(session, n) {
    session.sendChain = session.sendChain.then(async () => {
      if (s !== session) return;
      const d = await encrypt(session.cryptoKey, session.Y.encodeStateAsUpdate(session.doc));
      if (s === session) sendFrame({ t: 's', d, n });
    }).catch(() => {});
  }

  function sendPresence() {
    if (!s || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
    const session = s;
    session.sendChain = session.sendChain.then(async () => {
      if (s !== session) return;
      const d = await encrypt(session.cryptoKey, utf8.enc.encode(JSON.stringify({ name: session.name })));
      if (s === session && session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ t: 'p', d }));
    }).catch(() => {});
  }

  function roomEnded() {
    if (!s) return;
    const wasAdopted = s.adopted;
    teardown();
    if (wasAdopted) showBanner('The host stopped sharing. Your copy stays open — save it to keep your annotations.');
  }

  function roomGone() {
    if (!s) return;
    const wasAdopted = s.adopted;
    teardown();
    if (wasAdopted) showBanner('This shared session has expired. Your copy stays open — save it to keep your annotations.');
    else showAppAlert('This shared session has ended, or the link is not valid.', 'Cannot join');
  }

  function badKey() {
    if (!s) return;
    const wasAdopted = s.adopted;
    teardown();
    showAppAlert(wasAdopted
      ? 'A message in the shared session could not be decrypted. Your copy stays open — save it to keep it.'
      : 'This link\'s key does not match the shared document. Ask the host for a fresh link.', 'Shared session');
  }

  // ── Document ↔ shared text ─────────────────────────────────
  // Called from markDirty(): push whatever app.js just changed.
  function pushLocal() {
    if (!s || !s.adopted) return;
    const body = Core.removeReviewBrief(state.rawMarkdown);
    const d = Helpers().textDiff(s.text.toString(), body);
    if (!d) return;
    s.doc.transact(() => {
      if (d.remove) s.text.delete(d.index, d.remove);
      if (d.insert) s.text.insert(d.index, d.insert);
    }, LOCAL);
  }

  // The shared text changed under us (remote update, undo): mirror it.
  function applyFromDoc() {
    if (!s || !s.adopted) return;
    const next = Core.syncReviewBrief(s.text.toString());
    if (next === state.rawMarkdown) return;
    state.rawMarkdown = next;
    // Whatever was saved locally is now behind the session; markDirty also
    // schedules auto-save (its pushLocal is a no-op here — state mirrors the doc).
    markDirty();
    rebasePending();
    render();
  }

  function undo() {
    if (!s || !s.adopted) return;
    if (s.undo.canUndo()) s.undo.undo();
  }
  function canUndo() { return !!(s && s.adopted && s.undo.canUndo()); }

  // Offsets in state.rawMarkdown include the generated brief; the shared text
  // doesn't. Convert around it.
  function rawToBody(pos) {
    const r = Core.reviewBriefRange(state.rawMarkdown);
    if (!r) return pos;
    return pos >= r.end ? pos - (r.end - r.start) : Math.min(pos, r.start);
  }
  function bodyToRaw(pos) {
    const r = Core.reviewBriefRange(state.rawMarkdown);
    if (!r) return pos;
    return pos >= r.start ? pos + (r.end - r.start) : pos;
  }
  function relAt(rawPos, assoc) {
    return s.Y.createRelativePositionFromTypeIndex(s.text, rawToBody(rawPos), assoc);
  }
  function absOf(rel) {
    const a = s.Y.createAbsolutePositionFromRelativePosition(rel, s.doc);
    return a ? bodyToRaw(a.index) : null;
  }

  // A comment popup holds source offsets. Pin them to the shared text so a
  // remote change while the user is typing moves them instead of corrupting
  // the document.
  function anchorPending(pending) {
    if (!s || !s.adopted || !pending || !pending.inserts) return;
    pending.anchors = pending.inserts.map(ins => ins.type === 'pair'
      ? { start: relAt(ins.start, 0), end: relAt(ins.end, -1) }
      : { pos: relAt(ins.pos, 0) });
  }

  function anchorEdit(group) {
    if (!s || !s.adopted) return;
    const first = Core.scanAnnotations(state.rawMarkdown).find(it => it.group === group);
    s.editAnchor = first ? relAt(first.mStart, 0) : null;
  }

  function rebasePending() {
    if (!s) return;
    const pending = state.pending;
    if (pending && pending.anchors) {
      let ok = true;
      const inserts = pending.inserts.map((ins, i) => {
        const a = pending.anchors[i];
        if (ins.type === 'pair') {
          const start = absOf(a.start), end = absOf(a.end);
          if (start == null || end == null || end <= start) { ok = false; return ins; }
          return Object.assign({}, ins, { start, end });
        }
        const pos = absOf(a.pos);
        if (pos == null) { ok = false; return ins; }
        return Object.assign({}, ins, { pos });
      });
      if (ok) pending.inserts = inserts;
      else { hideAnnotationPopup(); showNotice('The passage you were commenting on changed — please select it again.', 'info'); }
    } else if (pending) {
      hideAnnotationPopup();
    }
    if (state.editingIdx !== null) {
      const pos = s.editAnchor ? absOf(s.editAnchor) : null;
      const item = pos == null ? null : Core.scanAnnotations(state.rawMarkdown).find(it => it.mStart === pos);
      if (item) state.editingIdx = item.group;
      else { hideEditPopup(); showNotice('That comment changed or was removed by someone else.', 'info'); }
    }
  }

  // Host refresh: the tab's restored file handle becomes the save target again.
  async function attachHandle(handle) {
    if (!s || !s.adopted) { pendingAttach = handle; return; }
    if (!s.host) return;  // a guest tab that used to hold another file must not save over it
    try {
      if (await handle.queryPermission({ mode: 'read' }) !== 'granted') return;
      const file = await handle.getFile();
      const onDisk = await file.text();
      if (!s || !s.adopted) return;
      state.fileHandle = handle;
      state.fileName = handle.name;
      state.displayPath = handle.name + ' — shared session';
      state.sample = false;
      state.lastModified = file.lastModified;
      state.dirty = false;
      if (onDisk !== state.rawMarkdown) markDirty();  // schedules auto-save when it is on
      updateToolbar();
    } catch (_) { /* dead handle — the guest-style Save as still works */ }
  }

  // ── UI ─────────────────────────────────────────────────────
  function askName(purpose) {
    const dialog = $('#share-dialog');
    const input = $('#share-name');
    input.value = getName();
    $('#share-dialog-title').textContent = purpose === 'share' ? 'Share this document' : 'Join a shared session';
    $('#share-dialog-text').textContent = purpose === 'share'
      ? 'Anyone with the link can read and annotate this document live. It is encrypted in your browser; the relay only ever holds ciphertext, and forgets the session a day after the last change.'
      : 'Someone shared a document with you. Your name is added to the comments you make.';
    $('#share-ok').textContent = purpose === 'share' ? 'Start sharing' : 'Join';
    return new Promise(resolve => {
      const done = (value) => {
        $('#share-ok').removeEventListener('click', onOk);
        $('#share-cancel').removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
        hideModal(dialog);
        resolve(value);
      };
      const onOk = () => {
        const name = input.value.replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!name) { input.focus(); return; }
        setName(name);
        done(name);
      };
      const onCancel = () => done(null);
      const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } else if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
      $('#share-ok').addEventListener('click', onOk);
      $('#share-cancel').addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
      showModal(dialog, input);
      requestAnimationFrame(() => input.select());
    });
  }

  function showBanner(text) {
    $('#share-banner-msg').textContent = text;
    $('#share-banner').style.display = 'flex';
  }
  function hideBanner() { $('#share-banner').style.display = 'none'; }

  const menu = () => $('#share-menu');
  function openMenu() {
    if (!s) return;
    refreshUi();
    const rect = $('#btn-share').getBoundingClientRect();
    menu().style.left = (rect.right + 8) + 'px';
    menu().style.top = Math.min(rect.top, window.innerHeight - 360) + 'px';
    menu().classList.add('visible');
    menuOpen = true;
  }
  function closeMenu() { menu().classList.remove('visible'); menuOpen = false; }

  function statusText() {
    if (!s) return '';
    const people = s.peers.size + 1;
    const who = people === 1 ? 'only you so far' : people + ' people';
    if (s.status === 'connected') return 'Live · ' + who;
    if (s.status === 'connecting') return 'Connecting…';
    return 'Reconnecting… changes are kept until the relay is back';
  }

  function refreshUi() {
    const btn = $('#btn-share');
    if (!btn) return;
    const on = !!s;
    btn.classList.toggle('on', on);
    btn.classList.toggle('offline', on && s.status !== 'connected');
    const count = on ? s.peers.size + 1 : 0;
    $('#share-label').textContent = on ? 'Sharing · ' + count : 'Share';
    $('#share-count').textContent = String(count);
    btn.title = on ? statusText() + ' — open the share panel' : 'Share this document for live annotation';
    if (!on) return;
    $('#share-status').textContent = statusText();
    $('#share-link').value = shareLink(s.room, s.key);
    const list = $('#share-peers');
    list.innerHTML = '';
    const me = document.createElement('div');
    me.className = 'share-peer';
    me.textContent = s.name + ' (you)';
    list.appendChild(me);
    for (const p of s.peers.values()) {
      const el = document.createElement('div');
      el.className = 'share-peer';
      el.textContent = p.name || 'Joining…';
      list.appendChild(el);
    }
    $('#btn-share-stop').hidden = !s.host;
    $('#btn-share-leave').textContent = s.host ? 'Leave (keep it running)' : 'Leave session';
  }

  function init() {
    $('#btn-share').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!s) { share(); return; }
      if (menuOpen) closeMenu(); else openMenu();
    });
    $('#btn-share-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#share-link').value); showNotice('Link copied', 'ok'); }
      catch (_) { $('#share-link').select(); showNotice('Copy the link with Ctrl+C', 'info'); }
    });
    $('#share-link').addEventListener('focus', (e) => e.target.select());
    $('#btn-share-stop').addEventListener('click', () => { closeMenu(); stopSharing(); });
    $('#btn-share-leave').addEventListener('click', () => { closeMenu(); leave(); });
    $('#btn-share-banner-dismiss').addEventListener('click', hideBanner);
    document.addEventListener('mousedown', (e) => {
      if (menuOpen && !menu().contains(e.target) && !e.target.closest('#btn-share')) closeMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) closeMenu(); });
    window.addEventListener('scroll', closeMenu, true);

    window.addEventListener('hashchange', async () => {
      const parsed = Helpers().parseShareHash(location.hash);
      if (!parsed || (s && s.room === parsed.room)) return;
      if (state.dirty && !await askConfirmation('You have unsaved changes. Join the shared session anyway?', 'Join')) { clearHash(); return; }
      if (s) teardown();
      joinFromHash(parsed);
    });

    const parsed = Helpers().parseShareHash(location.hash);
    if (parsed) {
      Collab.joining = true;  // synchronously, so the session restore attaches instead of opening
      joinFromHash(parsed);
    }
  }
})();
