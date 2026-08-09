// Unit tests for annotator-core.js (pure source-string logic).
// Run: node --test tests/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../annotator-core.js');

// ── scanAnnotations: kinds and groups ───────────────────────
test('scan: pair, point, highlight-run grouping', () => {
  const src = 'a {==x==}{>> c1 <<} b {>> p <<} {==h1==} {==h2==}{>> c2 <<}';
  const items = Core.scanAnnotations(src);
  assert.deepEqual(items.map(i => i.kind), ['pair', 'point', 'highlight', 'pair']);
  // highlight binds to the following pair — one group
  assert.equal(items[2].group, items[3].group);
  // pair, point, and the bound run are three distinct groups
  assert.equal(new Set(items.map(i => i.group)).size, 3);
});

test('scan: del / ins / sub kinds', () => {
  const items = Core.scanAnnotations('x {--old--} y {++new++} z {~~a~>b~~}');
  assert.deepEqual(items.map(i => i.kind), ['del', 'ins', 'sub']);
  assert.equal(items[0].text, 'old');
  assert.equal(items[1].text, 'new');
  assert.equal(items[2].text, 'a');
  assert.equal(items[2].text2, 'b');
  assert.equal(new Set(items.map(i => i.group)).size, 3);
});

test('scan: sub arrow cannot leak across markers', () => {
  const items = Core.scanAnnotations('{~~one~>two~~} tail {--x--}');
  assert.equal(items[0].kind, 'sub');
  assert.equal(items[0].text2, 'two');
  assert.equal(items[1].kind, 'del');
});

// ── deleteGroup (reject) / acceptGroup semantics ────────────
test('reject: del keeps text, ins vanishes, sub reverts', () => {
  assert.equal(Core.deleteGroup('a {--gone--} b', 0), 'a gone b');
  assert.equal(Core.deleteGroup('a {++added++} b', 0), 'a  b');
  assert.equal(Core.deleteGroup('a {~~old~>new~~} b', 0), 'a old b');
});

test('accept: del removes text, ins keeps, sub takes new', () => {
  assert.equal(Core.acceptGroup('a {--gone--} b', 0), 'a  b');
  assert.equal(Core.acceptGroup('a {++added++} b', 0), 'a added b');
  assert.equal(Core.acceptGroup('a {~~old~>new~~} b', 0), 'a new b');
});

test('delete/accept comment kinds unwrap identically', () => {
  const src = 'a {==x==}{>> c <<} b {>> p <<}';
  assert.equal(Core.deleteGroup(src, 0), 'a x b {>> p <<}');
  assert.equal(Core.acceptGroup(src, 0), 'a x b {>> p <<}');
  assert.equal(Core.deleteGroup(src, 1), 'a {==x==}{>> c <<} b ');
});

test('deleteGroup removes whole multi-block group', () => {
  const src = '{==h1==} mid {==h2==}{>> c <<}';
  assert.equal(Core.deleteGroup(src, 0), 'h1 mid h2');
});

// ── updateGroup / getGroupComment ───────────────────────────
test('updateGroup rewrites only the comment', () => {
  const src = 'a {==x==}{>> old <<} b';
  assert.equal(Core.updateGroup(src, 0, 'new'), 'a {== x ==}{>> new <<} b');
  assert.equal(Core.getGroupComment(src, 0), 'old');
});

test('updateGroup leaves suggested edits untouched', () => {
  const src = 'a {--x--} b';
  assert.equal(Core.updateGroup(src, 0, 'nope'), src);
});

// ── stripAll (clean export) ─────────────────────────────────
test('stripAll cleans every annotation kind, reject semantics', () => {
  const src = '{>> doc <<}\n\nA {==hl==}{>> c <<} B {>> p <<} C {--del--} D {++ins++} E {~~old~>new~~} F';
  assert.equal(Core.stripAll(src), '\n\nA hl B  C del D  E old F');
});

test('stripAll leaves fenced CriticMarkup examples alone', () => {
  const src = '```\n{>> literal example <<}\n```\n{>> real <<}';
  assert.equal(Core.stripAll(src), '```\n{>> literal example <<}\n```\n');
});

// ── suggestEdit ─────────────────────────────────────────────
test('suggestEdit wraps range as substitution', () => {
  const src = 'hello world!';
  assert.equal(Core.suggestEdit(src, 6, 11, 'there'), 'hello {~~world~>there~~}!');
});

// ── docZone ─────────────────────────────────────────────────
test('docZone: plain comments at top', () => {
  const z = Core.docZone('{>> one <<}\n{>> two <<}\n\n# H\n{>> body <<}');
  assert.equal(z.items.length, 2);
  assert.deepEqual(z.items.map(i => i.comment.trim()), ['one', 'two']);
});

test('docZone: skips frontmatter', () => {
  const src = '---\ntitle: t\n---\n\n{>> doc <<}\n\n# H';
  const z = Core.docZone(src);
  assert.equal(z.items.length, 1);
  assert.equal(src.slice(z.end).trim().startsWith('# H'), true);
});

