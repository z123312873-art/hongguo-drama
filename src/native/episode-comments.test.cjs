const assert = require('node:assert/strict');
const axios = require('axios');
let fetchEpisodeComments;
try { ({ fetchEpisodeComments } = require('./episode-comments')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
assert.equal(typeof fetchEpisodeComments, 'function', 'episode comment contract must exist');

const seriesId = '7503745441910017049', episodeId = '7503780574541122622';
let calls = 0;
axios.get = async (url, options) => {
  calls++;
  assert.match(url, new RegExp(`^https://hongguoduanju.com/player/${seriesId}/[0-9]+$`));
  assert.equal(options.headers.Cookie, undefined);
  const review = { content: '公开评论', user_name: '测试用户', create_time: '123' };
  return { data: `window._ROUTER_DATA=${JSON.stringify({ loaderData: { player: {
    seriesDetail: { series_id: seriesId }, vid: episodeId, episodeSocialInfo: {
      reviews: { total_count: '500', reviews: [review, { ...review }, { content: '第二条' }, { content: ' ' }] },
    },
  } } })};` };
};

(async () => {
  const danmaku = require('./danmaku');
  const previousList = danmaku.fetchEpisodeCommentList;
  danmaku.fetchEpisodeCommentList = async () => ({ success: false, retryable: true, items: [], error: '本集评论接口暂时不可用，请重试' });
  for (const invalid of [null, {}, { seriesId, episodeId: '../other' }, { seriesId, episodeId, cursor: 'next' },
    { seriesId, episodeId, limit: 0 }, { seriesId, episodeId, limit: 31 }]) {
    assert.equal((await fetchEpisodeComments(invalid)).success, false);
  }
  assert.equal(calls, 0, 'invalid ids/cursors must not reach the website');
  const page = await fetchEpisodeComments({ seriesId, episodeId, cursor: null, limit: 30 });
  assert.equal(page.success, true);
  assert.equal(page.series_id, seriesId);
  assert.equal(page.episode_id, episodeId);
  assert.equal(page.items.length, 2);
  assert.equal(new Set(page.items.map(item => item.id)).size, 2);
  assert.equal(page.total, 500);
  assert.equal(page.has_more, false);
  assert.equal(page.next_cursor, null);
  assert.equal(page.source_limited, true);
  assert.match(page.notice, /部分评论/);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['content', 'id']);
  assert.deepEqual((await fetchEpisodeComments({ seriesId, episodeId })).items, page.items);
  assert.equal(calls, 1, 'reuse the existing bounded public-details cache');
  assert.equal((await fetchEpisodeComments({ seriesId, episodeId: '7503780577347128382' })).success, false,
    'a mismatched episode cannot leak the old comments');
  const beforeList = calls;
  danmaku.fetchEpisodeCommentList = async request => ({
    success: true, series_id: request.seriesId, episode_id: request.episodeId,
    items: [{ id: 'listed-comment', content: '评论列表里的内容' }], total: 40,
    next_cursor: null, has_more: false, source_limited: false, notice: '',
  });
  const listed = await fetchEpisodeComments({ seriesId, episodeId, cursor: null, limit: 23 });
  assert.equal(listed.success, true);
  assert.equal(listed.items[0].content, '评论列表里的内容');
  assert.equal(listed.total, 40);
  assert.equal(calls, beforeList, 'a successful comment list does not open the public page');
  danmaku.fetchEpisodeCommentList = async () => ({ success: false, retryable: true, items: [], error: '本集评论接口暂时不可用，请重试' });
  axios.get = async () => {
    const error = new Error('Redirect');
    error.response = { status: 302 };
    throw error;
  };
  const stillFailed = await fetchEpisodeComments({ seriesId, episodeId: '7503780574541123002', cursor: null, limit: 30 });
  assert.equal(stillFailed.success, false);
  assert.match(stillFailed.error, /暂时不可用/);
  let started = 0;
  let releaseFirst;
  const episodeHtml = id => `window._ROUTER_DATA=${JSON.stringify({ loaderData: { player: {
    seriesDetail: { series_id: seriesId }, vid: id, episodeSocialInfo: { reviews: { total_count: '1', reviews: [{ content: id, user_name: '甲', create_time: '9' }] } },
  } } })};`;
  axios.get = async url => {
    started += 1;
    const id = url.split('/').pop();
    if (started === 1) await new Promise(resolve => { releaseFirst = resolve; });
    return { data: episodeHtml(id) };
  };
  const firstId = '7503780574541122991';
  const secondId = '7503780574541122992';
  const first = fetchEpisodeComments({ seriesId, episodeId: firstId, cursor: null, limit: 30 });
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = fetchEpisodeComments({ seriesId, episodeId: secondId, cursor: null, limit: 30 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(started, 1, 'the next episode comment page waits until the current page finishes');
  releaseFirst();
  const [firstPage, secondPage] = await Promise.all([first, second]);
  assert.equal(started, 2);
  assert.equal(firstPage.items[0].content, firstId);
  assert.equal(secondPage.items[0].content, secondId);
  danmaku.fetchEpisodeCommentList = previousList;
  console.log('episode comments: validation, stable IDs, dedupe, source limits, cache and episode isolation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
