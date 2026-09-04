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
