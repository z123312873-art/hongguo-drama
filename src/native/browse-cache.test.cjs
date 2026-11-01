// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowseCache, FRESH_MS, MAX_AGE_MS } = require('./browse-cache');

const card = (n) => ({ series_id: `x:${n}`, series_title: `剧${n}`, cover: `https://img.example.com/${n}.jpg`, episode_count: 30, tags: [] });
const listOf = (page, count = 3, version = 1) => ({ success: true, results: Array.from({ length: count }, (_, i) => card(`${version}-${page}-${i}`)), page, hasMore: true, genres: [] });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness(extra = {}) {
  const clock = { at: 1_800_000_000_000 };
  const calls = [];
  const cache = createBrowseCache({ now: () => clock.at, ...extra });
  const fetcher = extra.fetcher || (async (options) => { calls.push(options); return listOf(options.page, 3, calls.length); });
  return { clock, calls, cache, list: cache.wrap('demo', fetcher) };
}

test('a list fetched once is answered from the cache, not the network', async () => {
  const { calls, list } = harness();
  const first = await list({ genre: 'a', page: 1 });
  const second = await list({ genre: 'a', page: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(second.results, first.results);
  assert.equal(second.fromCache, true);
  assert.equal(second.refreshing, false);
  await list({ genre: 'a', page: 2 });
  await list({ genre: 'b', page: 1 });
  assert.equal(calls.length, 3, 'a different page or genre is a different entry');
});

test('an old list is shown at once and refreshed in the background', async () => {
  const { clock, calls, list } = harness();
  const first = await list({ page: 1 });
  clock.at += FRESH_MS + 1000;
  const second = await list({ page: 1 });
  assert.deepEqual(second.results, first.results, 'the old posters appear immediately');
  assert.equal(second.refreshing, true);
  await tick(); await tick();
  assert.equal(calls.length, 2);
  const third = await list({ page: 1 });
  assert.notDeepEqual(third.results, first.results, 'the refreshed list is used next time');
  assert.equal(third.refreshing, false);
});

test('a refresh that fails keeps the old list; an explicit refresh reports the failure', async () => {
  let fail = false;
  const { clock, list } = harness({ fetcher: async (options) => (fail ? { success: false, error: '来源暂不可用' } : listOf(options.page)) });
  const first = await list({ page: 1 });
  clock.at += FRESH_MS + 1000;
  fail = true;
  assert.deepEqual((await list({ page: 1 })).results, first.results);
  await tick(); await tick();
  assert.deepEqual((await list({ page: 1 })).results, first.results, 'the failed refresh did not replace anything');
  const forced = await list({ page: 1, forceRefresh: true });
  assert.equal(forced.success, false);
  clock.at += MAX_AGE_MS;
  const expired = await list({ page: 1 });
  assert.equal(expired.stale, true, 'a source that is down still shows the last list');
  assert.deepEqual(expired.results, first.results);
});

test('simultaneous requests for one page share a single fetch and nothing empty is stored', async () => {
  let calls = 0;
  const { cache } = harness();
  const list = cache.wrap('shared', async (options) => { calls += 1; await tick(); return options.page === 9 ? { success: true, results: [] } : listOf(options.page); });
  await Promise.all([list({ page: 1 }), list({ page: 1 }), list({ page: 1 })]);
  assert.equal(calls, 1);
  await list({ page: 9 });
  await list({ page: 9 });
  assert.equal(calls, 3, 'an empty answer is never cached');
});

test('the network queue never runs more fetches at once than its slots', async () => {
  let active = 0;
  let peak = 0;
  const { cache } = harness({ slots: 2 });
  const list = cache.wrap('wide', async (options) => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; return listOf(options.page); });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => list({ page: i + 1 })));
  assert.equal(peak, 2);
  assert.ok(results.every((entry) => entry.success));
});

test('lists and genre lists survive a restart; damaged or hostile files are ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-cache-'));
  const file = path.join(dir, 'browse-cache.json');
  try {
    const first = harness();
    first.cache.configure({ file });
    const shown = await first.list({ genre: 'g', page: 1 });
    first.cache.setAux('demo:genres', [{ slug: 'g', label: '题材' }]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const second = harness();
    second.cache.configure({ file });
    assert.deepEqual((await second.list({ genre: 'g', page: 1 })).results, shown.results);
    assert.equal(second.calls.length, 0);
    assert.deepEqual(second.cache.getAux('demo:genres'), [{ slug: 'g', label: '题材' }]);
    fs.writeFileSync(file, '{ broken');
    const damaged = harness();
    damaged.cache.configure({ file });
    assert.equal((await damaged.list({ genre: 'g', page: 1 })).success, true);
    assert.equal(damaged.calls.length, 1);
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [
      { source: 'demo', options: { genre: '', page: 1 }, savedAt: Date.now(), data: { success: true, results: [{ series_id: 'x:1', series_title: 't', cover: 'http://evil.example/p.jpg' }] } },
      { source: 'demo', options: { genre: '', page: 'NaN' }, savedAt: Date.now(), data: listOf(1) },
    ], aux: { bad: { savedAt: 'x', value: 1 } } }));
    const hostile = harness();
    hostile.cache.configure({ file });
    assert.equal(hostile.cache.snapshot().entries, 0);
    assert.equal(hostile.cache.getAux('bad'), undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the periodic refresh updates only recently used lists that went stale, a few at a time', async () => {
  const { clock, calls, cache } = harness({ setTimer: (fn) => { const timer = setTimeout(fn, 0); return timer; } });
  const list = cache.wrap('demo', async (options) => { calls.push(options); return listOf(options.page, 3, calls.length); });
  for (let page = 1; page <= 8; page += 1) await list({ page });
  assert.equal(await cache.refreshDue(), 0, 'fresh lists are left alone');
  clock.at += FRESH_MS + 1000;
  const before = calls.length;
  assert.equal(await cache.refreshDue(), 6);
  assert.equal(calls.length, before + 6);
  clock.at += 4 * 24 * 60 * 60 * 1000;
  assert.equal(await cache.refreshDue(), 0, 'lists nobody looked at for days are not kept warm');
});
