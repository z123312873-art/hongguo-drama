const passthroughCache = { shared: { wrap: (_name, fetcher) => fetcher, getAux: () => undefined, setAux() {} } };
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../src/native/hema.js');
const sid = 'hema:41000115014';
const vid = `${sid}:591821028`;

const detail = { bookInfoVo: { bookId: '41000115014', bookName: '出手', totalChapterNum: '74', coverWap: 'https://seoali.zqkanshu.com/cppartner/x.jpg?t=1' },
  chapterList: Array.from({ length: 74 }, (_, i) => ({ chapterId: String(591821028 + i), chapterName: `第${i + 1}集`,
    chapterIndex: i + 1, isCharge: i < 5 ? '0' : '1', ...(i < 5 ? { chapterVideoVo: {
      mp4720p: 'https://media.example/720.mp4', mp4: 'https://media.example/video.mp4', encryptUrl: 'https://media.example/forbidden' } } : {}) })) };
const list = { retCode: 0, data: { isMore: 1, totalSize: 241, bookList: [{ bookId: '41000115014',
  bookName: '<em>出手</em>', totalChapterNum: '74', coverWap: 'https://seoali.zqkanshu.com/cppartner/x.jpg?t=1', bookTypeThree: [{ id: 1, name: '都市' }] }] } };

