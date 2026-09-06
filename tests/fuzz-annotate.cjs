/* Fuzz the annotate flow: random markdown, random visible phrases selected
 * and mapped to the source the way app.js does, classified by the core.
 *
 * Hard invariants (exit 1 on any failure): a supported annotation never
 * changes the rendered structure, always forms exactly one group, and
 * deleting it restores the original source byte for byte.
 * Informational: plain-prose selections that did not become one highlight
 * (printed with the first rendered difference) — the list to mine for the
 * next candidate rule in analyzeTarget.
 *
 * Run: node tests/fuzz-annotate.cjs [seed] [iterations] [samples]
 * Needs markdown-it in node_modules (see ci.yml). */
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const Core = require(path.join(root, 'annotator-core.js'));
const Helpers = require(path.join(root, 'app-helpers.js'));
const markdownit = require('markdown-it');
const md = markdownit({ html: false, linkify: true, typographer: true });
Core.configureMd(md);

let seed = Number(process.argv[2] || 1);
const ITER = Number(process.argv[3] || 2000);
function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

const WORDS = ['fix', 'version', 'release', 'clone', 'the', 'repo', 'and', 'run', 'it', 'now', 'Harness', 'Jira', 'ticket', 'API', 'user', 'data', 'note', 'first', 'second', 'later', 'default', 'value', 'config', 'file', 'path', 'C:\\temp', 'e.g.', 'i.e.', 'v2', 'x86_64', 'don\u2019t', 'naïve', 'über', 'čeština', 'žluťoučký', 'kůň', '日本語', '🙂', '12.26.10', '1.2', '10', '2026', '3rd', 'foo_bar', 'foo-bar', 'a/b', 'a\\b', '50%', '$5', '#tag', '@name', 'x=y', 'a+b', '(paren)', '[sq]', '<angle>', 'semi;', 'colon:', 'quote"d', "it's", 'em--dash', 'dots...', '(c)', '+-', 'http://example.com', 'www.example.org', 'user@example.com', 'C:\\Users\\x', '`tick`'];
const PUNCT = ['', '', '', ',', '.', ':', ';', '!', '?', ')', ']', '"', '\u201d', '...', ' -', ' --'];

function word() { return pick(WORDS); }
function plainRun(n) { const out = []; for (let i = 0; i < n; i++) out.push(word() + (chance(0.15) ? pick(PUNCT) : '')); return out.join(' '); }

function inline() {
  const r = rnd();
  const w = plainRun(1 + Math.floor(rnd() * 3));
  if (r < 0.10) return '**' + w + '**';
  if (r < 0.16) return '*' + w + '*';
  if (r < 0.20) return '_' + w + '_';
  if (r < 0.26) return '`' + w + '`';
  if (r < 0.32) return '[' + w + '](http://x.y/' + word() + ')';
  if (r < 0.34) return '<http://x.y/' + word() + '>';
  if (r < 0.37) return '~~' + w + '~~';
  if (r < 0.39) return '<br>';
  if (r < 0.41) return '<span>' + w + '</span>';
  if (r < 0.44) return '\\' + pick(['*', '_', '.', '#', '[', '`']) + w;
  if (r < 0.46) return '&nbsp;' + w;
  if (r < 0.48) return w + '\u00a0' + word();
  if (r < 0.51) return '{>> ' + plainRun(2) + ' <<}';
  if (r < 0.54) return '{== ' + w + ' ==}{>> ' + plainRun(2) + ' <<}';
  if (r < 0.56) return '{~~' + w + '~>' + plainRun(2) + '~~}';
  if (r < 0.57) return '{--' + w + '--}';
  if (r < 0.58) return '{++' + w + '++}';
  if (r < 0.60) return '![' + w + '](img.png)';
  if (r < 0.62) return '**' + w + '**' + pick(PUNCT) + plainRun(1);
  return plainRun(1 + Math.floor(rnd() * 6));
}

function line(nl) {
  const parts = [];
  const n = 1 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) parts.push(inline());
  let s = parts.join(chance(0.9) ? ' ' : '');
  if (chance(0.25)) s = s + '  ';               // hard break
  if (chance(0.15)) s = s.replace(/ /g, (m) => chance(0.15) ? nl : m);  // soft wraps
  return s;
}

