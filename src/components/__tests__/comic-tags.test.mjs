import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { COMIC_CHIPS, comicChipCounts, comicChipsFor, comicMatchesChips, toggleComicChips } from '../../comicTags.mjs';

const fixture = JSON.parse(readFileSync(new URL('./comic-tags.fixture.json', import.meta.url), 'utf8'));

test('there are fourteen distinct chips and no chip has an empty keyword', () => {
  assert.equal(COMIC_CHIPS.length, 14);
  assert.equal(new Set(COMIC_CHIPS.map(chip => chip.label)).size, 14);
  for (const chip of COMIC_CHIPS) assert.ok(chip.words.length > 0 && chip.words.every(word => word.length > 0));
});

test('source label variants land in the chip of their idea', () => {
  assert.deepEqual(comicChipsFor(['现言甜宠']), ['言情']);
  assert.deepEqual(comicChipsFor(['现代言情']), ['言情']);
  assert.ok(comicChipsFor(['都市脑洞']).includes('都市'));
  assert.ok(comicChipsFor(['宫斗宅斗']).includes('古风'));
  assert.ok(comicChipsFor(['武侠仙侠']).includes('玄幻仙侠'));
  assert.ok(comicChipsFor(['科幻末世']).includes('末世科幻'));
  assert.ok(comicChipsFor(['治愈/萌系']).includes('萌趣搞笑'));
  assert.deepEqual(comicChipsFor(['totally unknown']), []);
  assert.deepEqual(comicChipsFor([]), []);
  assert.deepEqual(comicChipsFor(null), []);
  assert.deepEqual(comicChipsFor([null, 5, undefined, '']), []);
});

test('traditional and simplified labels match the same chip', () => {
  assert.deepEqual(comicChipsFor(['戀愛']), comicChipsFor(['恋爱']));
  assert.ok(comicChipsFor(['穿越', '重生']).includes('穿越重生'));
  assert.ok(comicChipsFor(['懸疑']).includes('悬疑灵异'));
});

test('selection keeps at most two chips and ignores unknown ones', () => {
  assert.deepEqual(toggleComicChips([], '都市'), ['都市']);
  assert.deepEqual(toggleComicChips(['都市'], '古风'), ['都市', '古风']);
  assert.deepEqual(toggleComicChips(['都市', '古风'], '言情'), ['古风', '言情']);
  assert.deepEqual(toggleComicChips(['都市', '古风'], '都市'), ['古风']);
  assert.deepEqual(toggleComicChips(['都市'], '全部'), []);
  assert.deepEqual(toggleComicChips(['都市'], '不存在'), ['都市']);
  assert.deepEqual(toggleComicChips(['不存在', '都市'], '古风'), ['都市', '古风']);
  assert.deepEqual(toggleComicChips(undefined, undefined), []);
});

test('two selected chips require both, one matches alone, none matches everything', () => {
  const card = { tags: ['都市脑洞', '复仇'] };
  assert.equal(comicMatchesChips(card, []), true);
  assert.equal(comicMatchesChips(card, ['都市']), true);
  assert.equal(comicMatchesChips(card, ['都市', '逆袭复仇']), true);
  assert.equal(comicMatchesChips(card, ['都市', '古风']), false);
  assert.equal(comicMatchesChips({ tags: [] }, ['都市']), false);
  assert.equal(comicMatchesChips(null, ['都市']), false);
  assert.equal(comicMatchesChips(null, []), true);
});

test('the chips cover at least 97 percent of the captured site and search labels, and none is empty', () => {
  const covered = fixture.tags.filter(tags => comicChipsFor(tags).length > 0).length;
  assert.ok(covered / fixture.tags.length >= 0.97, `covered ${covered}/${fixture.tags.length}`);
  const counts = comicChipCounts(fixture.tags.map(tags => ({ tags })));
  for (const [label, count] of counts) assert.ok(count >= 5, `${label} has only ${count}`);
});
