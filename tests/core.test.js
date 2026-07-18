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

test('preprocess carries kind, group and text2', () => {
  const { placeholders } = Core.preprocessCriticMarkup('{~~a~>b~~} {==x==}{>> c <<}');
  assert.equal(placeholders[0].kind, 'sub');
  assert.equal(placeholders[0].text2, 'b');
  assert.equal(placeholders[1].kind, 'pair');
});

// ── isStructurePreserved (guards the whole annotate flow) ──
// Minimal markdown-it stand-in: enough for the render→strip→compare pipeline.
const fakeMd = { render: (s) => '<p>' + s + '</p>\n', renderInline: (s) => s };

test('clean pair wrap preserves structure (strip round-trip)', () => {
  const src = 'one two three';
  const annotated = Core.applyInserts(src, [{ type: 'pair', start: 4, end: 7 }], 'c');
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
