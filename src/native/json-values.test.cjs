const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseJson } = require('./json-values');

test('playback ids retain every digit, including nested arrays and strings containing JSON', () => {
  const raw = '{"series_id":7691698632214449177,"videos":[{"vid":7691760367814331417,"vid_index":17}],"text":"[7691760367814331417]","nested":"{\\"vid\\":7691760367814331417}","duration":1000}';
  const parsed = parseJson(raw);
  assert.equal(parsed.series_id, '7691698632214449177');
  assert.equal(parsed.videos[0].vid, '7691760367814331417');
  assert.equal(parsed.videos[0].vid_index, 17);
  assert.equal(parsed.text, '[7691760367814331417]');
  assert.equal(parsed.nested, '{"vid":7691760367814331417}');
  assert.equal(parsed.duration, 1000);
});

test('safe integers and decimal/exponent values keep their JSON types; invalid JSON stays invalid', () => {
  assert.deepEqual(parseJson('[0,-1,9007199254740991,1.5,1e3,null,true]'), [0,-1,9007199254740991,1.5,1000,null,true]);
  assert.deepEqual(parseJson('[9007199254740992,-9007199254740992]'), ['9007199254740992','-9007199254740992']);
  for (const value of ['{"id":01}', '[1,]', '{"a":-}', 'undefined']) assert.throws(() => parseJson(value));
});
