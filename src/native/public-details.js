const axios = require('axios');
const { readRouterData, publicMetadata } = require('./catalog');
const SITE = 'https://hongguoduanju.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const cache = new Map();
const pending = new Map();
let publicLane = Promise.resolve();
const EPISODE_REVIEW_TTL = 5 * 60 * 1000;
const SERIES_TTL = 30 * 1000;

function enqueuePublic(task) {
  const run = publicLane.then(task, task);
  publicLane = run.then(() => {}, () => {});
  return run;
}

function publicFailure(error) {
  const status = Number(error?.response?.status);
  const timedOut = ['ECONNABORTED', 'ERR_CANCELED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ERR_NETWORK'].includes(error?.code)
    || error?.name === 'TimeoutError';
  const retryable = timedOut || !error?.response || status === 429 || status === 403 || status >= 500;
  const message = timedOut ? '公开评论加载超时，请重试'
    : error?.response ? `公开评论加载失败（HTTP ${Number.isInteger(status) ? status : '错误'}）`
      : (typeof error?.message === 'string' && error.message ? error.message : '公开评论加载失败，请重试');
  return { retryable, message, status: Number.isInteger(status) ? status : 0 };
}
const count = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

function reviews(value) {
  return { total: count(value?.total_count), items: (Array.isArray(value?.reviews) ? value.reviews : [])
    .filter(item => typeof item?.content === 'string' && item.content.trim()).slice(0, 50).map(item => {
      const created = count(item.create_time);
      return { author: typeof item.user_name === 'string' ? item.user_name.slice(0, 200) : '',
        avatar: typeof item.user_avatar === 'string' && /^https?:\/\//i.test(item.user_avatar) ? item.user_avatar.slice(0, 4096) : '',
        content: item.content.slice(0, 20000), created_at: created ? created * (created < 1e12 ? 1000 : 1) : null,
        likes: count(item.digg_count), rating: count(item.rating) };
    }) };
}

function parsePublicDetails(html, seriesId, vid = '') {
  const router = readRouterData(html);
  const data = Object.values(router.loaderData || {}).find(value => value?.seriesDetail && value.isSuccess !== false);
  if (!data) throw new Error('来源页面未返回公开剧集信息');
  if (String(data.seriesDetail.series_id) !== seriesId) throw new Error('来源页面剧集不匹配');
  if (vid && String(data.vid) !== vid) throw new Error('来源页面分集不匹配');
  const social = data.seriesSocialInfo || {};
  return { success: true, series_id: seriesId, episode_id: vid || null,
    ...publicMetadata(data.seriesDetail), rating: count(social.rating), rating_count: count(social.rating_count),
    like_count: count(social.series_like_count), favorite_count: count(social.series_favorite_count),
    reviews: reviews(social.reviews), episode_reviews: vid ? reviews(data.episodeSocialInfo?.reviews) : null,
    episode_like_count: vid ? count(data.episodeSocialInfo?.episode_like_count) : null,
    sourceUrl: vid ? `${SITE}/player/${seriesId}/${vid}` : `${SITE}/detail?series_id=${seriesId}` };
}

async function fetchPublicDetails(seriesId, vid = '') {
  seriesId = String(seriesId || '');
  vid = String(vid || '');
  if (!/^\d{6,30}$/.test(seriesId) || (vid && !/^\d{6,30}$/.test(vid))) return { success: false, retryable: false, error: '仅支持有效的红果剧集和分集编号' };
  const url = vid ? `${SITE}/player/${seriesId}/${vid}` : `${SITE}/detail?series_id=${seriesId}`;
  if (cache.get(url)?.expires > Date.now()) return cache.get(url).data;
  if (pending.has(url)) return pending.get(url);
  // 同一时间只打一页公开页。当前集和下一集预载排队，避免连点时被来源挡住。
  const request = enqueuePublic(async () => {
    try {
      // Axios defaults preserve the app's configured proxy; no cookies or account headers are added.
      const response = await axios.get(url, { timeout: 10000, signal: AbortSignal.timeout(10000),
        maxRedirects: 0, responseType: 'text', maxContentLength: 8 * 1024 * 1024,
        headers: { 'User-Agent': UA, Referer: `${SITE}/` } });
      const data = parsePublicDetails(response.data, seriesId, vid);
      const ttl = vid ? (data.episode_reviews?.items?.length ? EPISODE_REVIEW_TTL : 0) : SERIES_TTL;
      if (ttl) {
        cache.set(url, { expires: Date.now() + ttl, data });
        if (cache.size > 64) cache.delete(cache.keys().next().value);
      }
      return data;
    } catch (error) {
      const failure = publicFailure(error);
      return { success: false, retryable: failure.retryable, status: failure.status, sourceUrl: url, error: failure.message };
    } finally { pending.delete(url); }
  });
  pending.set(url, request);
  return request;
}

const ratingCache = new Map();
let ratingActive = 0;
const ratingWait = [];

function withRatingSlot(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      ratingActive += 1;
      task().then(resolve, reject).finally(() => {
        ratingActive -= 1;
        const next = ratingWait.shift();
        if (next) next();
      });
    };
    if (ratingActive < 4) run();
    else ratingWait.push(run);
  });
}

async function loadPublicRating(id) {
  const cached = ratingCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.rating;
  let rating = null;
  let ttl = 60 * 1000;
  try {
    const html = await require('./hongguo').fetchSiteHtml(`${SITE}/detail?series_id=${id}`, 8000);
    rating = parsePublicDetails(html, id).rating;
    if (rating != null) ttl = 10 * 60 * 1000;
  } catch { rating = null; }
  ratingCache.set(id, { rating, expires: Date.now() + ttl });
  if (ratingCache.size > 240) ratingCache.delete(ratingCache.keys().next().value);
  return rating;
}

async function fetchPublicRatings(ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '')))]
    .filter(id => /^\d{6,30}$/.test(id)).slice(0, 24);
  const ratings = {};
  await Promise.all(unique.map(id => withRatingSlot(async () => { ratings[id] = await loadPublicRating(id); })));
  return { success: true, ratings };
}

module.exports = { fetchPublicDetails, parsePublicDetails, fetchPublicRatings };
