const assert = require('node:assert/strict');
const test = require('node:test');
const { resetNewReleaseCooldown, searchHongguoCatalog } = require('./hongguo-catalog-search');
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
  resetNewReleaseCooldown();
  const sniffed = [];
  const changed = await searchHongguoCatalog('甲剧', {
    searchSigned: async () => { throw new Error('app down'); },
    searchWeb: async () => { throw new HongguoSearchError('搜索返回异常数据', 'format', { fallback: true }); },
    searchNew: async () => ({ results: [], partial: false }),
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

test('a website outage is rescued from the new-release list and does not open the page', async () => {
  resetNewReleaseCooldown();
  let sniffed = 0;
  let supplemented = 0;
  const result = await searchHongguoCatalog('当天新剧', {
    searchSigned: async () => { throw new Error('app down'); },
    searchWeb: async () => { throw new HongguoSearchError('搜索服务暂不可用（HTTP 503）', 'upstream'); },
    searchNew: async (keyword) => {
      supplemented += 1;
      assert.equal(keyword, '当天新剧');
      return { results: [row('9', '当天新剧')], partial: false };
    },
    sniff: async () => { sniffed += 1; throw new Error('sniff must not run'); },
  });
  assert.equal(supplemented, 1);
  assert.equal(sniffed, 0);
  assert.equal(result.success, true);
  assert.equal(result.results[0].series_id, '9');
  assert.equal(result.partial, true);
  assert.match(result.error, /503/);
  assert.match(result.error, /上新补搜结果/);
});

test('a website outage with no new release stays a failure and does not sniff', async () => {
  resetNewReleaseCooldown();
  let supplemented = 0;
  const result = await searchHongguoCatalog('没有新剧', {
    searchSigned: async () => { throw new Error('app down'); },
    searchWeb: async () => { throw new HongguoSearchError('搜索服务暂不可用（HTTP 502）', 'upstream'); },
    searchNew: async () => { supplemented += 1; throw new Error('上新目录超时'); },
    sniff: async () => { throw new Error('sniff must not run'); },
  });
  assert.equal(supplemented, 1);
  assert.equal(result.success, false);
  assert.match(result.error, /502/);
  assert.match(result.error, /上新目录超时/);
  const cooled = await searchHongguoCatalog('没有新剧', {
    searchSigned: async () => { throw new Error('app down'); },
    searchWeb: async () => { throw new HongguoSearchError('搜索服务暂不可用（HTTP 502）', 'upstream'); },
    searchNew: async () => { supplemented += 1; return { results: [row('8', '没有新剧')] }; },
    sniff: async () => { throw new Error('sniff must not run'); },
  });
  assert.equal(supplemented, 1, 'a failed supplement waits before trying the new-release list again');
  assert.equal(cooled.success, false);
  resetNewReleaseCooldown();
});

test('a one-character website failure does not ask the new-release list', async () => {
  resetNewReleaseCooldown();
  let supplemented = 0;
  const result = await searchHongguoCatalog('剧', {
    searchSigned: async () => { throw new Error('app down'); },
    searchWeb: async () => { throw new HongguoSearchError('搜索服务暂不可用（HTTP 503）', 'upstream'); },
    searchNew: async () => { supplemented += 1; return { results: [] }; },
    sniff: async () => { throw new Error('sniff must not run'); },
  });
  assert.equal(supplemented, 0);
  assert.equal(result.success, false);
  assert.match(result.error, /503/);
});

test('a search timeout does not ask the new-release list', async () => {
  resetNewReleaseCooldown();
  let supplemented = 0;
  const result = await searchHongguoCatalog('超时剧', {
    searchSigned: async () => { throw new Error('app down'); },
    searchWeb: async () => { throw new HongguoSearchError('搜索超时，请稍后重试', 'timeout'); },
    searchNew: async () => { supplemented += 1; return { results: [row('7', '超时剧')] }; },
    sniff: async () => { throw new Error('sniff must not run'); },
  });
  assert.equal(supplemented, 0);
  assert.equal(result.success, false);
  assert.match(result.error, /超时/);
});

test('a longer old title does not hide an exact new release from the supplement', async () => {
  const result = await searchHongguoCatalog('接班', {
    searchSigned: async () => ({ success: true, results: [], page: 1 }),
    searchWeb: async () => ({ results: [row('1', '接班人的考题')], page: 1, total: 1, hasMore: false }),
    searchNew: async (keyword) => {
      assert.equal(keyword, '接班');
      return { results: [row('2', '接班')], partial: false };
    },
    sniff: async () => { throw new Error('sniff must not run'); },
  });
  assert.deepEqual(result.results.map(item => item.series_id), ['1', '2']);
});

test('a cooled new-release skip does not mark a finished search incomplete', async () => {
  resetNewReleaseCooldown();
  await searchHongguoCatalog('没有新剧', {
    searchSigned: async () => { throw new Error('app down'); },
    searchWeb: async () => { throw new HongguoSearchError('搜索服务暂不可用（HTTP 502）', 'upstream'); },
    searchNew: async () => { throw new Error('上新目录超时'); },
    sniff: async () => { throw new Error('sniff must not run'); },
  });
  let supplemented = 0;
  const result = await searchHongguoCatalog('春日来信第二季', {
    searchSigned: async () => ({ results: [] }),
    searchWeb: async () => ({ results: [row('3', '春日来信')], page: 1, total: 1, hasMore: false }),
    searchNew: async () => { supplemented += 1; throw new Error('must not run during cooldown'); },
    sniff: async () => { throw new Error('sniff must not run'); },
  });
  assert.equal(supplemented, 0);
  assert.equal(result.success, true);
  assert.notEqual(result.partial, true);
  assert.equal(result.results[0].series_id, '3');
  resetNewReleaseCooldown();
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
