import assert from 'node:assert/strict';
import test from 'node:test';
import { loadComicCatalog } from '../../comicCatalog.mjs';

const card = (n) => ({ series_id: String(7000000 + n), series_title: `漫画${n}`, tags: ['都市'], cover: '' });
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => card(from + i));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeApi({ pages = { 1: range(1, 24), 2: range(25, 48), 3: range(49, 72), 4: range(73, 74) }, extras = range(1000, 1065), snapshot = null, failPages = [], delays = {}, extrasFail = false, overshoot = 0 } = {}) {
  const calls = { browse: [], extras: [], active: 0, peak: 0 };
  return {
    calls,
    async comicSnapshot() { return snapshot ? { success: true, snapshot } : { success: true, snapshot: null }; },
    async browseList(options) {
      calls.browse.push(options);
      calls.active += 1; calls.peak = Math.max(calls.peak, calls.active);
      await delay(delays[options.page] || 1);
      calls.active -= 1;
      if (failPages.includes(options.page)) return { success: false, error: '网络失败' };
      return { success: true, results: pages[options.page] || [], page: options.page, totalPages: Object.keys(pages).length, total: Object.values(pages).flat().length };
    },
    async comicExtras(payload) { calls.extras.push(payload); if (extrasFail) throw new Error('x'); return { success: true, items: extras.slice(0, payload.limit + overshoot) }; },
  };
}

test('the first page shows before the rest, the site order is kept, and extras fill to 140', async () => {
  const api = fakeApi();
  const states = [];
  const result = await loadComicCatalog({ api, onProgress: (state) => states.push(state) });
  assert.equal(states[0].items.length, 24, 'page 1 alone is the first paint');
  assert.equal(states[0].pending, true);
  assert.equal(states[0].expectedTotal, 74);
  assert.equal(result.items.length, 140);
  assert.deepEqual(result.items.slice(0, 74).map((item) => item.series_id), range(1, 74).map((item) => item.series_id), 'site order first');
  assert.equal(result.items[74].series_id, String(7000000 + 1000));
  assert.deepEqual(api.calls.extras[0].limit, 66);
  assert.equal(api.calls.extras[0].exclude.length, 74);
  assert.ok(api.calls.peak <= 3, `page requests stay at three at a time, saw ${api.calls.peak}`);
  assert.equal(states.at(-1).pending, false);
  let last = 0;
  for (const state of states) { assert.ok(state.items.length >= last, 'the list only ever grows'); last = state.items.length; }
});

test('a late page never appears before an earlier one: only a contiguous prefix is shown', async () => {
  const api = fakeApi({ delays: { 2: 40, 3: 1, 4: 1 } });
  const states = [];
  await loadComicCatalog({ api, onProgress: (state) => states.push(state) });
  for (const state of states.filter((item) => item.pending)) {
    const ids = state.items.slice(0, 74).map((item) => Number(item.series_id) - 7000000);
    assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => i + 1), 'no gaps while pages are in flight');
  }
});

test('duplicates between pages and between site and extras are removed', async () => {
  const api = fakeApi({ pages: { 1: range(1, 24), 2: range(20, 40) }, extras: [...range(30, 45), ...range(100, 300)], overshoot: 200 });
  const result = await loadComicCatalog({ api });
  const ids = result.items.map((item) => item.series_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 140);
});

test('a site larger than the cap needs no extras and is truncated to 140', async () => {
  const big = {}; for (let n = 1; n <= 8; n += 1) big[n] = range(n * 100, n * 100 + 23);
  const api = fakeApi({ pages: big });
  const result = await loadComicCatalog({ api });
  assert.equal(result.items.length, 140);
  assert.equal(api.calls.extras.length, 0);
});

test('a failed first page without a snapshot is an error the caller can show', async () => {
  const api = fakeApi({ failPages: [1] });
  await assert.rejects(loadComicCatalog({ api }), /网络失败/);
});

test('a failed first page with a snapshot keeps the snapshot and says so', async () => {
  const snapshot = { items: range(1, 40), siteCount: 30 };
  const api = fakeApi({ snapshot, failPages: [1] });
  const states = [];
  const result = await loadComicCatalog({ api, onProgress: (state) => states.push(state) });
  assert.equal(result.items.length, 40);
  assert.equal(states[0].stale, true);
  assert.match(states.at(-1).notice, /上次/);
  assert.equal(states.at(-1).pending, false);
});

