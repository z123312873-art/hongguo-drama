const assert = require('node:assert/strict');
const test = require('node:test');
const { seriesEntries } = require('./series-browse');

test('series browse keeps installments and drops unrelated titles when a page has enough series', () => {
  const rows = [
    { series_id: '1', series_title: '青铜门' },
    { series_id: '2', series_title: '青铜门后Ⅰ' },
    { series_id: '3', series_title: '青铜门后Ⅱ' },
    { series_id: '4', series_title: '老千2' },
    { series_id: '5', series_title: '另一部完全无关的剧' },
  ];
  const kept = seriesEntries(rows).map(item => item.series_id);
  assert.deepEqual(kept, ['1', '2', '3', '4']);
});

test('a thin series page still shows the public results instead of going blank', () => {
  const rows = [
    { series_id: '1', series_title: '青铜门后Ⅰ' },
    { series_id: '2', series_title: '普通短剧' },
  ];
  assert.equal(seriesEntries(rows).length, 2);
});
