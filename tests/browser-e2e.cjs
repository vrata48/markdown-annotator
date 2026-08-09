const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '..');
const dependenciesRoot = path.resolve(process.env.E2E_DEPS_DIR || path.join(root, 'node_modules'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html';
  const dependencyRequest = rel.startsWith('__deps/');
  const base = dependencyRequest ? dependenciesRoot : root;
  const target = path.resolve(base, dependencyRequest ? rel.slice('__deps/'.length) : rel);
  if (!target.startsWith(base + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  if (rel === 'index.html') {
    const html = fs.readFileSync(target, 'utf8')
      .replace(/<link rel="stylesheet" id="hljs-light"[\s\S]*?crossorigin="anonymous">\s*/, '<link rel="stylesheet" id="hljs-light" href="/tests/empty.css">\n')
      .replace(/<link rel="stylesheet" id="hljs-dark"[\s\S]*?crossorigin="anonymous">\s*/, '<link rel="stylesheet" id="hljs-dark" disabled href="/tests/empty.css">\n')
      .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/highlight\.js[\s\S]*?<\/script>\s*/, '')
      .replace('https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js', '/__deps/markdown-it/dist/markdown-it.min.js');
    res.writeHead(200, { 'Content-Type': types['.html'] }).end(html);
    return;
  }
  if (rel === 'mermaid-init.js') {
    const script = fs.readFileSync(target, 'utf8')
      .replace('https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs', '/__deps/mermaid/dist/mermaid.esm.min.mjs');
    res.writeHead(200, { 'Content-Type': types['.js'] }).end(script);
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
});

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
    executablePath: process.env.E2E_BROWSER_PATH || (process.platform === 'win32'
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : undefined),
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
    assert(await page.locator('#annotation-nav.visible').count() === 1, 'sample did not expose annotation navigator');
    assert((await page.locator('#ann-nav-count').textContent()).endsWith('of 2'), 'sample annotation count is wrong');

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

    const patResult = await page.evaluate(() => {
      glSaveConfig('https://gitlab.example.test', 'test-secret', false);
      return {
        token: glTokenFor('https://gitlab.example.test'),
        stored: JSON.parse(localStorage.getItem('gitlab-tokens') || '{}')['https://gitlab.example.test'],
      };
    });
    assert(patResult.token === 'test-secret' && !patResult.stored, 'default PAT handling persisted the token');
    const crossInstanceToken = await page.evaluate(() => {
      showGitLabDialog();
      const url = document.querySelector('#gl-url');
      url.value = 'https://another-gitlab.example/group/repo/-/blob/main/README.md';
      url.dispatchEvent(new Event('input', { bubbles: true }));
      const value = document.querySelector('#gl-token').value;
      hideGitLabDialog();
      return value;
    });
    assert(crossInstanceToken === '', 'switching GitLab instances reused another instance token');

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
    console.log('Browser E2E: sample, navigator, keyboard annotation controls, PAT privacy, physical selection/save, and Mermaid passed.');
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
