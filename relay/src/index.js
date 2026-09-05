/*
 * md-annotator relay — a deliberately dumb message log for shared sessions.
 *
 * One Durable Object per room. Clients connect over a WebSocket, send opaque
 * strings (the app sends AES-GCM ciphertext of Yjs updates), and the room
 * appends them to a log, broadcasts them to the other sockets, and replays
 * the log to whoever joins later. The relay never sees plaintext: the key
 * travels in the share link's URL fragment, which browsers never send.
 *
 * Wire protocol (JSON text frames):
 *   client → room
 *     {t:'u', d}          append an update; broadcast to others as {t:'u', d, n}
 *     {t:'s', d, n}       snapshot replacing every update with seq <= n
 *                         (n <= the standing snapshot is acked as a no-op:
 *                         several clients compacting at once is not an error)
 *     {t:'p', d}          presence; broadcast to others as {t:'p', c, d}, never stored
 *     {t:'end'}           delete the room; everybody receives {t:'end', r} and is closed
 *                         (r: 'ended' when a client ended it, 'expired' on TTL)
 *     'ping'              keepalive, answered with 'pong' without waking the object
 *   room → client
 *     {t:'hi', c, peers, n}   your client id, the other client ids, the current seq
 *     {t:'s', d, n} / {t:'u', d, n} ...   replay (only entries above ?since=)
 *     {t:'sync', n, count}    replay finished; count = updates since the snapshot
 *     {t:'ack', n}            seq assigned to your last update
 *     {t:'join', c} / {t:'leave', c}
 *     {t:'gone'}              no such room (expired or never created); socket closes
 *     {t:'err', m}            the message was refused
 *
 * Connect to /room/<id>?create=1 to create-or-join, without create=1 to join
 * only; ?since=<n> skips replaying updates the client already holds.
 */

const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_MESSAGE = 4 * 1024 * 1024;     // one frame
const MAX_ROOM_BYTES = 16 * 1024 * 1024; // snapshot + log, roughly

