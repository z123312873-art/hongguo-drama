const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { readPublicScore } = require('../src/native/public-score');
const { rememberWebEpisodes, takeWebEpisodes, clearWebEpisodes } = require('../src/native/episode-prelude');

const nativeDir = path.join(__dirname, '../src/native');
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.stack); }
}

function load(file, dependencies, extras = {}) {
  const context = { Buffer, URL, URLSearchParams, AbortSignal, AbortController, process: { env: {} }, module: { exports: {} },
    console: { warn() {}, log() {} }, setTimeout, clearTimeout, ...extras,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name.startsWith('.') ? path.join(nativeDir, name) : name) };
  vm.runInNewContext(fs.readFileSync(path.join(nativeDir, file), 'utf8'), context, { filename: path.join(nativeDir, file) });
  return context.module.exports;
}

function metering(text, size = 4096) {
  let sent = 0;
  const stream = new Readable({
    read() {
      if (sent >= text.length) { this.push(null); return; }
      const next = text.slice(sent, sent + size);
      sent += next.length;
      this.push(next);
    },
  });
  return { stream, sent: () => sent };
}

(async () => {
  await check('public score reads the hero number and ignores heat', () => {
    assert.equal(readPublicScore('评分<!-- -->9.1</span>'), 9.1);
    assert.equal(readPublicScore('"hot_score_data":{"score":60634645,"text":"6063万热度"}'), null);
    assert.equal(readPublicScore('热度6063万评分<!-- -->8.6</span>"hot_score_data":{"score":1}'), 8.6);
    assert.equal(readPublicScore('评分2024年"seriesSocialInfo":{"rating":7.4,"series_like_count":"1"}'), 7.4);
    assert.equal(readPublicScore('"seriesSocialInfo":{"rating":0}'), null);
    assert.equal(readPublicScore('"seriesSocialInfo":{"rating":11}'), null);
    assert.equal(readPublicScore('评分9', { partial: true }), null);
    assert.equal(readPublicScore('评分9.1</span>', { partial: true }), 9.1);
    assert.equal(readPublicScore('"seriesSocialInfo":{"hot_score_data":{"score":45524479,"text":"4552万热度"},"rating":8.4,"reviews":{"reviews":[{"rating":10}]}}'), 8.4);
    assert.equal(readPublicScore('"seriesSocialInfo":{"hot_score_data":{"rating":9.9},"rating":8.2}'), 8.2);
    assert.equal(readPublicScore('"seriesSocialInfo":{"series_like_count":"29000","hot_score_data":{"score":45524479,"text":"4552万热度"},"reviews":{"total_count":"98","reviews":[{"rating":10}]}}'), null);
    assert.equal(readPublicScore('"seriesSocialInfo":{"rating":"7.5","series_like_count":"1"}'), 7.5);
    assert.equal(readPublicScore('"seriesSocialInfo":{"series_like_count":"1","hot_score_', { partial: true }), null);
    assert.equal(readPublicScore('"seriesSocialInfo":{"rating":8.2', { partial: true }), null);
    assert.equal(readPublicScore('"seriesSocialInfo":{"rating":8.2'), 8.2);
  });

  await check('only a complete catalog episode list can skip the detail request', async () => {
    clearWebEpisodes();
    assert.equal(rememberWebEpisodes('1234567', { episode_cnt: 60, vid_list: ['100001', '100002', '100003'], series_name: '片段' }), false);
    assert.equal(takeWebEpisodes('1234567'), null);
    assert.equal(rememberWebEpisodes('1234567', { episode_cnt: 2, vid_list: ['100001', '100001'], series_name: '重复' }), false);
    assert.equal(rememberWebEpisodes('11', { episode_cnt: 1, vid_list: ['100001'], series_name: '过短' }), false);
    assert.equal(rememberWebEpisodes('1234567', {
      episode_cnt: 2, vid_list: ['100001', '100002'], accessible_episode_cnt: 1,
      series_name: '完整', series_cover: 'https://img.example/a.jpg',
    }), true);
    const taken = takeWebEpisodes('1234567');
    assert.equal(taken.total, 2);
    assert.equal(taken.episodes[1].web_available, false);
    assert.equal(taken.episodes[0].series_title, '完整');
    const catalog = load('catalog.js', { electron: { net: null }, axios: { get: async () => { throw new Error('unused'); } } });
    const html = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: { cat: {
      isSuccess: true, categoryRoute: { contentType: 'real-drama' }, recommendList: [
        { series_id: '2234567', series_name: '目录完整', episode_cnt: 2, vid_list: ['200001', '200002'], accessible_episode_cnt: 2, series_cover: '', tags: [] },
        { series_id: '3234567', series_name: '目录片段', episode_cnt: 60, vid_list: ['300001', '300002', '300003'], tags: [] },
      ], pagination: { pageNum: 1, total: 2, totalPages: 1 }, selectorList: [],
    } } })}</script>`;
    const parsed = catalog.parseCatalog(html, 'real-drama', 1, 'https://hongguoduanju.com/category/real-drama');
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.results[0].rating, null);
    assert.equal(takeWebEpisodes('2234567').total, 2);
    assert.equal(takeWebEpisodes('3234567'), null);
    let gets = 0;
    const native = load('hongguo.js', { axios: { get: async () => { gets++; return { data: '<html></html>' }; } } });
    const reused = await native.fetchEpisodeListFromWeb('2234567');
    assert.equal(gets, 0, 'a full catalog list must not download the detail page again');
    assert.equal(reused.episodes.map(item => item.vid).join(','), '200001,200002');
    await assert.rejects(native.fetchEpisodeListFromWeb('3234567'));
    assert.equal(gets, 2, 'a short list still tries the detail page and the player page');
    clearWebEpisodes();
  });

  await check('score fetch stops at the hero number, retries one server error, and does not retry a timeout', async () => {
    const prefix = `${'a'.repeat(50000)}评分<!-- -->8.6</span>`;
    const text = prefix + 'b'.repeat(400000);
    const meter = metering(text);
    let calls = 0;
    const native = load('hongguo.js', { axios: { get: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('busy'), { response: { status: 500 } });
      return { data: meter.stream };
    } } });
    assert.equal(await native.fetchPublicScore('nope'), null);
    assert.equal(calls, 0, 'invalid ids do not hit the source');
    assert.equal(await native.fetchPublicScore('1234567'), 8.6);
    assert.equal(calls, 2, 'HTTP 500 is retried once');
    assert.ok(meter.sent() < 120000, `score read should stop early, sent ${meter.sent()}`);
    calls = 0;
    const timed = load('hongguo.js', { axios: { get: async () => {
      calls++;
      throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    } } });
    await assert.rejects(timed.fetchPublicScore('1234567'), /timeout/);
    assert.equal(calls, 1, 'timeouts are not retried');
    const plain = load('hongguo.js', { axios: { get: async () => ({ data: '评分<!-- -->7.2</span>' }) } });
    assert.equal(await plain.fetchPublicScore('1234567'), 7.2);
  });

  await check('a fast episode page does not open the hedge round', async () => {
    let gets = 0;
    const html = `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
      detail_page: { isSuccess: true, seriesDetail: { series_id: '1234567', series_name: '甲', vid_list: ['100001', '100002'] } },
    } })}</script>`;
    const native = load('hongguo.js', { axios: { get: async (_url, options) => {
      gets += 1;
      assert.equal(options.timeout, 1500);
      return { data: html };
    } } });
    const list = await native.fetchEpisodeListFromWeb('1234567');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(list.total, 2);
    assert.equal(gets, 2, 'detail and player start together, and a fast result skips the later hedge');
  });

  if (failures) process.exitCode = 1;
})();
