const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogFilters } = require('./catalog-filters');
test('source selectors are category-specific, verified against their real query and never invented from poster labels', async () => {
  const calls = [];
  const api = createCatalogFilters({ read: async options => {
    calls.push(options);
    if (!options.genre) return { success: true, genres: [{ slug: options.category + '-one', label: '來源標籤' }, { slug: 'empty', label: '零筆' }, { slug: 'failed', label: '未確認' }], results: [{ tags: ['不應補造'] }] };
    if (options.genre === 'failed') return { success: false };
    return { success: true, total: options.genre === 'empty' ? 0 : 100, results: options.genre === 'empty' ? [] : [{ series_id: 'fixture' }] };
  } });
  for (const category of ['real-drama', 'comic-drama', 'ai-drama']) {
    const value = await api.genres({ category });
    assert.equal(value.genres.length, 1);
    assert.equal(value.genres[0].slug, category + '-one');
    assert.equal(value.dropped, 1); assert.equal(value.unavailable, 1);
  }
  assert.equal(calls.length, 12);
});
test('validation concurrency is bounded and repeated signed-in/out reads share only public data', async () => {
  let active = 0, maximum = 0, requests = 0;
  const api = createCatalogFilters({ read: async options => {
    requests++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return options.genre ? { success: true, results: [{}], total: 1 } : { success: true, genres: Array.from({ length: 7 }, (_, i) => ({ slug: `tag-${i}`, label: `標籤${i}` })) };
  } });
  const loggedOut = await api.genres({ category: 'ai-drama', loggedIn: false });
  const loggedIn = await api.genres({ category: 'ai-drama', loggedIn: true });
  assert.deepEqual(loggedIn, loggedOut); assert.ok(maximum <= 2); assert.equal(requests, 8);
});
test('rank filters include matches from later source pages, not only the visible page', async () => {
  const api = createCatalogFilters({ read: async ({ page }) => ({ success: true, totalPages: 3, sourceUrl: 'https://fixture.invalid/rank', results: Array.from({ length: 20 }, (_, i) => ({ series_id: `${page}-${i}`, tags: page === 1 ? ['甲'] : ['乙'] })) }) });
  const genres = await api.genres({ category: 'hot-drama' }), tag = genres.genres.find(item => item.label === '乙');
  assert.equal(tag.count, 40);
  const first = await api.rankList({ category: 'hot-drama', genre: tag.slug, page: 1 });
  const second = await api.rankList({ category: 'hot-drama', genre: tag.slug, page: 2 });
  assert.equal(first.total, 40); assert.equal(first.totalPages, 2);
  assert.equal(first.results[0].series_id, '2-0'); assert.equal(second.results[0].series_id, '3-0');
});
test('incomplete rankings never become a partial full-source filter', async () => {
  const api = createCatalogFilters({ read: async ({ page }) => page === 1 ? { success: true, totalPages: 2, results: [{ series_id: 'one', tags: ['甲'] }] } : { success: false } });
  assert.equal((await api.genres({ category: 'hot-drama' })).success, false);
});
test('expired source selectors are revalidated, and manual refresh bypasses the metadata cache', async () => {
  let time = 1, calls = 0;
  const api = createCatalogFilters({ now: () => time, ttl: 10, read: async options => { calls++; return options.genre ? { success: true, results: [{}] } : { success: true, genres: [{ slug: 'actual', label: '實際' }] }; } });
  await api.genres({ category: 'real-drama' }); await api.genres({ category: 'real-drama' }); assert.equal(calls, 2);
  time += 11; await api.genres({ category: 'real-drama' }); assert.equal(calls, 4);
  await api.genres({ category: 'real-drama', forceRefresh: true }); assert.equal(calls, 6);
});

test('duplicate source labels are offered once and failed or malformed tag responses stay hidden', async () => {
  const api = createCatalogFilters({ read: async ({ genre }) => {
    if (!genre) return { success: true, genres: ['first', 'second', 'failed', 'malformed'].map(slug => ({ slug, label: slug === 'second' ? ' 相同 ' : slug === 'first' ? '相同' : slug })) };
    if (genre === 'failed') throw new Error('offline');
    if (genre === 'malformed') return { success: true };
    return { success: true, total: -1, results: [{}] };
  } });
  const value = await api.genres({ category: 'real-drama' });
  assert.equal(value.success, true);
  assert.equal(value.genres.length, 1);
  assert.equal(value.genres[0].label, '相同');
  assert.equal(value.genres[0].count, 1);
  assert.equal(value.dropped, 1); assert.equal(value.unavailable, 2);
});
test('ranking tags normalize source whitespace without offering an empty filter', async () => {
  const api = createCatalogFilters({ read: async () => ({ success: true, totalPages: 1, results: [{ series_id: 'fixture', tags: [' 標籤 '] }] }) });
  const { genres } = await api.genres({ category: 'hot-ai-drama' });
  assert.equal((await api.rankList({ category: 'hot-ai-drama', genre: genres[0].slug })).results.length, 1);
});


test('each category discovers its own tags and orders by verified count, without borrowing a shared set', async () => {
  const offered = {
    'real-drama': [{ slug: 'family', label: '家庭', count: 8 }, { slug: 'urban', label: '都市', count: 20 }],
    'comic-drama': [{ slug: 'fantasy', label: '玄幻', count: 30 }, { slug: 'adventure', label: '冒險', count: 6 }],
    'ai-drama': [{ slug: 'creative', label: '腦洞', count: 10 }, { slug: 'fantasy', label: '玄幻', count: 40 }],
  };
  const filters = createCatalogFilters({ read: async ({ category, genre }) => {
    const tags = offered[category];
    if (!genre) return { success: true, genres: tags };
    const tag = tags.find(item => item.slug === genre);
    assert.ok(tag);
    return { success: true, results: [{ series_id: 'sample' }], total: tag.count };
  } });
  for (const category of Object.keys(offered)) {
    const result = await filters.genres({ category });
    assert.equal(result.success, true);
    assert.deepEqual(result.genres.map(item => item.slug), [...offered[category]].sort((a, b) => b.count - a.count).map(item => item.slug));
  }
});
