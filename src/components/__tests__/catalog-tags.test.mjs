import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARED_BROWSE_TAGS, formatPublicScore, posterMatchesTags, toggleBrowseTags } from '../../catalogTags.mjs';

test('browse tags stay one shared list and accept at most two', () => {
  assert.equal(new Set(SHARED_BROWSE_TAGS).size, SHARED_BROWSE_TAGS.length);
  for (const label of ['脑洞', '恋爱', '系统', '穿越', '重生', '爱情', '逆袭']) assert.ok(SHARED_BROWSE_TAGS.includes(label));
  assert.deepEqual(toggleBrowseTags([], '爱情'), ['爱情']);
  assert.deepEqual(toggleBrowseTags(['爱情'], '逆袭'), ['爱情', '逆袭']);
  assert.deepEqual(toggleBrowseTags(['爱情', '逆袭'], '都市'), ['逆袭', '都市']);
  assert.deepEqual(toggleBrowseTags(['爱情', '逆袭'], '爱情'), ['逆袭']);
  assert.deepEqual(toggleBrowseTags(['爱情'], '全部'), []);
  assert.deepEqual(toggleBrowseTags(['爱情'], '不存在的标签'), ['爱情']);
});

test('two tags require both poster labels and one tag still matches alone', () => {
  const tags = ['玄幻', '逆袭', '修真'];
  assert.equal(posterMatchesTags(tags, []), true);
  assert.equal(posterMatchesTags(tags, ['逆袭']), true);
  assert.equal(posterMatchesTags(tags, ['爱情']), false);
  assert.equal(posterMatchesTags(tags, ['玄幻', '逆袭']), true);
  assert.equal(posterMatchesTags(tags, ['玄幻', '爱情']), false);
  assert.equal(posterMatchesTags(['戀愛', '系統'], ['恋爱', '系统']), true);
});

test('public scores use one decimal and ignore empty values', () => {
  assert.equal(formatPublicScore(9.14), '9.1');
  assert.equal(formatPublicScore(9), '9.0');
  assert.equal(formatPublicScore(0), '');
  assert.equal(formatPublicScore(null), '');
  assert.equal(formatPublicScore(11), '');
});
