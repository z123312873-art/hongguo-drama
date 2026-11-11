

const { signedMetadataRequest, parseSearchInteger, requestJson } = require('./app-source');
const { cleanTitle } = require('./hongguo-app-search');
const { catalogCover } = require('./hongguo-app-search');

const CATEGORY_API = '/reading/distribution/category/landpage/v/';
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 1000;
const PAGE_LIMIT = 50;

const DEFAULT_PAGES = 4;
const CATEGORY_HOSTS = Object.freeze(['api5-normal-hl.fqnovel.com', 'api5-normal-lf.fqnovel.com', 'api5-normal-sinfonlineb.fqnovel.com']);
const MAX_RESULTS = 20;
const PREMIERE_LABEL = /^(?:红果首发|紅果首發)$/;

const GENRES = [
  { reqScene: 'default', genre: 'short_play' },
  { reqScene: 'ai_series', genre: 'ai_series' },
];

let cache = null;
let inflight = null;
let premiereMemo = { expires: 0, ids: new Set() };
let premiereCooldownUntil = 0;

function appError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizeTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function newReleaseFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.series_id ?? '');
  if (!/^\d{1,30}$/.test(id)) return null;
  const title = cleanTitle(row.title || row.series_title || row.series_name);
  if (!title) return null;
  const labels = [];
  const addLabel = (value) => {
    const text = cleanTitle(value);
    if (text && !labels.includes(text)) labels.push(text);
  };

  addLabel(row.tag_info?.text);
  for (const item of Array.isArray(row.sub_title_list) ? row.sub_title_list : []) addLabel(item?.content);
  const releasedToday = labels.includes('今日上新');
  const premiere = labels.some(label => PREMIERE_LABEL.test(label));
  return {
    series_id: id,
    series_title: title,
    cover: catalogCover(row.cover),
    episode_count: parseSearchInteger(row.episode_cnt) || 0,
    description: cleanTitle(row.video_desc || row.series_intro),
    tags: labels.filter(label => label !== '新剧' && label !== '今日上新' && !PREMIERE_LABEL.test(label)).slice(0, 4),
    new_release: true,
    is_premiere: premiere,
    ...(releasedToday ? { released_today: true } : {}),
    source: 'hongguo',
    url: `https://hongguoduanju.com/detail?series_id=${id}`,
  };
}

function collectRows(rows) {
  const seen = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const item = newReleaseFromRow(row);
    if (!item) continue;
    const existing = seen.get(item.series_id);
    if (!existing) { seen.set(item.series_id, item); continue; }

    existing.released_today = existing.released_today || item.released_today;
    existing.is_premiere = existing.is_premiere === true || item.is_premiere === true;
    existing.tags = [...new Set([...existing.tags, ...item.tags])].slice(0, 4);
    if (!existing.cover) existing.cover = item.cover;
    if (!existing.description) existing.description = item.description;
    if (!existing.episode_count) existing.episode_count = item.episode_count;
  }
  return [...seen.values()];
}

async function defaultRequest(signed, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  try {
    return await requestJson(signed.url, { method: 'POST', headers: signed.headers, data: signed.body },
      deadline, AbortSignal.timeout(remaining));
  } catch (error) {
    if (error.code === 'ETIMEDOUT' || error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw appError('App 上新请求超时', 'APP_TIMEOUT');
    }
    if (/未返回有效数据|空响应/i.test(error.message || '')) throw appError('App 上新返回空响应', 'APP_EMPTY');
    throw appError(error.message || 'App 上新请求失败', error.code || 'APP_NETWORK');
  }
}

function pageBody({ reqScene, genre }, offset, sessionId) {
  return {
    filter_ids: '',
    req_scene: reqScene,
    offset,
    need_selector_panel: false,
    limit: PAGE_LIMIT,
    select_items: {
      genre: [genre],
      sort: ['online_time'],
      category_dim_theme: [],
      category_dim_role: [],
      category_dim_epoch: [],
      gender: [],
      online_time: ['days_7'],
      creation_status: [],
    },
    session_id: sessionId,
    req_type: offset ? 'only_content' : 'default',
    client_req_type: 3,
  };
}

