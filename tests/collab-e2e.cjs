/* Shared sessions, end to end: two isolated browser contexts (host + guest)
 * against a local `wrangler dev` relay. Run: node tests/collab-e2e.cjs
 * Needs the same local deps as browser-e2e.cjs plus yjs (see ci.yml). */
const { chromium } = require('playwright-core');
const { createStaticServer, browserExecutable } = require('./lib/static-server.cjs');
const { startRelay } = require('../relay/test/dev-relay.cjs');

function assert(condition, message) { if (!condition) throw new Error(message); }

async function selectText(page, needle) {
  const rect = await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.querySelector('#content'), NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      return range.getBoundingClientRect().toJSON();
    }
    throw new Error('Visible text not found: ' + text);
  }, needle);
  await page.mouse.move(rect.left + 1, rect.top + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.right - 1, rect.top + rect.height / 2, { steps: 8 });
  await page.mouse.up();
}

// Select a passage and file a comment on it, without waiting for it to land.
async function comment(page, needle, text) {
  await selectText(page, needle);
  await page.locator('#annotation-popup.visible').waitFor();
  await page.locator('#annotation-input').fill(text);
  await page.locator('#btn-ann-save').click();
}

const hasText = (page, needle) =>
  page.waitForFunction((t) => state.rawMarkdown.includes(t), needle, { timeout: 20000 });
const lacksText = (page, needle) =>
  page.waitForFunction((t) => !state.rawMarkdown.includes(t), needle, { timeout: 20000 });

const FIXTURE = '# Shared fixture\n\nThe quick brown fox jumps over the lazy dog.\n\nA second paragraph to comment on.\n';

