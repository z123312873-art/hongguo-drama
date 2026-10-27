// Hongguo search: App signed search and the public JSON API run together.
// The hidden page sniff is only a fallback when the public API shape changes.
const { searchHongguo, HongguoSearchError } = require('./hongguo-search');
const { searchApp } = require('./hongguo-app-search');
const { searchNewReleasesDetailed } = require('./hongguo-app-new');
const { toSimplified } = require('./script-query');

const WEB_BUDGET_MS = 8000;
const APP_BUDGET_MS = 4000;
const APP_GRACE_MS = 300;

function pack(value, channel) {
  return {
    success: true,
    results: value?.results || [],
    page: value?.page || 1,
    total: value?.total || (value?.results || []).length,
    totalPages: value?.totalPages || 0,
    hasMore: value?.hasMore === true,
    keyword: value?.keyword || '',
    channel: channel || value?.channel || 'web',
  };
}

function mergeResults(primary, extra) {
  const seen = new Set();
  const results = [];
  for (const item of [...(primary || []), ...(extra || [])]) {
    const id = String(item?.series_id || '');
    if (!id || !item?.series_title || seen.has(id)) continue;
    seen.add(id);
    results.push(item);
  }
  return results;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function comparableTitle(value) {
  return String(value || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
}

async function addNewReleases(query, results, deadline, now, searchNew) {
  const wanted = comparableTitle(query);
  if (wanted.length < 2 || results.some(item => comparableTitle(item.series_title) === wanted)) return results;
  if (deadline - now() < 900) return results;
  try {
    const detailed = await searchNew(query, {
      deadline: Math.min(deadline, now() + (results.length ? 2500 : 8000)),
    });
    const extras = Array.isArray(detailed?.results) ? detailed.results : Array.isArray(detailed) ? detailed : [];
    return mergeResults(results, extras);
  } catch (_) {
    return results;
  }
}

function settledWeb(query, searchWeb, deadline, now) {
  return searchWeb(query, { deadline, timeout: Math.max(1000, deadline - now()), retries: 0 }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: error instanceof HongguoSearchError ? error : new HongguoSearchError(error?.message || '搜索暂不可用', 'upstream', { cause: error }) }),
  );
}

async function searchHongguoCatalog(keyword, { sniff, searchWeb = searchHongguo, searchSigned = searchApp, searchNew = searchNewReleasesDetailed, now = Date.now } = {}) {
  const typed = String(keyword || '').trim();
  const query = toSimplified(typed).trim();
  if (!query || query.length > 200) return { success: false, results: [], error: '请输入 1 至 200 字的搜索词' };
  const started = now();
  const deadline = started + WEB_BUDGET_MS;
  const webPromise = settledWeb(query, searchWeb, deadline, now);
  const appPromise = query.length <= 80
    ? searchSigned(query, { deadline: started + APP_BUDGET_MS }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    : Promise.resolve({ ok: false, error: null });
  const first = await Promise.race([
    webPromise.then((result) => ({ kind: 'web', result })),
    appPromise.then((result) => ({ kind: 'app', result })),
  ]);
  const firstHasRows = first.result.ok && first.result.value?.results?.length;
  const second = firstHasRows
    ? await Promise.race([first.kind === 'web' ? appPromise : webPromise, delay(APP_GRACE_MS).then(() => null)])
    : await (first.kind === 'web' ? appPromise : webPromise);
  const web = first.kind === 'web' ? first.result : second;
  const app = first.kind === 'app' ? first.result : second;
  let results = mergeResults(web?.ok ? web.value.results : [], app?.ok ? app.value.results : []);
  if (!results.length && query !== typed && deadline - now() > 1000) {
    const original = await settledWeb(typed, searchWeb, deadline, now);
    if (original.ok) results = mergeResults(results, original.value.results);
  }
  if (results.length || web?.ok) {
    results = await addNewReleases(query, results, deadline, now, searchNew);
    const channel = web?.ok && web.value.results?.length ? 'web' : 'app';
    return { ...pack(web?.ok ? web.value : { results, keyword: query }, channel), results, keyword: query };
  }
  const webError = web?.error;
  if (webError?.fallback && typeof sniff === 'function') {
    try { return await sniff(query); }
    catch (error) { return { success: false, results: [], error: error?.message || webError.message }; }
  }
  return { success: false, results: [], error: webError?.message || app?.error?.message || '搜索暂不可用' };
}

module.exports = { searchHongguoCatalog, mergeResults, WEB_BUDGET_MS, APP_BUDGET_MS };
