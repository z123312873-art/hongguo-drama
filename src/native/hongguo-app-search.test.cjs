const assert = require('node:assert/strict');
const test = require('node:test');
const { searchApp, parseSearchPayload } = require('./hongguo-app-search');
const { signedSearchRequest } = require('./app-source');

const payload = {
  code: 0,
  search_tabs: [{
    tab_type: 11, has_more: true, next_offset: 20, search_id: 'sid-1', passback: 'pb-1',
    data: [
      { book_id: '123', search_high_light: { title: { text: '测试短剧' } },
        video_data: [{ series_id: '123', title: 'ignored', cover: 'https://img.example/a.jpg', episode_cnt: 88 }] },
      { video_data: [] },
    ],
  }],
};

test('App search parses titles, ids, covers and cursors', () => {
  const result = parseSearchPayload(payload);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].series_id, '123');
  assert.equal(result.results[0].series_title, '测试短剧');
  assert.equal(result.results[0].cover, 'https://img.example/a.jpg');
  assert.equal(result.results[0].episode_count, 88);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.cursor, { search_id: 'sid-1', passback: 'pb-1', next_offset: 20 });
});

test('HEIC covers become a plain rendition and unknown HEIC hosts stay blank', () => {
  const result = parseSearchPayload({ ...payload, search_tabs: [{ ...payload.search_tabs[0], data: [
    { search_high_light: { title: { text: 'HEIC 剧' } }, video_data: [{ series_id: '456', cover: 'https://p3-reading-sign.fqnovelpic.com/novel-pic/abc~tplv-81nmtwyey9-superreso-aifit:400:0.heic?lk3s=1' }] },
    { search_high_light: { title: { text: '别站 剧' } }, video_data: [{ series_id: '457', cover: 'https://img.example/a.heic?x=1' }] },
    { search_high_light: { title: { text: '备用封面 剧' } }, video_data: [{ series_id: '458', cover: 'https://img.example/b.heic', series_cover: 'https://img.example/b.jpg' }] },
  ] }] });
  assert.equal(result.results[0].cover, 'https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image');
  assert.equal(result.results[1].cover, '');
  assert.equal(result.results[2].cover, 'https://img.example/b.jpg');
});

test('the signed request uses branch-0 search headers and carries the keyword', async () => {
  let captured;
  const result = await searchApp('测试短剧', { request: async (signed, deadline) => {
    captured = { signed, deadline };
    return payload;
  } });
  assert.equal(result.page, 1);
  assert.ok(captured.deadline > Date.now());
  assert.match(captured.signed.url, /reading\/bookapi\/search\/tab\/v\?/);
  assert.match(decodeURIComponent(captured.signed.url), /query=测试短剧/);
  assert.ok(captured.signed.headers['x-gorgon']);
  assert.ok(captured.signed.headers['x-medusa']);
  assert.equal(captured.signed.headers['content-type'], undefined);
  const direct = signedSearchRequest({ keyword: '测试短剧', page: 1 });
  assert.ok(direct.headers['x-ss-req-ticket']);
});

test('pagination requires a cursor and business/schema errors are classified', async () => {
  await assert.rejects(searchApp('测试短剧', { page: 2 }), error => error.code === 'APP_CURSOR');
  await assert.rejects(searchApp('测试短剧', { request: async () => ({ code: 7 }) }), error => error.code === 'APP_BUSINESS');
  await assert.rejects(searchApp('测试短剧', { request: async () => ({ search_tabs: [] }) }), error => error.code === 'APP_TAB_MISSING');
  await assert.rejects(searchApp('测试短剧', { request: async () => null }), error => error.code === 'APP_EMPTY');
});

test('invalid next offsets stay absent and signed requests fall back to the page offset', () => {
  for (const next_offset of [null, undefined, '', '  ', false, true, [], {}, -1, 1.5, '1.5', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const result = parseSearchPayload({ ...payload, search_tabs: [{ ...payload.search_tabs[0], next_offset }] });
    assert.equal(result.cursor.next_offset, null, `invalid offset: ${String(next_offset)}`);
    const signed = signedSearchRequest({ keyword: '测试短剧', page: 3, cursor: { search_id: 'sid-1', next_offset } });
    assert.equal(new URL(signed.url).searchParams.get('offset'), '40');
  }
  for (const next_offset of [0, '0', 40, '40']) {
    const result = parseSearchPayload({ ...payload, search_tabs: [{ ...payload.search_tabs[0], next_offset }] });
    assert.equal(result.cursor.next_offset, Number(next_offset));
    const signed = signedSearchRequest({ keyword: '测试短剧', page: 2, cursor: result.cursor });
    assert.equal(new URL(signed.url).searchParams.get('offset'), String(next_offset));
  }
});

test('a search id without an offset still advances to later pages', async () => {
  for (const page of [2, '3']) {
    const result = await searchApp('测试短剧', { page, cursor: { search_id: 'sid-1', next_offset: null }, request: async signed => {
      assert.equal(new URL(signed.url).searchParams.get('offset'), String((Number(page) - 1) * 20));
      return payload;
    } });
    assert.equal(result.page, Number(page));
  }
  await assert.rejects(searchApp('测试短剧', { page: 2, cursor: { next_offset: -1 } }), error => error.code === 'APP_CURSOR');
});

test('invalid pages are rejected before signing or requesting', async () => {
  for (const page of [null, '', ' ', false, true, [], {}, 0, -1, 1.5, '2.5', 51, 100, Infinity, NaN, 'bad']) {
    await assert.rejects(searchApp('测试短剧', { page, cursor: { search_id: 'sid-1' }, request: async () => {
      assert.fail('invalid page must not reach the request');
    } }), error => error.code === 'APP_INPUT', `invalid page: ${String(page)}`);
    assert.throws(() => signedSearchRequest({ keyword: '测试短剧', page }), error => error.code === 'APP_INPUT');
    assert.throws(() => parseSearchPayload(payload, { page }), error => error.code === 'APP_INPUT');
  }
});

test('the final supported page does not advertise another page', async () => {
  const result = await searchApp('测试短剧', { page: 50, cursor: { search_id: 'sid-1' }, request: async signed => {
    assert.equal(new URL(signed.url).searchParams.get('offset'), '980');
    return payload;
  } });
  assert.equal(result.page, 50);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextPage, null);
});
