const test = require('node:test');
const assert = require('node:assert/strict');
const Helpers = require('../app-helpers.js');

test('GitLab parser preserves an ambiguous slash-containing ref tail', () => {
  const parsed = Helpers.parseGitLabBlobUrl(
    'https://gitlab.example.com/group/repo/-/blob/feature/review/docs/README.md?plain=1#L3'
  );
  assert.deepEqual(parsed, {
    base: 'https://gitlab.example.com',
    projectPath: 'group/repo',
    tailSegments: ['feature', 'review', 'docs', 'README.md'],
  });
  assert.deepEqual(Helpers.gitLabRefCandidates(parsed), [
    { ref: 'feature/review/docs', path: 'README.md' },
    { ref: 'feature/review', path: 'docs/README.md' },
    { ref: 'feature', path: 'review/docs/README.md' },
  ]);
});

test('GitLab parser rejects non-blob and non-http URLs', () => {
  assert.equal(Helpers.parseGitLabBlobUrl('https://gitlab.com/group/repo'), null);
  assert.equal(Helpers.parseGitLabBlobUrl('javascript:alert(1)'), null);
});

test('source mapping handles typography and repeated text context', () => {
  const source = 'First "launch" is early. Second "launch" is final.';
  const result = Helpers.findInSource(source, '“launch”', 'Second ', ' is final.');
  assert.equal(source.slice(result.start, result.end), '"launch"');
  assert.equal(result.start, source.lastIndexOf('"launch"'));
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