async function check() {
  assert.ok(fs.existsSync(sourcePath), '缺少河马原生适配器');
  const requests = [];
  let failure, malformedHtml = false, expireTimer = false;
  let appMode = 'unlock';
  async function request(method, url, body, options) {
    requests.push({ method, url, body, options });
    assert.equal(new URL(url).origin, 'https://www.kuaikaw.cn');
    assert.equal(options.timeout, 10000);
    assert.equal(options.maxContentLength, 8 * 1024 * 1024);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.headers.pname, 'www.kuaikaw.cn');
    assert.equal(options.headers.Origin, 'https://www.kuaikaw.cn');
    assert.ok(!/cookie|authorization|session|token/i.test(JSON.stringify(options.headers)));
    if (expireTimer) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted'))));
    if (failure) throw failure;
    return { data: method === 'POST' ? structuredClone(list) : malformedHtml ? '<html>unavailable</html>'
      : `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: detail } })}</script>` };
  }
  const hemaApp = {
    MAX_RATE: '720P',
    pickPlayUrl: require('../src/native/hema-app').pickPlayUrl,
    async fetchDetail(bookId) {
      if (appMode === 'down') throw new Error('app down');
      return {
        bookName: '出手', coverWap: 'https://seoali.zqkanshu.com/cppartner/x.jpg?t=1',
        chapterList: detail.chapterList.map((episode, index) => ({
          chapterId: episode.chapterId, chapterIndex: episode.chapterIndex, chapterName: episode.chapterName, isCharge: 0,
        })),
        videoInfo: { bookId, bookName: '出手', coverWap: 'https://seoali.zqkanshu.com/cppartner/x.jpg?t=1' },
      };
    },
    async fetchPlay(bookId, chapterId) {
      if (appMode === 'down') throw new Error('app down');
      if (appMode === 'empty' || (appMode === 'deny' && String(chapterId) === '591821033')) {
        return { url: null, locked: true, error: '本集暂时无法取得播放地址，请稍后重试或改看其他集' };
      }
      return { url: `https://media.example/app-${chapterId}.mp4`, locked: false, rate: '720P', quality: '720p' };
    },
  };
  const context = { module: { exports: {} }, require: name => name === 'axios' ? {
    get: (url, options) => request('GET', url, null, options), post: (url, body, options) => request('POST', url, body, options),
  } : name === './browse-cache' ? passthroughCache : name === './hema-app' ? hemaApp : require(name), Buffer, URL, AbortController, setTimeout: (fn, ms) => setTimeout(fn, expireTimer ? 0 : ms), clearTimeout };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const hema = context.module.exports;
  const search = await hema.search('总裁', 2);
  assert.equal(search.success, true);
  assert.equal(search.results[0].series_id, sid);
  assert.equal(search.results[0].series_title, '出手');
  assert.equal(search.results[0].episode_count, 74);
  assert.equal(search.results[0].tags[0], '都市');
  assert.equal(search.results[0].cover, "https://seoali.zqkanshu.com/cppartner/x.jpg?t=1&x-oss-process=image/resize,w_320/quality,q_80");
  assert.equal(hema.optimizeCover(search.results[0].cover), search.results[0].cover);
  assert.equal(hema.optimizeCover("https://seoali.zqkanshu.com/a.jpg?t=9&imageView2/0/w/200/h/267"), "https://seoali.zqkanshu.com/a.jpg?t=9&x-oss-process=image/resize,w_320/quality,q_80");
  assert.equal(hema.optimizeCover("https://cdn.example/a.jpg"), "https://cdn.example/a.jpg");
  assert.equal(hema.optimizeCover("https://kyyresali.kkyd.cn/cppartner/1/41000497974.jpg?t=1794578310201&imageView2/0/w/200/h/267"), "https://kyyresali.kkyd.cn/cppartner/1/41000497974.jpg?t=1794578310201&x-oss-process=image/resize,w_320/quality,q_80", '详情与续播用的海报同样取缩图');
  assert.equal(hema.optimizeCover("https://kkyd.cn.example/a.jpg"), "https://kkyd.cn.example/a.jpg");
  assert.equal(hema.optimizeCover("http://seoali.zqkanshu.com/a.jpg"), "");
  assert.equal(search.hasMore, true);
  assert.equal(search.nextPage, 3);
  assert.equal(search.total, 241);
  list.data.isMore = 0;
  assert.equal((await hema.search('总裁')).hasMore, false);
  list.retCode = 1;
  assert.equal((await hema.search('总裁')).success, false);
  list.retCode = 0;
  const beforeBlank = requests.length;
  assert.equal((await hema.search('   ')).success, false);
  assert.equal(requests.length, beforeBlank);

  const episodes = await hema.fetchEpisodeList(sid);
  assert.equal(episodes.total, 74);
  assert.equal(episodes.episodes.filter(e => e.locked).length, 0);
  assert.equal(episodes.episodes[0].vid, vid);
  assert.equal(episodes.episodes[0].vid_index, 1);
  assert.equal(episodes.episodes[0].series_title, '出手');
  assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).url, 'https://media.example/app-591821028.mp4');
  assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).quality, '720p');
  appMode = 'deny';
  assert.equal((await hema.fetchPlayUrlSingle(`${sid}:591821033`, sid)).locked, true);
  appMode = 'empty';
  assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).url, 'https://media.example/720.mp4', 'app empty must still use web free-episode url');
  appMode = 'unlock';

  hema.clearEpisodeCache();
  appMode = 'down';
  const webEpisodes = await hema.fetchEpisodeList(sid);
  assert.equal(webEpisodes.total, 74);
  assert.equal(webEpisodes.episodes.filter(e => e.locked).length, 0);
  assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).url, 'https://media.example/720.mp4');
  const media = detail.chapterList[0].chapterVideoVo;
  delete media.mp4720p;
  assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).url, 'https://media.example/video.mp4');
  for (const invalid of ['http://media.example/video.mp4', 'https://user:pass@media.example/video.mp4', 'file:///tmp/video.mp4', '']) {
    media.mp4 = invalid;
    assert.equal((await hema.fetchPlayUrlSingle(vid, sid)).url, null, 'must not fall back to encryptUrl');
  }
  media.mp4720p = 'https://media.example/720.mp4';
  media.mp4 = 'https://media.example/video.mp4';
  const beforeInvalid = requests.length;
  for (const invalid of ['123', 'xifan:41000115014:591821028', `${vid}:extra`, 'hema:../evil:1']) {
    assert.equal((await hema.fetchPlayUrlSingle(invalid, sid)).url, null);
  }
  for (const invalidSid of ['hema:123', 'xifan:41000115014', 'https://evil.example/']) {
    assert.equal((await hema.fetchPlayUrlSingle(vid, invalidSid)).url, null);
  }
  await assert.rejects(hema.fetchEpisodeList('hema:../evil'));
  assert.equal(requests.length, beforeInvalid, 'invalid identity must fail before network access');
  assert.equal((await hema.fetchPlayUrlSingle(`${sid}:999`, sid)).url, null);
  detail.bookInfoVo.bookId = '999';
  hema.clearEpisodeCache();
  await assert.rejects(hema.fetchEpisodeList(sid));
  detail.bookInfoVo.bookId = '41000115014';
  malformedHtml = true;
  hema.clearEpisodeCache();
  await assert.rejects(hema.fetchEpisodeList(sid));
  malformedHtml = false;
  for (const code of ['ECONNABORTED', 'ERR_BAD_RESPONSE']) {
    failure = Object.assign(Error('private response must not leak'), { code });
    const result = await hema.search('总裁');
    assert.equal(result.success, false);
    assert.ok(!result.error.includes('private'));
    if (code === 'ECONNABORTED') assert.match(result.error, /超时/);
  }
  failure = undefined;
  expireTimer = true;
  assert.match((await hema.search('总裁')).error, /超时/);
  const composed = hema.composeGenres([
    { slug: '1165', label: '女帝' }, { slug: '462', label: '甜宠' }, { slug: '1705-1712', label: '种田' },
    { slug: '1646-1650', label: '2D漫' }, { slug: '9999', label: '未归类稀有' },
  ]);
  assert.ok(composed.length >= 3 && composed.length <= 14);
  assert.ok(composed.every(item => item.slug.split('-').length <= 16));
  assert.ok(composed.some(item => item.label === '古装权谋'));
  assert.ok(composed.some(item => item.label === '甜宠情感'));
  console.log('PASS 河马访客解锁、720P 上限、复合题材、海报压缩、退路与边界');
}

async function live() {
  const hema = require('../src/native/hema');
  const search = await hema.search('总裁');
  assert.equal(search.success, true);
  assert.ok(search.results.length);
  const liveSid = search.results[0].series_id;
  const episodes = await hema.fetchEpisodeList(liveSid);
  assert.ok(episodes.total > 10);
  assert.equal(episodes.episodes.filter(e => e.locked).length, 0, '不在客户端预先锁定分集');
  const first = await hema.fetchPlayUrlSingle(episodes.episodes[0].vid, liveSid);
  assert.ok(first.url, first.error);
  const late = await hema.fetchPlayUrlSingle(episodes.episodes.at(-1).vid, liveSid);
  assert.ok(late.url || (late.locked && /解锁|付费|试看/.test(String(late.error))), '收费集要么直接给地址，要么清楚说明需解锁');
  console.log(JSON.stringify({ live: 'PASS', search: search.results.length, episodes: episodes.total, firstPlayable: !!first.url, lateUrl: !!late.url, lateError: late.error || '' }));
}

check().then(() => process.argv.includes('--live') ? live() : undefined)
  .catch(error => { console.error(error); process.exitCode = 1; });
