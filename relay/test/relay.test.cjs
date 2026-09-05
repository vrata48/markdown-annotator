/* Protocol test for the relay, against a local `wrangler dev` instance.
 * Run: node --test relay/test/relay.test.cjs   (first run downloads wrangler) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRelay } = require('./dev-relay.cjs');

function roomId() {
  return 'test-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// A tiny client: every JSON frame lands in a queue; next(pred) resolves with the
// first queued (or future) frame that satisfies pred.
function connect(base, room, query) {
  const ws = new WebSocket(`${base}/room/${room}${query || ''}`);
  const queue = [];
  const waiters = [];
  const closed = new Promise(resolve => ws.addEventListener('close', ev => resolve(ev.code)));
  ws.addEventListener('message', ev => {
    if (typeof ev.data !== 'string' || ev.data === 'pong') return;
    const msg = JSON.parse(ev.data);
    const i = waiters.findIndex(w => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('socket error')));
  });
  return {
    ws, closed, opened,
    send(obj) { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); },
    next(pred, ms) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a frame; queued: ' + JSON.stringify(queue))), ms || 5000);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    async none(ms) {  // asserts nothing arrives for a while
      await new Promise(r => setTimeout(r, ms || 300));
      assert.deepEqual(queue, [], 'unexpected frames: ' + JSON.stringify(queue));
    },
    close() { ws.close(); return closed; },
  };
}

const is = (t) => (m) => m.t === t;

test('relay: rooms, replay, snapshots, presence and ending', { timeout: 240000 }, async (t) => {
  const relay = await startRelay();
  t.after(() => relay.stop());
  const base = relay.url;
  const room = roomId();

  await t.test('joining a room that does not exist says gone', async () => {
    const c = connect(base, room);
    await c.opened;
    await c.next(is('gone'));
    assert.equal(await c.closed, 4404);
  });

  const a = connect(base, room, '?create=1');
  await a.opened;
  const aHi = await a.next(is('hi'));
  assert.deepEqual(aHi.peers, []);
  assert.equal(aHi.n, 0);
  assert.equal((await a.next(is('sync'))).n, 0);

  await t.test('an update is acked and replayed to a later joiner', async () => {
    a.send({ t: 'u', d: 'U1' });
    assert.equal((await a.next(is('ack'))).n, 1);

    const b = connect(base, room);
    await b.opened;
    const hi = await b.next(is('hi'));
    assert.deepEqual(hi.peers, [aHi.c]);
    const u = await b.next(is('u'));
    assert.deepEqual([u.d, u.n], ['U1', 1]);
    const sync = await b.next(is('sync'));
    assert.deepEqual([sync.n, sync.count], [1, 1]);
    assert.equal((await a.next(is('join'))).c, hi.c);

    b.send({ t: 'u', d: 'U2' });
    assert.equal((await b.next(is('ack'))).n, 2);
    const live = await a.next(is('u'));
    assert.deepEqual([live.d, live.n], ['U2', 2]);
    await b.none();  // a sender never gets its own update back

    b.send({ t: 'p', d: 'PRES' });
    const p = await a.next(is('p'));
    assert.deepEqual([p.c, p.d], [hi.c, 'PRES']);

    await b.close();
    assert.equal((await a.next(is('leave'))).c, hi.c);
  });

  await t.test('since skips what the client already holds', async () => {
    const c = connect(base, room, '?since=2');
    await c.opened;
    await c.next(is('hi'));
    const sync = await c.next(is('sync'));
    assert.equal(sync.n, 2);
    await c.none();
    await c.close();
    await a.next(is('leave'));
  });

  await t.test('a snapshot replaces the updates it covers', async () => {
    a.send({ t: 's', d: 'SNAP', n: 5 });
    assert.equal((await a.next(is('err'))).m, 'snapshot out of range');
    a.send({ t: 's', d: 'SNAP', n: 2 });
    assert.equal((await a.next(is('ack'))).n, 2);
    // A second client racing to compact the same range is acked, not refused.
    a.send({ t: 's', d: 'SNAP-LATE', n: 2 });
    const late = await a.next(m => m.t === 'ack' || m.t === 'err');
    assert.deepEqual([late.t, late.n], ['ack', 2]);
    a.send({ t: 'u', d: 'U3' });
    assert.equal((await a.next(is('ack'))).n, 3);

    const d = connect(base, room);
    await d.opened;
    await d.next(is('hi'));
    const s = await d.next(is('s'));
    assert.deepEqual([s.d, s.n], ['SNAP', 2]);
    const u = await d.next(is('u'));
    assert.deepEqual([u.d, u.n], ['U3', 3]);
    const sync = await d.next(is('sync'));
    assert.deepEqual([sync.n, sync.count], [3, 1]);
    await d.close();
    await a.next(is('leave'));

    // A client at seq 2 needs only the update after the snapshot.
    const e = connect(base, room, '?since=2');
    await e.opened;
    await e.next(is('hi'));
    assert.equal((await e.next(is('u'))).n, 3);
    await e.next(is('sync'));
    await e.none();
    await e.close();
    await a.next(is('leave'));
  });

  await t.test('bad frames are refused without dropping the socket', async () => {
    a.send('not json');
    assert.equal((await a.next(is('err'))).m, 'bad json');
    a.send({ t: 'nope' });
    assert.equal((await a.next(is('err'))).m, 'unknown message');
    a.send('ping');  // answered by the runtime, filtered by the client
    a.send({ t: 'u', d: 'U4' });
    assert.equal((await a.next(is('ack'))).n, 4);
  });

  await t.test('ending a room closes everyone and forgets it', async () => {
    const f = connect(base, room);
    await f.opened;
    await f.next(is('sync'));
    await a.next(is('join'));
    a.send({ t: 'end' });
    assert.equal((await a.next(is('end'))).r, 'ended');
    assert.equal((await f.next(is('end'))).r, 'ended');
    assert.equal(await a.closed, 1000);
    assert.equal(await f.closed, 1000);

    const g = connect(base, room);
    await g.opened;
    await g.next(is('gone'));
    await g.closed;
  });
});

test('relay: an idle room expires after its TTL', { timeout: 240000 }, async (t) => {
  const relay = await startRelay({ vars: { ROOM_TTL_HOURS: '0.0005' } });  // 1.8 seconds
  t.after(() => relay.stop());
  const room = roomId();
  const a = connect(relay.url, room, '?create=1');
  await a.opened;
  await a.next(is('sync'));
  a.send({ t: 'u', d: 'U1' });
  await a.next(is('ack'));
  assert.equal((await a.next(is('end'), 15000)).r, 'expired');
  await a.closed;

  const b = connect(relay.url, room);
  await b.opened;
  await b.next(is('gone'));
  await b.closed;
});