(async () => {
  const server = createStaticServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const relay = await startRelay();
  const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, args: ['--disable-gpu'] });
  const errors = [];
  const newPage = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await ctx.addInitScript(({ relayUrl, name }) => {
      localStorage.setItem('relay-url', relayUrl);
      localStorage.setItem('share-name', name);
    }, { relayUrl: relay.url, name });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(name + ': ' + e.message));
    return page;
  };
  const ready = (page) => page.waitForFunction(() => typeof markdownit === 'function' && typeof window.AnnotatorCore === 'object' && typeof window.Collab === 'object');

  const host = await newPage('Ada');
  const guest = await newPage('Bob');
  try {
    // ── Host opens a local file and starts sharing ──
    await host.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await ready(host);
    await host.evaluate(async (fixture) => {
      const opfs = await navigator.storage.getDirectory();
      const handle = await opfs.getFileHandle('collab-host.md', { create: true });
      const w = await handle.createWritable();
      await w.write(fixture);
      await w.close();
      await openHandle(handle);
    }, FIXTURE);
    await host.locator('body.file-open').waitFor();
    await host.locator('#btn-share').click();
    await host.locator('#share-dialog.visible').waitFor();
    assert(await host.locator('#share-name').inputValue() === 'Ada', 'name dialog was not prefilled');
    await host.locator('#share-ok').click();
    await host.locator('body.sharing').waitFor();
    await host.waitForFunction(() => Collab.session() && Collab.session().status === 'connected' && Collab.session().synced, null, { timeout: 30000 });
    const link = await host.locator('#share-link').inputValue();
    assert(link.startsWith(base + '#share=') && new URL(link).hash.split('.').length === 2, 'share link is malformed: ' + link);
    assert(await host.evaluate(() => Collab.host && $('#btn-share-stop').hidden === false), 'host controls missing');
    assert(await host.evaluate(() => !$('#btn-autosave').disabled && $('#btn-refresh').disabled && $('#btn-autoreload').disabled), 'reload controls still live, or auto-save unavailable, while sharing');

    // ── Guest joins by link ──
    await guest.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await ready(guest);
    await guest.locator('#share-dialog.visible').waitFor();
    assert((await guest.locator('#share-ok').textContent()) === 'Join', 'guest dialog is not the join variant');
    await guest.locator('#share-ok').click();
    await guest.locator('body.file-open.sharing').waitFor({ timeout: 30000 });
    const joined = await guest.evaluate(() => ({ text: state.rawMarkdown, name: state.fileName, handle: state.fileHandle, host: Collab.host, dirty: state.dirty }));
    assert(joined.text.includes('quick brown fox') && joined.name === 'collab-host.md' && joined.handle === null && !joined.host && !joined.dirty,
      'guest did not adopt the shared document: ' + JSON.stringify({ name: joined.name, host: joined.host, dirty: joined.dirty }));
    await host.waitForFunction(() => $('#share-label').textContent === 'Sharing · 2', null, { timeout: 20000 });
    await host.waitForFunction(() => [...document.querySelectorAll('#share-peers .share-peer')].some(el => el.textContent === 'Bob'), null, { timeout: 20000 });

    // ── Comments flow both ways, signed by their authors ──
    await comment(guest, 'fox', 'Check animal');
    await hasText(guest, '{== fox ==}{>> @Bob: Check animal <<}');
    await hasText(host, '@Bob: Check animal');
    assert(await host.evaluate(() => state.dirty), 'host disk copy was not marked behind the session');
    await comment(host, 'lazy', 'Slow');
    await hasText(guest, '{== lazy ==}{>> @Ada: Slow <<}');
    assert(await guest.evaluate(() => document.querySelector('#content').textContent.includes('Annotation review brief') === false
      && state.rawMarkdown.startsWith('<!-- markdown-annotator:review:start -->')), 'guest brief is missing or rendered');

    // ── Auto-save keeps the host's file in step with the session ──
    const onDisk = (page) => page.evaluate(async () => (await (await state.fileHandle.getFile()).text()));
    assert(!(await onDisk(host)).includes('@Ada: Slow'), 'file was written before auto-save was turned on');
    await host.locator('#btn-autosave').click();
    assert(await host.evaluate(() => !$('#btn-autosave').disabled && $('#btn-autosave').classList.contains('on')), 'auto-save toggle is unavailable while sharing');
    await host.waitForFunction(async () => (await (await state.fileHandle.getFile()).text()).includes('@Ada: Slow') && !state.dirty, null, { timeout: 15000 });
    await comment(guest, 'over', 'Auto');
    await host.waitForFunction(async () => (await (await state.fileHandle.getFile()).text()).includes('@Bob: Auto') && !state.dirty, null, { timeout: 15000 });
    assert(await host.evaluate(() => $('#btn-refresh').disabled && $('#btn-autoreload').disabled), 'reload controls came back while sharing');

    // ── Concurrent comments both survive ──
    await Promise.all([comment(host, 'quick', 'From Ada'), comment(guest, 'second', 'From Bob')]);
    await hasText(host, '@Bob: From Bob');
    await hasText(guest, '@Ada: From Ada');
    const same = await Promise.all([host, guest].map(p => p.evaluate(() => state.rawMarkdown)));
    assert(same[0] === same[1], 'host and guest diverged after concurrent comments');
    const afterConcurrent = await host.evaluate(() => AnnotatorCore.scanAnnotations(state.rawMarkdown).map(it => it.kind + ':' + (it.comment || it.text)));
    assert(afterConcurrent.length === 5, 'expected five annotations after concurrent comments, got ' + JSON.stringify(afterConcurrent));

    // ── Undo is per user: Bob's Ctrl+Z removes Bob's last comment only ──
    await guest.keyboard.press('Control+z');
    await lacksText(guest, 'From Bob');
    await lacksText(host, 'From Bob');
    assert(await host.evaluate(() => state.rawMarkdown.includes('From Ada') && state.rawMarkdown.includes('@Ada: Slow')), 'undo removed someone else\'s comment');

    // ── An open comment box survives a remote change before it ──
    await selectText(guest, 'jumps');
    await guest.locator('#annotation-popup.visible').waitFor();
    await comment(host, 'brown', 'Colour');
    await hasText(guest, '@Ada: Colour');
    assert(await guest.locator('#annotation-popup.visible').count() === 1, 'remote change closed the guest\'s comment box');
    await guest.locator('#annotation-input').fill('Still here');
    await guest.locator('#btn-ann-save').click();
    await hasText(host, '{== jumps ==}{>> @Bob: Still here <<}');
    assert(await host.evaluate(() => AnnotatorCore.scanAnnotations(state.rawMarkdown).length === 6
      && AnnotatorCore.stripAll(state.rawMarkdown).includes('The quick brown fox jumps over the lazy dog.')), 'document corrupted by a rebased comment');

    // ── Saving: host writes the session to its file; guest saves a copy ──
    await host.evaluate(() => saveFile());
    const hostSaved = await host.evaluate(async () => (await state.fileHandle.getFile()).text());
    assert(hostSaved.includes('@Bob: Still here') && hostSaved.includes('@Ada: Colour'), 'host save lacks the session\'s comments');
    const guestSaved = await guest.evaluate(async () => {
      const opfs = await navigator.storage.getDirectory();
      const handle = await opfs.getFileHandle('collab-guest.md', { create: true });
      window.showSaveFilePicker = async () => handle;
      await saveFile();
      return { text: await (await handle.getFile()).text(), still: Collab.active };
    });
    assert(guestSaved.text === hostSaved && guestSaved.still, 'guest "save as" did not write the shared document');

    // ── Host refresh: rejoins silently and gets its file back as save target ──
    await host.reload({ waitUntil: 'domcontentloaded' });
    await ready(host);
    assert(await host.evaluate(() => document.body.classList.contains('joining') && getComputedStyle($('#welcome')).visibility === 'hidden'),
      'refresh flashed the welcome screen instead of a connecting state');
    await host.locator('body.file-open.sharing').waitFor({ timeout: 30000 });
    assert(await host.locator('#share-dialog.visible').count() === 0, 'refresh asked for the name again');
    assert(await host.evaluate(() => !document.body.classList.contains('joining')), 'connecting state stuck after joining');
    await host.waitForFunction(() => Collab.host && state.fileHandle && state.fileName === 'collab-host.md', null, { timeout: 20000 });
    assert(await host.evaluate(() => state.rawMarkdown.includes('@Bob: Still here') && !state.dirty), 'host refresh lost the session state or misreported dirty');
    await comment(guest, 'paragraph', 'After refresh');
    await hasText(host, '@Bob: After refresh');

    // ── Host stops sharing: guest keeps an editable copy ──
    await host.locator('#btn-share').click();
    await host.locator('#share-menu.visible').waitFor();
    await host.locator('#btn-share-stop').click();
    await host.locator('#message-dialog.visible').waitFor();
    await host.locator('#message-ok').click();
    await host.waitForFunction(() => !Collab.active && !document.body.classList.contains('sharing') && !location.hash);
    await guest.waitForFunction(() => getComputedStyle(document.querySelector('#share-banner')).display !== 'none', null, { timeout: 20000 });
    assert(await guest.evaluate(() => !Collab.active && state.fileOpen && state.rawMarkdown.includes('After refresh') && !location.hash), 'guest lost its copy when the session ended');
    await comment(guest, 'dog', 'Offline now');
    assert(await guest.evaluate(() => state.rawMarkdown.includes('{== dog ==}{>> Offline now <<}')), 'local editing after the session should not be author-tagged');

    // ── A dead link is refused politely ──
    const late = await newPage('Cy');
    await late.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await ready(late);
    await late.locator('#share-dialog.visible').waitFor();
    await late.locator('#share-ok').click();
    await late.locator('#message-dialog.visible').waitFor({ timeout: 30000 });
    assert((await late.locator('#message-text').textContent()).includes('ended'), 'dead link did not explain itself');
    assert(await late.evaluate(() => !state.fileOpen && !Collab.active && !Collab.joining), 'dead link left the app half-joined');
    await late.context().close();

    assert(errors.length === 0, 'page errors: ' + errors.join('; '));
    console.log('Collab E2E: share, join, live comments with authors, concurrency, per-user undo, open-box rebasing, saves, host refresh, stop, and dead links passed.');
  } finally {
    for (const page of [host, guest]) {
      await page.evaluate(async () => {
        try {
          const opfs = await navigator.storage.getDirectory();
          for (const name of ['collab-host.md', 'collab-guest.md']) { try { await opfs.removeEntry(name); } catch (_) {} }
        } catch (_) {}
        await new Promise(resolve => {
          const req = indexedDB.deleteDatabase('md-annotator');
          req.onsuccess = req.onerror = req.onblocked = resolve;
        });
      }).catch(() => {});
    }
    await browser.close();
    relay.stop();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
