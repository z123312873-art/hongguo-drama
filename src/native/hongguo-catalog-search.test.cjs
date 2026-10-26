const assert = require('node:assert/strict');
const test = require('node:test');
const { searchHongguoCatalog } = require('./hongguo-catalog-search');
const { HongguoSearchError } = require('./hongguo-search');

const row = (id, title) => ({ series_id: id, series_title: title, cover: '', episode_count: 1 });

test('a fast app result does not wait for a slow website search', async () => {
  let webStarted = false;
  const started = Date.now();
  const result = await searchHongguoCatalog('测试短剧', {
    searchSigned: async (keyword) => {
      assert.equal(keyword, '测试短剧');
      return { success: true, results: [row('123456', '测试短剧')], page: 1, channel: 'app' };
    },
    searchWeb: async () => {
      webStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { results: [row('999999', '晚到的剧')] };
    },
    sniff: async () => { throw new Error('sniff must not run'); },
  });
  assert.equal(result.success, true);
  assert.equal(result.results[0].series_id, '123456');
  assert.ok(Date.now() - started < 1000, 'search returned before the slow website call');
  assert.equal(webStarted, true);
});

test('traditional input is converted before either search and empty website can use the app', async () => {
  const seen = [];
  const result = await searchHongguoCatalog('從雜役到符仙人', {
    searchSigned: async (keyword) => {
      seen.push(['app', keyword]);
      return { success: true, results: [row('21', '从杂役到符仙人')], page: 1 };
    },
    searchWeb: async (keyword) => {
      seen.push(['web', keyword]);
      return { results: [] };
    },
  });
  assert.deepEqual(seen[0][1], '从杂役到符仙人');
  assert.ok(seen.every(([, keyword]) => keyword === '从杂役到符仙人' || keyword === '從雜役到符仙人'));
  assert.equal(result.results[0].series_title, '从杂役到符仙人');
});

test('a changed website payload falls back to one sniff and other failures do not', async () => {
  const sniffed = [];
  const changed = await searchHongguoCatalog('甲剧', {
    searchSigned: async () => { throw new Error('app down'); },
    searchWeb: async () => { throw new HongguoSearchError('搜索返回异常数据', 'format', { fallback: true }); },
    sniff: async (keyword) => { sniffed.push(keyword); return { success: true, results: [row('1', '甲剧')] }; },
  });
  assert.deepEqual(sniffed, ['甲剧']);
  assert.equal(changed.results[0].series_id, '1');
  const timeout = await searchHongguoCatalog('甲剧', {
    searchSigned: async () => { throw new Error('app down'); },
    searchWeb: async () => { throw new HongguoSearchError('搜索超时，请稍后重试', 'timeout'); },
    sniff: async () => { throw new Error('sniff must not run after a timeout'); },
  });
  assert.equal(timeout.success, false);
  assert.match(timeout.error, /超时/);
});

test('blank and oversized queries fail before any request', async () => {
  let calls = 0;
  const search = async () => { calls++; return { results: [] }; };
  const blank = await searchHongguoCatalog('   ', { searchWeb: search, searchSigned: search });
  const long = await searchHongguoCatalog('剧'.repeat(201), { searchWeb: search, searchSigned: search });
  assert.equal(blank.success, false);
  assert.equal(long.success, false);
  assert.equal(calls, 0);
});