test('docZone: del/ins at top are not doc comments', () => {
  const z = Core.docZone('{--x--}\n{>> c <<}\n# H');
  assert.equal(z.items.length, 0);
});

test('docZone: empty when content first', () => {
  assert.equal(Core.docZone('# H\n{>> c <<}').items.length, 0);
});

// ── preprocess / fences ─────────────────────────────────────
test('annotations inside code fences stay literal', () => {
  const src = '```\n{>> not a comment <<}\n```\n{>> real <<}';
  const { placeholders } = Core.preprocessCriticMarkup(src);
  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0].comment, 'real');
});

test('code-fence literals cannot join or mutate a visible annotation group', () => {
  const src = '```\n{== literal example ==}\n```\n\n{== visible ==}{>> real comment <<}';
  const items = Core.scanAnnotations(src);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'pair');
  assert.equal(Core.deleteGroup(src, items[0].group), '```\n{== literal example ==}\n```\n\nvisible');
});

test('inline and indented code keep CriticMarkup literal', () => {
  const inline = 'Inline `{== literal ==}` then {== visible ==}{>> real <<}';
  assert.equal(Core.preprocessCriticMarkup(inline).count, 1);
  assert.equal(Core.scanAnnotations(inline).length, 1);
  const indented = '    {>> literal code example <<}\n\n{>> real <<}';
  assert.equal(Core.preprocessCriticMarkup(indented).count, 1);
  assert.equal(Core.stripAll(indented), '    {>> literal code example <<}\n\n');
});

test('preprocess carries kind, group and text2', () => {
  const { placeholders } = Core.preprocessCriticMarkup('{~~a~>b~~} {==x==}{>> c <<}');
  assert.equal(placeholders[0].kind, 'sub');
  assert.equal(placeholders[0].text2, 'b');
  assert.equal(placeholders[1].kind, 'pair');
});

test('rendered annotations expose keyboard controls and separate substitutions', () => {
  const md = { renderInline: (s) => s };
  const pair = Core.annHtml(md, { i: 0, group: 0, kind: 'pair', text: 'text', comment: 'note' });
  assert.match(pair, /tabindex="0"/);
  assert.match(pair, /role="group"/);
  assert.match(pair, /aria-label="Comment: note\. Press Enter to edit"/);
  assert.match(pair, /aria-label="Delete comment"/);

  const sub = Core.annHtml(md, { i: 1, group: 1, kind: 'sub', text: 'old', text2: 'new', comment: '' });
  assert.match(sub, /class="ann-change-arrow"/);
  assert.match(sub, /aria-label="Accept suggestion"/);
  assert.match(sub, /aria-label="Reject suggestion"/);
});

