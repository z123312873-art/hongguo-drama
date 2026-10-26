// The public website has no 系列剧 rank. The iOS app does. This list uses the
// public search corpus for that label, then keeps titles that are installments
// of a series. It is not the personalized in-app recommend order.
const { searchHongguo } = require('./hongguo-search');
const { seasonTitle } = require('./season-title');

const QUERY = '系列剧';
const cache = new Map();
const CACHE_MS = 120000;

function seriesEntries(results) {
  const rows = (results || []).map(item => ({ item, parsed: seasonTitle(item.series_title) }));
  const bases = new Map();
  for (const row of rows) bases.set(row.parsed.base, (bases.get(row.parsed.base) || 0) + 1);
  const grouped = rows.filter(row => row.parsed.explicit || bases.get(row.parsed.base) > 1).map(row => row.item);
  return grouped.length >= 4 ? grouped : rows.map(row => row.item);
}

async function browseSeriesDramas({ page = 1, forceRefresh = false } = {}) {
  const pg = Math.max(1, Math.min(50, Number.parseInt(page, 10) || 1));
  const key = String(pg);
  if (!forceRefresh && cache.get(key)?.expires > Date.now()) return cache.get(key).data;
  try {
    const found = await searchHongguo(QUERY, { page: pg, retries: 0, timeout: 8000 });
    const data = {
      success: true,
      results: seriesEntries(found.results).map(item => ({
        ...item,
        episode_count: item.episode_count || 0,
        tags: Array.isArray(item.tags) ? item.tags : [],
      })),
      page: found.page || pg,
      total: found.total || 0,
      totalPages: found.totalPages || (found.hasMore ? pg + 1 : pg),
      genres: [],
      pageTitle: '系列剧',
      sourceUrl: 'https://hongguoduanju.com/api/search/result',
    };
    cache.set(key, { expires: Date.now() + CACHE_MS, data });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return data;
  } catch (error) {
    return { success: false, error: error.message || '系列剧暂时无法加载', sourceUrl: 'https://hongguoduanju.com/api/search/result' };
  }
}

module.exports = { browseSeriesDramas, seriesEntries };
