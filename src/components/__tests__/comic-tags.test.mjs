import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { sourceLabels, sourceTagCounts, sourceMatchesTags, chooseSourceTag } from '../../comicTags.mjs';
const fixture = JSON.parse(readFileSync(new URL('./comic-tags.fixture.json', import.meta.url), 'utf8'));
test('comic tags are actual source labels, never a static synonym list', () => {
  assert.deepEqual(sourceLabels({ tags: [' 都市脑洞 ', '都市脑洞', '', null, 5] }), ['都市脑洞']);
  assert.deepEqual(sourceLabels(null), []);
  const counts = sourceTagCounts([{ tags: ['甲', '甲', '乙'] }, { tags: ['乙'] }]);
  assert.deepEqual([...counts], [['甲', 1], ['乙', 2]]);
  assert.equal(counts.has('invented'), false);
});
test('source tag selection replaces the old selection and rejects unavailable labels', () => {
  const counts = new Map([['甲', 2], ['乙', 1]]);
  assert.deepEqual(chooseSourceTag([], '甲', counts), ['甲']);
  assert.deepEqual(chooseSourceTag(['甲'], '乙', counts), ['乙']);
  assert.deepEqual(chooseSourceTag(['甲'], '甲', counts), []);
  assert.deepEqual(chooseSourceTag(['甲'], '全部', counts), []);
  assert.deepEqual(chooseSourceTag(['removed'], 'unknown', counts), []);
});
test('every offered tag has a matching item across the complete captured source metadata', () => {
  const items = fixture.tags.map(tags => ({ tags })), counts = sourceTagCounts(items);
  const actual = new Set(fixture.tags.flat().filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()));
  assert.equal(counts.size, actual.size);
  for (const [label, count] of counts) {
    assert.ok(count > 0);
    assert.equal(items.filter(card => sourceMatchesTags(card, [label])).length, count);
  }
  assert.equal(sourceMatchesTags(null, []), true);
  assert.equal(sourceMatchesTags(null, ['甲']), false);
});