test('a snapshot paints at once and is replaced only when the fresh site pages are complete', async () => {
  const snapshot = { items: range(1, 100), siteCount: 74 };
  const api = fakeApi({ snapshot, delays: { 2: 20 } });
  const states = [];
  await loadComicCatalog({ api, onProgress: (state) => states.push(state) });
  assert.equal(states[0].items.length, 100);
  assert.equal(states[0].stale, true);
  const staleStates = states.filter((state) => state.stale);
  assert.equal(staleStates.length, 1, 'no intermediate partial list replaces the snapshot');
  assert.equal(states.at(-1).stale, false);
  assert.equal(states.at(-1).items.length, 140);
});

test('a missing middle page still shows the rest in order and offers a retry', async () => {
  const api = fakeApi({ failPages: [3] });
  const result = await loadComicCatalog({ api });
  assert.equal(result.items.slice(0, 48).length, 48);
  assert.ok(!result.items.some((item) => item.series_id === String(7000000 + 49)), 'page 4 is not shown without page 3 contiguous prefix');
});

test('an extras failure keeps the site list and reports it', async () => {
  const api = fakeApi({ extrasFail: true });
  const states = [];
  const result = await loadComicCatalog({ api, onProgress: (state) => states.push(state) });
  assert.equal(result.items.length, 74);
  assert.match(states.at(-1).notice, /补充漫画/);
  assert.equal(states.at(-1).pending, false);
});

test('a newer request cancels an older one before it reports anything further', async () => {
  const api = fakeApi({ delays: { 1: 20, 2: 20 } });
  let current = true;
  const states = [];
  const run = loadComicCatalog({ api, isCurrent: () => current, onProgress: (state) => states.push(state) });
  await delay(5);
  current = false;
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.equal(states.length, 0);
  assert.equal(api.calls.extras.length, 0, 'extras are not requested for a cancelled load');
});

test('force refresh skips the snapshot and asks the source for fresh pages', async () => {
  const api = fakeApi({ snapshot: { items: range(1, 10), siteCount: 10 } });
  const states = [];
  await loadComicCatalog({ api, forceRefresh: true, onProgress: (state) => states.push(state) });
  assert.equal(states.some((state) => state.stale), false);
  assert.ok(api.calls.browse.every((call) => call.forceRefresh === true));
});

test('a thrown snapshot call or a single-page site does not break loading', async () => {
  const api = fakeApi({ pages: { 1: range(1, 10) } });
  api.comicSnapshot = async () => { throw new Error('ipc'); };
  const result = await loadComicCatalog({ api });
  assert.equal(result.items.length, 76, '10 site titles plus 66 extras');
  assert.equal(api.calls.browse.length, 1);
});

test('extras that are still being gathered are asked for again and the list grows to 140', async () => {
  const api = fakeApi();
  const all = range(1000, 1065);
  const sizes = [0, 20, 45, 66];
  let round = 0;
  api.comicExtras = async (payload) => {
    api.calls.extras.push(payload);
    const size = sizes[Math.min(round++, sizes.length - 1)];
    return { success: true, items: all.slice(0, size), refreshing: size < 66, partial: size < 66 };
  };
  api.wait = async () => {};
  const states = [];
  const result = await loadComicCatalog({ api, onProgress: (state) => states.push(state) });
  assert.equal(result.items.length, 140);
  assert.equal(api.calls.extras.length, 4);
  const pending = states.filter((state) => state.pending && state.items.length > 74);
  assert.ok(pending.length >= 2, 'titles appear while the rest is still arriving');
  assert.equal(states.at(-1).pending, false);
  assert.equal(states.at(-1).notice, '');
});

test('when no extras can be fetched the notice carries the stage and code the service reported', async () => {
  const api = fakeApi();
  api.comicExtras = async () => ({ success: true, items: [], partial: true, refreshing: false, diagnostic: '漫画服务暂时无法提供该内容（搜索，代码 101021）' });
  const states = [];
  const result = await loadComicCatalog({ api, onProgress: (state) => states.push(state) });
  assert.equal(result.items.length, 74, 'the site list is still shown in full');
  assert.match(states.at(-1).notice, /补充漫画暂时没取到.*搜索，代码 101021/);
});

test('extras that stop short of 140 say so instead of staying silent', async () => {
  const api = fakeApi({ extras: range(1000, 1019) });
  const states = [];
  const result = await loadComicCatalog({ api, onProgress: (state) => states.push(state) });
  assert.equal(result.items.length, 94);
  assert.match(states.at(-1).notice, /没取满/);
});

test('polling stops when a newer request takes over', async () => {
  const api = fakeApi();
  let current = true;
  api.comicExtras = async (payload) => { api.calls.extras.push(payload); return { success: true, items: range(1000, 1010), refreshing: true, partial: true }; };
  api.wait = async () => { current = false; };
  const result = await loadComicCatalog({ api, isCurrent: () => current });
  assert.equal(result.cancelled, true);
  assert.equal(api.calls.extras.length, 1);
});
