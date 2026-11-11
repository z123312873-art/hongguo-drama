

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const path = require('node:path');

function load(name, axios) {
  const original = Module._load;
  Module._load = function patched(request, ...rest) { return request === 'axios' ? axios : original.call(this, request, ...rest); };
  try {
    for (const file of [name, './browse-cache']) delete require.cache[require.resolve(path.join(__dirname, file))];
    return { source: require(path.join(__dirname, name)), cache: require(path.join(__dirname, 'browse-cache')).shared };
  } finally { Module._load = original; }
}

const xifanList = (offset) => ({ elements: [{ contents: [{ duanjuVo: { source: 'huabo', duanjuId: `d${offset}`, title: `西饭${offset}`, total: 30, coverImageUrl: 'https://img.example/a.jpg', categories: ['都市'] } }] }], hasMore: true });
const categories = { elements: [{ contents: [{ categoryItemVo: { categoryId: 68, oppoCategory: '都市', version: 1 } }] }] };

test('Xifan: a visited list and its genres are answered without the network, also when the source is down', async () => {
  let requests = 0;
  let down = false;
  const axios = { get: async (_url, options) => {
    requests += 1;
    if (down) throw new Error('offline');
    const data = options.params.reqType === 'duanjuCategory' ? categories : xifanList(options.params.offset);
    return { data: { ret: 0, result: data } };
  } };
  const { source, cache } = load('xifan.js', axios);
  const pages = await Promise.all([1, 2, 3].map((page) => source.browseList({ page })));
  assert.deepEqual(pages.map((entry) => entry.success), [true, true, true]);
  const used = requests;
  assert.equal(used, 4, 'three pages and one shared genre request');
  down = true;
  const again = await Promise.all([1, 2, 3].map((page) => source.browseList({ page })));
  assert.equal(requests, used, 'a second visit makes no request');
  assert.deepEqual(again.map((entry) => entry.results[0].series_id), pages.map((entry) => entry.results[0].series_id));
  assert.equal(cache.snapshot().entries >= 3, true);
  assert.equal((await source.browseList({ page: 1, forceRefresh: true })).success, false, 'an explicit refresh against a dead source says so');
});

test('Hema: pages are cached per genre and page, and a refresh keeps the genre list', async () => {
  const html = (data) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: data } })}</script>`;
  const calls = [];
  const axios = { get: async (url) => {
    calls.push(url);
    const page = Number(url.match(/\/browse\/[\d-]+\/(\d+)$/)?.[1]) || 1;
    const bookList = [{ bookId: String(41000000000 + page), bookName: `河马${page}`, coverWap: 'https://img.example/h.jpg', totalChapterNum: '60', bookTypeThree: [] }];
    return { data: html({ page, typeThreeId: url.includes('/browse/1129') ? '1129' : '0', bookList, typeThreeList: [{ typeThreeIds: [1129], name: '都市' }] }) + `<a href="/browse/${url.includes('/browse/1129') ? '1129' : '0'}/${page + 1}">next</a>` };
  } };
  const { source } = load('hema.js', axios);
  const first = await source.browseList({ page: 1 });
  assert.equal(first.success, true);
  assert.equal(first.genres.length, 1);
  const used = calls.length;
  const second = await source.browseList({ page: 1 });
  assert.equal(second.fromCache, true);
  assert.equal(calls.length, used);
  assert.equal((await source.browseList({ genre: '1129', page: 1 })).genres.length, 1, 'genres come from the saved list');
});