test('preprocess: placeholder cannot collide with literal document text', () => {
  const literal = '​ANN0​';
  const src = literal + ' {== alpha ==}{>> note <<}';
  const { placeholders } = Core.preprocessCriticMarkup(src);
  assert.notEqual(placeholders[0].placeholder, literal);
  const md = { render: (s) => s, renderInline: (s) => s };
  const html = Core.renderAnnotated(md, src);
  assert.equal((html.match(/class="ann-wrap/g) || []).length, 1);
  assert.ok(html.includes(literal));
});

// ── isStructurePreserved (guards the whole annotate flow) ──
// Minimal markdown-it stand-in: enough for the render→strip→compare pipeline.
const fakeMd = { render: (s) => '<p>' + s + '</p>\n', renderInline: (s) => s };

test('clean pair wrap preserves structure (strip round-trip)', () => {
  const src = 'one two three';
  const annotated = Core.applyInserts(src, [{ type: 'pair', start: 4, end: 7 }], 'c');
  assert.equal(Core.isStructurePreserved(fakeMd, src, annotated), true);
});

test('annotating next to an existing suggestion still preserves structure', () => {
  const src = 'plan ships {~~next month~>in September~~} for beta users';
  const annotated = Core.applyInserts(src, [{ type: 'pair', start: 0, end: 4 }], 'c');
  assert.equal(Core.isStructurePreserved(fakeMd, src, annotated), true);
});

test('annotating next to existing del/ins still preserves structure', () => {
  const src = 'keep {--old--} and {++new++} words';
  const annotated = Core.applyInserts(src, [{ type: 'pair', start: 0, end: 4 }], 'c');
  assert.equal(Core.isStructurePreserved(fakeMd, src, annotated), true);
});

test('point comment preserves structure', () => {
  const src = 'one two three';
  const annotated = Core.applyInserts(src, [{ type: 'point', pos: 3 }], 'c');
  assert.equal(Core.isStructurePreserved(fakeMd, src, annotated), true);
});

// ── applyInserts ────────────────────────────────────────────
test('applyInserts: single pair', () => {
  const out = Core.applyInserts('one two three', [{ type: 'pair', start: 4, end: 7 }], 'c');
  assert.equal(out, 'one {== two ==}{>> c <<} three');
});

test('applyInserts: multi-pair shares one trailing comment', () => {
  const out = Core.applyInserts('aa bb cc', [
    { type: 'pair', start: 0, end: 2 },
    { type: 'pair', start: 6, end: 8 },
  ], 'c');
  assert.equal(out, '{== aa ==} bb {== cc ==}{>> c <<}');
});

test('applyInserts: point comment', () => {
  const out = Core.applyInserts('one two', [{ type: 'point', pos: 3 }], 'c');
  assert.equal(out, 'one{>> c <<} two');
});

// ── safeComment: a comment must not be able to close its own annotation ──
test('safeComment: breaks a literal <<} in the comment text', () => {
  assert.equal(Core.safeComment('use <<} to close'), 'use << } to close');
  assert.equal(Core.safeComment('plain text'), 'plain text');
  assert.equal(Core.safeComment(null), '');
});

test('scan: malformed opener flood stays fast and produces no annotations', () => {
  const src = '{=='.repeat(20000);
  const started = Date.now();
  assert.deepEqual(Core.scanAnnotations(src), []);
  // The old regex scanner takes well over a second here. This loose limit keeps
  // the regression test reliable on slower CI workers while catching a return
  // to quadratic behaviour.
  assert.ok(Date.now() - started < 500, 'malformed CriticMarkup scan was too slow');
});

test('applyInserts: comment containing <<} stays one annotation', () => {
  const out = Core.applyInserts('one two three', [{ type: 'pair', start: 4, end: 7 }], 'close with <<} here');
  const items = Core.scanAnnotations(out);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'pair');
  assert.equal(items[0].comment.trim(), 'close with << } here');
  // nothing leaked into the document body
  assert.equal(Core.stripAll(out), 'one two three');
});

test('updateGroup: comment containing <<} stays one annotation', () => {
  const src = 'one {== two ==}{>> old <<} three';
  const g = Core.scanAnnotations(src)[0].group;
  const out = Core.updateGroup(src, g, 'now with <<} inside');
  const items = Core.scanAnnotations(out);
  assert.equal(items.length, 1);
  assert.equal(items[0].comment.trim(), 'now with << } inside');
  assert.equal(Core.stripAll(out), 'one two three');
});

// ── codeFenceRanges: CommonMark allows the opening fence to be indented ──
test('codeFenceRanges: detects a fence indented up to 3 spaces', () => {
  const src = '# H\n\n   ```mermaid\n  graph TD\n   ```\n\ntail\n';
  const ranges = Core.codeFenceRanges(src);
  assert.equal(ranges.length, 1);
  assert.ok(src.slice(ranges[0][0], ranges[0][1]).includes('graph TD'));
});

test('preprocessCriticMarkup: annotations inside an indented fence stay literal', () => {
  const src = '# H\n\n  ```\n  {>> not an annotation <<}\n  ```\n\n{>> real one <<}\n';
  const { count } = Core.preprocessCriticMarkup(src);
  assert.equal(count, 1);
});

test('codeFenceRanges: longer closing fence and unclosed fence stay literal', () => {
  const longer = '```js\n{>> literal <<}\n````\n\n{>> real <<}';
  assert.equal(Core.preprocessCriticMarkup(longer).count, 1);
  const unclosed = '```js\n{>> literal through EOF <<}';
  assert.equal(Core.preprocessCriticMarkup(unclosed).count, 0);
});

test('codeFenceRanges: nested-list and blockquote fences stay literal', () => {
  const nestedList = '- outer\n  - inner\n    ```js\n    {>> literal <<}\n    ```\n\n{>> real <<}';
  assert.equal(Core.preprocessCriticMarkup(nestedList).count, 1);
  const quote = '> ```js\n> {>> literal <<}\n> ```\n\n{>> real <<}';
  assert.equal(Core.preprocessCriticMarkup(quote).count, 1);
});

test('analyzeTarget: Mermaid content becomes a block comment, not live markup', () => {
  const src = '```mermaid\nflowchart LR\n  A --> B\n```';
  const start = src.indexOf('flowchart');
  const result = Core.analyzeTarget(src, { type: 'range', start, end: start + 'flowchart'.length });
  assert.equal(result.supported, true);
  assert.equal(result.kind, 'block');
  assert.equal(Core.applyInserts(src, result.inserts, 'Review diagram'), '{>> Review diagram <<}\n' + src);
});

test('analyzeTarget: splits a multi-paragraph CJK selection', () => {
  const md = {
    render: (s) => s.split(/\n\n/).map(p => '<p>' + p + '</p>').join(''),
    renderInline: (s) => s,
  };
  const src = '第一段文字。\n\n第二段文字。';
  const result = Core.analyzeTarget(src, { type: 'range', start: 0, end: src.length }, md);
  assert.equal(result.supported, true);
  assert.equal(result.kind, 'split');
  assert.equal(result.inserts.length, 2);
});