function block(nl) {
  const r = rnd();
  if (r < 0.35) return line(nl) + (chance(0.3) ? nl + line(nl) : '');
  if (r < 0.45) return pick(['#', '##', '###']) + ' ' + plainRun(2 + Math.floor(rnd() * 4));
  if (r < 0.58) { const items = []; for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) items.push(pick(['-', '*', '+', '1.', '2)']) + ' ' + line(nl) + (chance(0.3) ? nl + '  ' + pick(['-', '*']) + ' ' + line(nl) : '') + (chance(0.2) ? nl + '  ' + line(nl) : '')); return items.join(nl); }
  if (r < 0.66) return '> ' + line(nl) + (chance(0.4) ? nl + '> ' + line(nl) : '') + (chance(0.2) ? nl + '>' + nl + '> ' + line(nl) : '');
  if (r < 0.76) { const cols = 2 + Math.floor(rnd() * 3); const row = () => '| ' + Array.from({ length: cols }, () => chance(0.8) ? plainRun(1 + Math.floor(rnd() * 3)) : inline()).join(' | ') + ' |'; return [row(), '| ' + Array.from({ length: cols }, () => pick(['---', ':--', '--:'])).join(' | ') + ' |', row(), row()].join(nl); }
  if (r < 0.84) return pick(['```', '~~~', '```js', '```mermaid']) + nl + plainRun(4) + nl + '{== not ==} {>> code <<}' + nl + '```';
  if (r < 0.88) return '    ' + plainRun(4);
  if (r < 0.91) return pick(['---', '***', '* * *']);
  if (r < 0.94) return plainRun(3) + nl + pick(['---', '===']);
  if (r < 0.97) return '<div>' + plainRun(3) + '</div>';
  return '[^1]: ' + plainRun(3);
}

function doc() {
  const nl = chance(0.2) ? '\r\n' : '\n';
  const blocks = [];
  if (chance(0.15)) blocks.push('---' + nl + 'title: ' + word() + nl + '---');
  for (let i = 0; i < 1 + Math.floor(rnd() * 6); i++) blocks.push(block(nl));
  let src = blocks.join(nl + nl) + (chance(0.5) ? nl : '');
  if (chance(0.5)) src = Core.syncReviewBrief(src);
  return src;
}

// Rendered text the way the browser would expose it to a selection.
function visibleText(html) {
  return html
    .replace(/<span class="ann-comment-badge"[\s\S]*?<\/span>/g, '')
    .replace(/<(pre|code)[^>]*>[\s\S]*?<\/\1>/g, (m) => m.replace(/<[^>]+>/g, ''))
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// app.js selection→source mapping (copied).
function findCaretPosInSource(src, beforeCtx, afterCtx) {
  const beforeWords = beforeCtx.replace(/\s+$/, '').split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, beforeWords.length); n >= 1; n--) {
    const anchor = beforeWords.slice(-n).join(' ');
    const m = Helpers.findInSource(src, anchor, beforeWords.slice(0, -n).join(' '), afterCtx);
    if (m) return m.end;
  }
  const afterWords = afterCtx.replace(/^\s+/, '').split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, afterWords.length); n >= 1; n--) {
    const anchor = afterWords.slice(0, n).join(' ');
    const m = Helpers.findInSource(src, anchor, beforeCtx, afterWords.slice(n).join(' '));
    if (m) return m.start;
  }
  return null;
}
function mapSelectionRange(src, text, beforeCtx, afterCtx) {
  if (!text.includes('\t')) {
    const single = Helpers.findInSource(src, text, beforeCtx, afterCtx);
    if (single) return { start: single.start, end: single.end, how: 'single' };
  }
  const flat = text.replace(/\t/g, ' ');
  const start = findCaretPosInSource(src, beforeCtx, flat);
  const end = findCaretPosInSource(src, (beforeCtx + ' ' + flat).slice(-200), afterCtx);
  if (start != null && end != null && end > start) return { start, end, how: 'bounds' };
  return null;
}

