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

