/* Static server for the browser tests: serves the repo, and swaps the CDN
 * dependencies for local copies under node_modules (E2E_DEPS_DIR overrides)
 * so the tests run without network access. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const dependenciesRoot = path.resolve(process.env.E2E_DEPS_DIR || path.join(root, 'node_modules'));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function createStaticServer() {
  return http.createServer((req, res) => {
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
    if (rel === 'collab.js') {
      const script = fs.readFileSync(target, 'utf8')
        .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/yjs@[\d.]+\/\+esm/, '/__deps/yjs/dist/yjs.mjs');
      res.writeHead(200, { 'Content-Type': types['.js'] }).end(script);
      return;
    }
    if (dependencyRequest && /\.m?js$/.test(rel)) {
      // yjs and lib0 import each other by bare specifier; there is no bundler
      // here, so point those at the served copies.
      const script = fs.readFileSync(target, 'utf8')
        .replace(/from '(lib0\/[\w./-]+)'/g, (m, spec) => `from '/__deps/${spec}${/\.js$/.test(spec) ? '' : '.js'}'`);
      res.writeHead(200, { 'Content-Type': types['.js'] }).end(script);
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  });
}

// Prefer Playwright's own Chromium (what CI runs) when it is installed
// locally; fall back to the system Edge on Windows. The installed Chrome/Edge
// 153 builds kill the whole browser process when an OPFS file handle is read
// back from IndexedDB (2026-09-14), which every recents write does.
function browserExecutable() {
  if (process.env.E2E_BROWSER_PATH) return process.env.E2E_BROWSER_PATH;
  const fs = require('node:fs');
  const path = require('node:path');
  const home = process.env.LOCALAPPDATA || process.env.HOME || '';
  const root = path.join(home, process.platform === 'win32' ? 'ms-playwright' : '.cache/ms-playwright');
  try {
    const dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const d of dirs) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* no Playwright browsers installed */ }
  return process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : undefined;
}

module.exports = { createStaticServer, browserExecutable };