const stats = {};
const bump = (k) => { stats[k] = (stats[k] || 0) + 1; };
const reports = [];
for (let it = 0; it < ITER; it++) {
  const src = doc();
  let html;
  try { html = Core.renderAnnotated(md, Core.removeReviewBrief(src)); } catch (e) { bump('render-throw'); continue; }
  const text = visibleText(html);
  // A phrase of 1..5 whole words from one rendered line.
  const lines = text.split('\n').filter(l => /\S/.test(l));
  if (!lines.length) { bump('no-text'); continue; }
  const ln = pick(lines);
  const words = [...ln.matchAll(/\S+/g)];
  if (!words.length) { bump('no-words'); continue; }
  const i = Math.floor(rnd() * words.length);
  const j = Math.min(words.length - 1, i + Math.floor(rnd() * 5));
  const selStart = words[i].index, selEnd = words[j].index + words[j][0].length;
  const sel = ln.slice(selStart, selEnd);
  const lineOffset = text.indexOf(ln);
  const beforeCtx = text.slice(Math.max(0, lineOffset + selStart - 80), lineOffset + selStart);
  const afterCtx = text.slice(lineOffset + selEnd, lineOffset + selEnd + 80);
  const range = mapSelectionRange(src, sel, beforeCtx, afterCtx);
  if (!range) { bump('unmapped'); continue; }
  const srcSel = src.slice(range.start, range.end);
  // Selections that landed inside an existing annotation are refused by the UI.
  const items = Core.scanAnnotations(src);
  if (items.some(it => range.start < it.mEnd && range.end > it.mStart)) { bump('in-annotation'); continue; }
  const fences = Core.codeFenceRanges(src);
  if (fences.some(([s, e]) => range.start < e && range.end > s)) { bump('in-fence'); continue; }
  let r;
  try { r = Core.analyzeTarget(src, { type: 'range', start: range.start, end: range.end }, md); }
  catch (e) { reports.push({ why: 'analyze-throw', e: e.message, src, sel }); bump('analyze-throw'); continue; }
  bump('kind:' + r.kind);
  const ctx = (s, a, b) => JSON.stringify(s.slice(Math.max(0, a - 50), b + 50));
  if (r.kind === 'word-split' || r.kind === 'word-partial' || r.kind === 'split') reports.push({ why: 'kind-' + r.kind, src, sel, srcSel, kind: r.kind, how: range.how, ctx: ctx(src, range.start, range.end), annotated: r.supported ? ctx(Core.applyInserts(src, r.inserts, 'c'), range.start, range.end + 40) : '' });
  if (!r.supported) { reports.push({ why: 'unsupported', src, sel, srcSel, kind: r.kind, how: range.how, ctx: ctx(src, range.start, range.end) }); continue; }
  const annotated = Core.applyInserts(src, r.inserts, 'fuzz comment');
  if (!Core.isStructurePreserved(md, src, annotated)) { reports.push({ why: 'structure-broken', src, sel, srcSel, kind: r.kind, annotated }); bump('structure-broken'); continue; }
  const groups = Core.scanAnnotations(annotated).filter(it => it.comment === 'fuzz comment');
  if (groups.length !== 1) { reports.push({ why: 'group-count', n: groups.length, src, sel, kind: r.kind, annotated }); bump('group-count'); continue; }
  const restored = Core.deleteGroup(annotated, groups[0].group);
  if (restored !== src) { reports.push({ why: 'round-trip', src, sel, kind: r.kind, annotated, restored }); bump('round-trip'); continue; }
  // The interesting class: a plain phrase (no markup in the mapped source
  // text, no newline) that did not become one contiguous highlight.
  const plain = !/[*_`\[\]<>\\|{}~\n\r]/.test(srcSel) && !srcSel.includes('  ');
  if (plain && r.kind !== 'inline') {
    // Why did the whole-range highlight fail? Show the first rendered difference.
    const inl = Core.applyInserts(src, [{ type: 'pair', start: range.start, end: range.end }], 'c');
    const A = Core.normalizeHtml(Core.stripAnnotationHtml(Core.renderAnnotated(md, src)));
    const B = Core.normalizeHtml(Core.stripAnnotationHtml(Core.renderAnnotated(md, inl)));
    let d = 0; while (d < A.length && A[d] === B[d]) d++;
    reports.push({ why: 'plain-not-inline', src, sel, srcSel, kind: r.kind, how: range.how, ctx: ctx(src, range.start, range.end), annotated: ctx(annotated, range.start, range.end + 40), diff: 'A: ' + JSON.stringify(A.slice(Math.max(0, d - 60), d + 80)) + ' || B: ' + JSON.stringify(B.slice(Math.max(0, d - 60), d + 80)) });
    bump('plain-not-inline');
  }
}
console.log(JSON.stringify(stats, null, 1));
const hard = ['structure-broken', 'group-count', 'round-trip', 'analyze-throw'].reduce((n, k) => n + (stats[k] || 0), 0);
const byWhy = {};
for (const rep of reports) (byWhy[rep.why] = byWhy[rep.why] || []).push(rep);
for (const [why, list] of Object.entries(byWhy)) {
  console.log('\n=== ' + why + ' (' + list.length + ') ===');
  for (const rep of list.slice(0, Number(process.argv[4] || 4))) {
    console.log('--- sel=' + JSON.stringify(rep.sel) + (rep.srcSel ? ' src=' + JSON.stringify(rep.srcSel) : '') + ' kind=' + rep.kind + (rep.how ? ' via=' + rep.how : ''));
    console.log('  ctx ' + (rep.ctx || JSON.stringify(rep.src)));
    if (rep.annotated) console.log('  => ' + (rep.ctx ? rep.annotated : JSON.stringify(rep.annotated)));
    if (rep.restored) console.log('  <= ' + JSON.stringify(rep.restored));
    if (rep.e) console.log('  !! ' + rep.e);
    if (rep.diff) console.log('  ' + rep.diff);
  }
}

if (hard) { console.error('Fuzz: ' + hard + ' hard invariant failure(s)'); process.exitCode = 1; }
else console.log('Fuzz: hard invariants held over ' + ITER + ' documents (seed ' + process.argv[2] + ')');