const SEQ_WIDTH = 12;
const updateKey = (n) => 'u:' + String(n).padStart(SEQ_WIDTH, '0');
const seqOf = (key) => parseInt(key.slice(2), 10);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('md-annotator relay\n', { headers: { 'content-type': 'text/plain' } });
    }
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response('not found', { status: 404 });
    if (!ROOM_ID.test(m[1])) return new Response('bad room id', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(request.headers.get('Origin') || '')) {
      return new Response('origin not allowed', { status: 403 });
    }
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(request);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Keepalives are answered by the runtime while the object stays hibernated.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  ttlMs() {
    const hours = Number(this.env.ROOM_TTL_HOURS);
    return (hours > 0 ? hours : 24) * 3600e3;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const create = url.searchParams.get('create') === '1';
    const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    let meta = await this.ctx.storage.get('meta');
    if (!meta && !create) {
      // Accept, explain, close: a failed handshake carries no reason to the page.
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ t: 'gone' }));
      server.close(4404, 'no such room');
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!meta) meta = { created: Date.now(), last: Date.now(), seq: 0, snapN: 0, bytes: 0, clients: 0 };

    const cid = ++meta.clients;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ c: cid });
    const peers = this.sockets().filter(w => w !== server).map(w => this.cidOf(w)).filter(Boolean);
    server.send(JSON.stringify({ t: 'hi', c: cid, peers, n: meta.seq }));

    // Replay: the snapshot (if the client predates it), then the updates after
    // whichever is newer — the snapshot or what the client already has.
    let from = since;
    const snap = await this.ctx.storage.get('snap');
    if (snap && since < snap.n) {
      server.send(JSON.stringify({ t: 's', d: snap.d, n: snap.n }));
      from = snap.n;
    }
    const updates = await this.ctx.storage.list({ prefix: 'u:', start: updateKey(from + 1) });
    for (const [key, d] of updates) server.send(JSON.stringify({ t: 'u', d, n: seqOf(key) }));
    server.send(JSON.stringify({ t: 'sync', n: meta.seq, count: meta.seq - meta.snapN }));

    this.broadcast({ t: 'join', c: cid }, server);
    await this.touch(meta);
    return new Response(null, { status: 101, webSocket: client });
  }

  sockets() { return this.ctx.getWebSockets(); }

  cidOf(ws) {
    try { return (ws.deserializeAttachment() || {}).c || 0; } catch (_) { return 0; }
  }

  broadcast(msg, except) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets()) {
      if (ws === except) continue;
      try { ws.send(text); } catch (_) { /* closing socket — its close handler cleans up */ }
    }
  }

  async touch(meta) {
    meta.last = Date.now();
    await this.ctx.storage.put('meta', meta);
    await this.ctx.storage.setAlarm(meta.last + this.ttlMs());
  }

  async endRoom(reason) {
    this.broadcast({ t: 'end', r: reason || 'ended' });
    for (const ws of this.sockets()) {
      try { ws.close(1000, 'room ended'); } catch (_) {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    const meta = await this.ctx.storage.get('meta');
    if (!meta) return;
    if (Date.now() >= meta.last + this.ttlMs()) await this.endRoom('expired');
    else await this.ctx.storage.setAlarm(meta.last + this.ttlMs());
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    if (message === 'ping') { ws.send('pong'); return; }  // when auto-response didn't catch it
    if (message.length > MAX_MESSAGE) { this.refuse(ws, 'message too large'); return; }
    let m;
    try { m = JSON.parse(message); } catch (_) { this.refuse(ws, 'bad json'); return; }
    if (!m || typeof m !== 'object') { this.refuse(ws, 'bad message'); return; }

    if (m.t === 'p') {
      if (typeof m.d !== 'string') return;
      this.broadcast({ t: 'p', c: this.cidOf(ws), d: m.d }, ws);
      return;
    }

    const meta = await this.ctx.storage.get('meta');
    if (!meta) {
      ws.send(JSON.stringify({ t: 'gone' }));
      try { ws.close(4404, 'no such room'); } catch (_) {}
      return;
    }

    if (m.t === 'u') {
      if (typeof m.d !== 'string' || !m.d) { this.refuse(ws, 'bad update'); return; }
      if (meta.bytes + m.d.length > MAX_ROOM_BYTES) { this.refuse(ws, 'room is full'); return; }
      const n = ++meta.seq;
      meta.bytes += m.d.length;
      await this.ctx.storage.put(updateKey(n), m.d);
      await this.touch(meta);
      ws.send(JSON.stringify({ t: 'ack', n }));
      this.broadcast({ t: 'u', d: m.d, n }, ws);
      return;
    }

    if (m.t === 's') {
      const n = m.n | 0;
      if (typeof m.d !== 'string' || !m.d || n > meta.seq) {
        this.refuse(ws, 'snapshot out of range');
        return;
      }
      // Every client past SNAPSHOT_AFTER offers a snapshot; only the first one
      // wins. The rest raced, they didn't err — ack and drop.
      if (n <= meta.snapN) {
        ws.send(JSON.stringify({ t: 'ack', n: meta.snapN }));
        return;
      }
      // A snapshot stands in for every update up to n: drop those and account
      // the bytes that remain.
      const stale = await this.ctx.storage.list({ prefix: 'u:', start: updateKey(meta.snapN + 1), end: updateKey(n + 1) });
      if (stale.size) await this.ctx.storage.delete([...stale.keys()]);
      await this.ctx.storage.put('snap', { d: m.d, n });
      const rest = await this.ctx.storage.list({ prefix: 'u:' });
      let bytes = m.d.length;
      for (const d of rest.values()) bytes += d.length;
      meta.snapN = n;
      meta.bytes = bytes;
      await this.touch(meta);
      ws.send(JSON.stringify({ t: 'ack', n }));
      return;
    }

    if (m.t === 'end') {
      await this.endRoom();
      return;
    }

    this.refuse(ws, 'unknown message');
  }

  refuse(ws, why) {
    try { ws.send(JSON.stringify({ t: 'err', m: why })); } catch (_) {}
  }

  async webSocketClose(ws) {
    const c = this.cidOf(ws);
    if (c) this.broadcast({ t: 'leave', c }, ws);
  }

  async webSocketError(ws) {
    const c = this.cidOf(ws);
    if (c) this.broadcast({ t: 'leave', c }, ws);
  }
}