async function fetchGenre(config, { pages, deadline, request }) {
  const rows = [];
  let offset = 0, sessionId = '';
  for (let page = 1; page <= pages; page++) {
    if (Date.now() >= deadline) break;
    let payload;
    let lastError;
    for (const host of CATEGORY_HOSTS) {
      try {
        const signed = signedMetadataRequest(CATEGORY_API, {}, pageBody(config, offset, sessionId), { host });
        payload = await request(signed, deadline);
        lastError = null;
        break;
      } catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    if (!payload || typeof payload !== 'object') throw appError('App 上新返回空响应', 'APP_EMPTY');
    if (Number(payload.code ?? 0) !== 0) throw appError('App 上新服务暂不可用', 'APP_BUSINESS');
    const data = payload.data;
    if (!data || !Array.isArray(data.video_data)) throw appError('App 上新数据结构异常', 'APP_SCHEMA');
    rows.push(...data.video_data);
    if (data.has_more !== true) break;
    const next = parseSearchInteger(data.next_offset);

    if (next === null || next <= offset) break;
    offset = next;
    sessionId = String(data.session_id || '');
  }

  if (!rows.length && Date.now() >= deadline) throw appError('App 上新请求超时', 'APP_TIMEOUT');
  return rows;
}

function cachedItems(pages) {
  return cache && cache.expires > Date.now() && cache.pages >= pages ? cache.items : null;
}





async function listNewReleases(options = {}) {
  const { pages = DEFAULT_PAGES, deadline = 0, request = defaultRequest, useCache = true } = options || {};
  const count = Math.max(1, Math.min(8, Number(pages) || DEFAULT_PAGES));
  const cached = useCache ? cachedItems(count) : null;
  if (cached) {
    if (!premiereReady()) rememberPremieres(cached, Math.max(1, cache.expires - Date.now()));
    return { items: cached, cached: true, partial: false };
  }
  if (inflight && inflight.pages >= count) return inflight.task;
  const budget = Number(deadline) > 0 ? deadline : Date.now() + REQUEST_TIMEOUT_MS;
  if (budget <= Date.now()) throw appError('App 上新请求超时', 'APP_TIMEOUT');
  const task = (async () => {
    const settled = await Promise.allSettled(GENRES.map(config => fetchGenre(config, { pages: count, deadline: budget, request })));
    const rows = [], failures = [];
    for (const entry of settled) {
      if (entry.status === 'fulfilled') rows.push(...entry.value);
      else failures.push(entry.reason);
    }
    const items = collectRows(rows);
    if (!items.length && failures.length) {
      premiereCooldownUntil = Date.now() + 15 * 1000;
      throw failures[0];
    }
    const result = { items, cached: false, partial: failures.length > 0 };

    if (result.partial === false && items.length) cache = { expires: Date.now() + CACHE_TTL_MS, pages: count, items };

    if (result.partial === false) rememberPremieres(items, CACHE_TTL_MS);
    else if (items.length) rememberPremieres(items, 15 * 1000);
    return result;
  })();
  inflight = { pages: count, task };
  task.finally(() => { if (inflight?.task === task) inflight = null; }).catch(() => {});
  return task;
}





function matchNewReleases(items, keyword) {
  const query = normalizeTitle(keyword);
  if (query.length < 2 || !Array.isArray(items)) return [];
  const matches = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const title = normalizeTitle(item.series_title);
    if (!title) continue;
    let score = -1;
    if (title === query) score = 0;
    else if (title.includes(query)) score = 1;
    else if (title.length >= 2 && query.includes(title)) score = 2;
    if (score >= 0) matches.push({ item, score });
  }
  return matches.sort((a, b) => a.score - b.score
    || Number(!!b.item.released_today) - Number(!!a.item.released_today))
    .map(entry => entry.item).slice(0, MAX_RESULTS);
}

async function searchNewReleasesDetailed(keyword, options = {}) {
  const list = await listNewReleases(options);
  return {
    results: matchNewReleases(list.items, keyword),
    partial: list.partial === true,
    cached: list.cached === true,
  };
}

async function searchNewReleases(keyword, options = {}) {
  return (await searchNewReleasesDetailed(keyword, options)).results;
}

function rememberPremieres(items, ttl) {
  const ids = new Set();
  for (const item of items || []) {
    if (item?.is_premiere === true) ids.add(String(item.series_id));
  }
  premiereMemo = { expires: Date.now() + ttl, ids };
}

function premiereReady() {
  return premiereMemo.expires > Date.now();
}

function premiereIds() {
  return premiereReady() ? premiereMemo.ids : new Set();
}


function warmNewReleases() {
  if (premiereReady() || Date.now() < premiereCooldownUntil) return Promise.resolve();
  return listNewReleases().then(() => undefined, () => undefined);
}

function clearNewReleaseCache() {
  cache = null;
  inflight = null;
  premiereMemo = { expires: 0, ids: new Set() };
  premiereCooldownUntil = 0;
}

module.exports = {
  listNewReleases,
  searchNewReleases,
  searchNewReleasesDetailed,
  matchNewReleases,
  newReleaseFromRow,
  collectRows,
  normalizeTitle,
  clearNewReleaseCache,
  premiereIds,
  premiereReady,
  warmNewReleases,
  CACHE_TTL_MS,
  DEFAULT_PAGES,
  MAX_RESULTS,
};
