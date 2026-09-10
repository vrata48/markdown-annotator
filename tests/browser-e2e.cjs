const { chromium } = require('playwright-core');
const { createStaticServer, browserExecutable } = require('./lib/static-server.cjs');

const server = createStaticServer();

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

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    executablePath: browserExecutable(),
    headless: true,
    args: ['--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => typeof markdownit === 'function' && typeof window.AnnotatorCore === 'object' && typeof window.AnnotatorAppHelpers === 'object');

    await page.locator('#btn-sample').click();
    await page.locator('body.file-open').waitFor();
    assert(await page.locator('#rail-ann:not([hidden])').count() === 1, 'sample did not expose annotation navigator');
    assert((await page.locator('#ann-nav-count').textContent()).endsWith('/ 2'), 'sample annotation count is wrong');
    const sampleBrief = await page.evaluate(() => ({
      source: state.rawMarkdown.includes('<!-- markdown-annotator:review:start -->'),
      rendered: document.querySelector('#content').textContent.includes('Annotation review brief'),
    }));
    assert(sampleBrief.source && !sampleBrief.rendered, 'source review brief was missing or duplicated in the app view');

    await page.locator('#btn-raw-toggle').click();
    const rawMode = await page.evaluate(() => ({
      mode: state.mode,
      exact: document.querySelector('#raw-source').textContent === state.rawMarkdown,
      hasBrief: document.querySelector('#raw-source').textContent.includes('Annotation review brief'),
      renderedHidden: getComputedStyle(document.querySelector('#content')).display === 'none',
    }));
    assert(rawMode.mode === 'raw' && rawMode.exact && rawMode.hasBrief && rawMode.renderedHidden, 'raw source mode is incomplete');
    await page.keyboard.press('Control+Shift+E');
    assert(await page.evaluate(() => state.mode === 'annotate'), 'raw source toggle did not return to annotate mode');

    const comment = page.locator('.ann-wrap:not(.ann-edit)').first();
    await comment.focus();
    await comment.press('Enter');
    await page.locator('#edit-popup.visible').waitFor();
    await page.locator('#btn-edit-cancel').click();

    const suggestion = page.locator('.ann-edit').first();
    assert(await suggestion.locator('.ann-change-arrow').count() === 1, 'substitution lacks a visual separator');
    await suggestion.locator('.ann-accept').focus();
    await suggestion.locator('.ann-accept').press('Enter');
    assert(await page.evaluate(() => state.rawMarkdown.includes('run a small public beta first')), 'keyboard accept did not apply suggestion');

    const sampleSaved = await page.evaluate(async () => {
      const opfs = await navigator.storage.getDirectory();
      const handle = await opfs.getFileHandle('sample-e2e.md', { create: true });
      window.showSaveFilePicker = async () => handle;
      await saveFile();
      return {
        sample: state.sample,
        content: await (await handle.getFile()).text(),
      };
    });
    assert(!sampleSaved.sample && sampleSaved.content.includes('run a small public beta first'), 'sample did not save as a new local file');

    await page.evaluate(async () => {
      const opfs = await navigator.storage.getDirectory();
      const handle = await opfs.getFileHandle('browser-e2e.md', { create: true });
      const writable = await handle.createWritable();
      await writable.write('# Browser fixture\n\nThe quick brown fox jumps over the lazy dog.');
      await writable.close();
      window.__e2eHandle = handle;
      await openHandle(handle);
    });
    await selectText(page, 'fox');
    await page.locator('#annotation-popup.visible').waitFor();
    await page.locator('#annotation-input').fill('Check animal');
    await page.locator('#btn-ann-save').click();
    await page.evaluate(() => saveFile());
    const saved = await page.evaluate(async () => (await window.__e2eHandle.getFile()).text());
    assert(saved.includes('{== fox ==}{>> Check animal <<}'), 'physical selection/save did not persist CriticMarkup');
    assert(saved.startsWith('<!-- markdown-annotator:review:start -->') && saved.includes('Check animal'), 'saved file lacks the AI review brief');

    // Reply outside a session: the reply box asks for a name (remembered for
    // next time), the reply lands as its own "@Name:" line, and the card and
    // navigator show the thread.
    const foxWrap = page.locator('.ann-wrap[data-ann-group]').first();
    await foxWrap.hover();
    await foxWrap.locator('.ann-reply').click();
    await page.locator('#edit-popup.visible').waitFor();
    assert(await page.locator('#edit-name-row').isVisible() && (await page.locator('#btn-edit-save').textContent()) === 'Reply', 'reply mode did not show the name field');
    await page.locator('#edit-name').fill('Vrata');
    await page.locator('#edit-input').fill('It is a fox.');
    await page.locator('#btn-edit-save').click();
    assert(await page.evaluate(() => state.rawMarkdown.includes('{== fox ==}{>> Check animal\n@Vrata: It is a fox. <<}') && localStorage.getItem('share-name') === 'Vrata'),
      'offline reply was not appended as a signed line');
    const thread = await page.evaluate(() => ({
      authors: [...document.querySelectorAll('.ann-thread .ann-msg-author')].map(el => el.textContent),
      texts: [...document.querySelectorAll('.ann-thread .ann-msg-text')].map(el => el.textContent),
      nav: [...document.querySelectorAll('#ann-nav-list button')].map(b => b.textContent),
    }));
    assert(thread.authors.join() === 'Vrata' && thread.texts.join('|') === 'Check animal|It is a fox.' && thread.nav.join() === '1Check animal+1',
      'thread rendering is off: ' + JSON.stringify(thread));
    await page.keyboard.press('Control+z');
    assert(await page.evaluate(() => state.rawMarkdown.includes('{== fox ==}{>> Check animal <<}')), 'undo did not remove the reply');
    await page.evaluate(() => saveFile());

    await page.evaluate(() => {
      state.rawMarkdown += '\n\nUnsaved line.';
      markDirty();
      window.__closePromise = closeFile();
    });
    const confirmDialog = page.locator('#message-dialog.visible');
    await confirmDialog.waitFor();
    assert(await confirmDialog.getAttribute('role') === 'alertdialog', 'confirmation dialog lacks an accessible role');
    await page.locator('#message-cancel').click();
    assert(await page.evaluate(() => state.fileOpen && state.dirty), 'cancelling the close dialog discarded the document');

    // A comment in a table's first row: the card must not be clipped by the
    // table's scrolling wrapper (its text sits above the row).
    await page.evaluate(() => {
      state.rawMarkdown = '# Heading\n\n| Task | Owner |\n| --- | --- |\n| {== `DDE Tests` ==}{>> @Alex: It is important to communicate the farm type. <<} | Alex |\n| second | Bob |';
      state.dirty = false;
      clearUndo();
      render();
    });
    await page.locator('.table-wrap .ann-wrap').first().hover();
    const cardHit = await page.evaluate(() => {
      // A signed comment renders as a thread entry: author above the text.
      const text = document.querySelector('.table-wrap .ann-msg-text');
      const r = text.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { visible: !!hit && text.contains(hit) || hit === text, text: text.textContent,
        author: document.querySelector('.table-wrap .ann-msg-author').textContent };
    });
    assert(cardHit.visible && cardHit.author === 'Alex' && cardHit.text.startsWith('It is important'), 'comment card in a table is clipped: ' + JSON.stringify(cardHit));
    await page.mouse.move(5, 5);
    assert(await page.evaluate(() => getComputedStyle(document.querySelector('.table-wrap .ann-badge-card')).display === 'none'), 'table card stayed open after the pointer left');

    // A tall thread card on the first line of the view opens below its marker
    // instead of being clipped above the view's top edge; once the line is
    // scrolled to the middle, the card opens above again.
    await page.evaluate(() => {
      const thread = ['@Ann: first message', '@Bob: second message', '@Ann: third message', '@Bob: fourth message'].join('\n');
      state.rawMarkdown = 'Filler paragraph.\n\n'.repeat(40) + '{== Top ==}{>> ' + thread + ' <<} line of a long document.\n\n' + 'Filler paragraph.\n\n'.repeat(80) + 'Bottom.';
      state.dirty = false;
      clearUndo();
      render();
      // Scroll the annotated line to the very top of the view: no room above.
      document.querySelector('.ann-wrap[data-ann-group]').scrollIntoView({ block: 'start' });
    });
    const topWrap = page.locator('.ann-wrap[data-ann-group]').first();
    await topWrap.hover();
    const topCard = await page.evaluate(() => {
      const wrap = document.querySelector('.ann-wrap[data-ann-group]');
      const card = wrap.querySelector('.ann-badge-card').getBoundingClientRect();
      const view = document.querySelector('#rendered-view').getBoundingClientRect();
      const badge = wrap.querySelector('.ann-comment-badge').getBoundingClientRect();
      return { below: wrap.classList.contains('ann-card-below'), inView: card.top >= view.top, underBadge: card.top >= badge.bottom };
    });
    assert(topCard.below && topCard.inView && topCard.underBadge, 'card at the top of the view was not flipped below: ' + JSON.stringify(topCard));
    await page.mouse.move(5, 5);
    await page.evaluate(() => { document.querySelector('.ann-wrap[data-ann-group]').scrollIntoView({ block: 'center' }); });
    await topWrap.hover();
    assert(await page.evaluate(() => {
      const wrap = document.querySelector('.ann-wrap[data-ann-group]');
      return !wrap.classList.contains('ann-card-below') && wrap.querySelector('.ann-badge-card').getBoundingClientRect().bottom <= wrap.querySelector('.ann-comment-badge').getBoundingClientRect().top;
    }), 'card did not open above once there was room');
    await page.mouse.move(5, 5);

    await page.evaluate(() => {
      state.rawMarkdown = '```mermaid\nflowchart LR\n  A --> B\n```';
      state.dirty = false;
      clearUndo();
      render();
    });
    await page.locator('.mermaid svg').waitFor({ timeout: 15000 });
    await page.locator('.mermaid').click();
    await page.locator('#annotation-popup.visible').waitFor();

    assert(pageErrors.length === 0, 'page errors: ' + pageErrors.join('; '));
    console.log('Browser E2E: sample, navigator, raw source, keyboard annotation controls, PAT privacy, physical selection/save, and Mermaid passed.');
  } finally {
    await page.evaluate(async () => {
      try {
        const opfs = await navigator.storage.getDirectory();
        await opfs.removeEntry('browser-e2e.md');
        await opfs.removeEntry('sample-e2e.md');
      } catch (_) {}
      await new Promise(resolve => {
        const req = indexedDB.deleteDatabase('md-annotator');
        req.onsuccess = req.onerror = req.onblocked = resolve;
      });
    }).catch(() => {});
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
