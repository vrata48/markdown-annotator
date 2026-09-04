const test = require('node:test');
const assert = require('node:assert/strict');
const Helpers = require('../app-helpers.js');

test('source mapping handles typography and repeated text context', () => {
  const source = 'First "launch" is early. Second "launch" is final.';
  const result = Helpers.findInSource(source, '“launch”', 'Second ', ' is final.');
  assert.equal(source.slice(result.start, result.end), '"launch"');
  assert.equal(result.start, source.lastIndexOf('"launch"'));
});

test('folderChildren filters and orders one directory level', () => {
  const entries = [
    { name: 'zeta.md', kind: 'file' },
    { name: 'image.png', kind: 'file' },        // not markdown — dropped
    { name: '.git', kind: 'directory' },        // hidden — dropped
    { name: 'node_modules', kind: 'directory' },// dropped
    { name: 'Notes', kind: 'directory' },
    { name: 'archive', kind: 'directory' },
    { name: 'Alpha.MD', kind: 'file' },
  ];
  assert.deepEqual(Helpers.folderChildren(entries).map(e => e.name),
    ['archive', 'Notes', 'Alpha.MD', 'zeta.md']);  // dirs first, case-insensitive
});

test('folderChildren passes entries through unchanged and handles empty input', () => {
  assert.deepEqual(Helpers.folderChildren([]), []);
  assert.deepEqual(Helpers.folderChildren(null), []);
  const entry = { name: 'a.md', kind: 'file', handle: { fake: true } };
  assert.equal(Helpers.folderChildren([entry])[0], entry);  // same object, handle intact
});

test('annotationGroups returns one compact entry per logical group', () => {
  const items = [
    { group: 0, kind: 'highlight', text: 'first' },
    { group: 0, kind: 'pair', comment: 'One\ncomment' },
    { group: 1, kind: 'sub', text: 'old', text2: 'new' },
  ];
  assert.deepEqual(Helpers.annotationGroups(items), [
    { group: 0, kind: 'highlight', label: 'One comment' },
    { group: 1, kind: 'sub', label: 'new' },
  ]);
});


test('textDiff finds the one splice between two sources', () => {
  assert.equal(Helpers.textDiff('same', 'same'), null);
  assert.deepEqual(Helpers.textDiff('a fox jumps', 'a {== fox ==}{>> hm <<} jumps'),
    { index: 2, remove: 3, insert: '{== fox ==}{>> hm <<}' });
  assert.deepEqual(Helpers.textDiff('keep {>> note <<}this', 'keep this'), { index: 5, remove: 12, insert: '' });
  assert.deepEqual(Helpers.textDiff('', 'new'), { index: 0, remove: 0, insert: 'new' });
  assert.deepEqual(Helpers.textDiff('old', ''), { index: 0, remove: 3, insert: '' });
  // Applying the diff reproduces the target.
  const before = 'x'.repeat(10) + 'MIDDLE' + 'y'.repeat(10);
  const after = 'x'.repeat(10) + 'CENTER' + 'y'.repeat(10);
  const d = Helpers.textDiff(before, after);
  assert.equal(before.slice(0, d.index) + d.insert + before.slice(d.index + d.remove), after);
});

test('textDiff never splits a surrogate pair', () => {
  // U+1F600 and U+1F601 share their high surrogate; the naive prefix would
  // stop between the halves and push a lone surrogate into the shared text.
  const d = Helpers.textDiff('a\u{1F600}b', 'a\u{1F601}b');
  assert.deepEqual(d, { index: 1, remove: 2, insert: '\u{1F601}' });
  const e = Helpers.textDiff('\u{1F600}', '\u{1F601}\u{1F600}');
  assert.equal('\u{1F600}'.slice(0, e.index) + e.insert + '\u{1F600}'.slice(e.index + e.remove), '\u{1F601}\u{1F600}');
  assert.equal(e.insert.length % 2, 0);
});

test('share links round-trip room and key through the fragment', () => {
  const room = 'AbCdEfGhIjKlMnOpQrStUv';
  const key = 'k-'.repeat(20) + 'kkk';
  const hash = Helpers.shareHash(room, key);
  assert.deepEqual(Helpers.parseShareHash(hash), { room, key });
  assert.deepEqual(Helpers.parseShareHash('#other=1&' + hash.slice(1)), { room, key });
  assert.equal(Helpers.parseShareHash(''), null);
  assert.equal(Helpers.parseShareHash('#share=short.short'), null);
  assert.equal(Helpers.parseShareHash('#share=' + room), null);
  assert.equal(Helpers.parseShareHash('#share=' + room + '.bad/chars+here+here+here+here'), null);
});

test('tagAuthor prefixes comments with a readable author tag', () => {
  assert.equal(Helpers.tagAuthor('Vrata', 'looks wrong'), '@Vrata: looks wrong');
  assert.equal(Helpers.tagAuthor('  Ada   Lovelace ', 'x'), '@Ada Lovelace: x');
  assert.equal(Helpers.tagAuthor('', 'plain'), 'plain');
  assert.equal(Helpers.tagAuthor(null, 'plain'), 'plain');
});
