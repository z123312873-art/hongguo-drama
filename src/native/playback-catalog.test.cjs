const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validCatalog, readId } = require('./playback-catalog');
const S = '7300000000000000001', V = '7300000000000000002';
const catalog = { series_id: S, episodes: [{ vid: V, vid_index: 1 }] };

test('valid playback catalogs bind the exact series, episode ids and one-based indices', () => {
  assert.equal(validCatalog(catalog, S), true);
  assert.equal(readId(Number(V)), '');
  assert.equal(validCatalog({ ...catalog, series_id: Number(S) }, S), false);
  assert.equal(validCatalog(catalog, V), false);
});

test('empty, imprecise, repeated and malformed catalogs cannot replace saved playback entries', () => {
  for (const episodes of [[], [{ vid: Number(V), vid_index: 1 }], [{ vid: V, vid_index: 0 }], [{ vid: V, vid_index: 1 }, { vid: V, vid_index: 2 }], [{ vid: V, vid_index: 1 }, { vid: S, vid_index: 1 }], [{ vid: 'hema:1', vid_index: 1 }]]) assert.equal(validCatalog({ series_id: S, episodes }, S), false);
});
