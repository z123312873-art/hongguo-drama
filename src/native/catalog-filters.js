const TAG_TTL = 10 * 60 * 1000;
function createCatalogFilters({ read, now = () => Date.now(), ttl = TAG_TTL }) {
  const saved = new Map(), pending = new Map();
  const cached = (key, refresh, load) => {
    if (!refresh && saved.get(key)?.until > now()) return Promise.resolve(saved.get(key).value);
    if (!pending.has(key)) pending.set(key, Promise.resolve().then(load).then(value => {
      saved.set(key, { value, until: now() + ttl });
      return value;
    }).finally(() => pending.delete(key)));
    return pending.get(key);
  };
  const mapBounded = async (rows, fn) => {
    const values = new Array(rows.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, rows.length) }, async () => {
      while (next < rows.length) { const index = next++; values[index] = await fn(rows[index]); }
    }));
    return values;
  };
  const ranking = (category, refresh) => cached(`rank:${category}`, refresh, async () => {
    const first = await read({ category, page: 1, forceRefresh: refresh });
    if (!first?.success || !Array.isArray(first.results)) throw new Error('榜單暫時無法讀取');
    const pages = Number(first.totalPages);
    if (!Number.isInteger(pages) || pages < 1 || pages > 100) throw new Error('榜單頁數尚未確認');
    const rest = await mapBounded(Array.from({ length: pages - 1 }, (_, i) => i + 2), page => read({ category, page, forceRefresh: refresh }));
    if (rest.some(page => !page?.success || !Array.isArray(page.results))) throw new Error('榜單未完整讀取，請稍後重試');
    const seen = new Set(), results = [first, ...rest].flatMap(page => page.results).filter(item => {
      if (!item?.series_id || seen.has(item.series_id)) return false;
      seen.add(item.series_id); return true;
    });
    const counts = new Map();
    for (const item of results) for (const label of new Set((item.tags || []).filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))) counts.set(label, (counts.get(label) || 0) + 1);
    const genres = [...counts].map(([label, count]) => ({ label, count, slug: `tag-${Buffer.from(label).toString('hex')}` }));
    return { results, genres, sourceUrl: first.sourceUrl };
  });
  async function genres({ category, forceRefresh = false } = {}) {
    try {
      if (String(category).startsWith('hot-')) {
        const data = await ranking(category, forceRefresh);
        return { success: true, genres: data.genres, candidates: data.genres.length, dropped: 0, unavailable: 0 };
      }
      return await cached(`tags:${category}`, forceRefresh, async () => {
        const base = await read({ category, page: 1, forceRefresh });
        if (!base?.success || !Array.isArray(base.genres)) throw new Error('分類標籤暫時無法讀取');
        const unique = new Map();
        for (const item of base.genres) if (/^[a-z0-9-]+$/.test(item?.slug) && typeof item.label === 'string' && item.label.trim() && !unique.has(item.slug)) unique.set(item.slug, item);
        const candidates = [...unique.values()];
        const checked = await mapBounded(candidates, async item => {
          try {
            const page = await read({ category, genre: item.slug, page: 1, forceRefresh });
            return !page?.success || !Array.isArray(page.results) ? { unavailable: true } : { ...item, label: item.label.trim(), count: page.results.length ? Math.max(Number(page.total) || 0, page.results.length) : 0 };
          } catch { return { unavailable: true }; }
        });
        const positive = checked.filter(item => !item.unavailable && item.count > 0);
        const valid = [...new Map(positive.map(item => [item.label, item])).values()];
        return { success: true, genres: valid, candidates: candidates.length, dropped: checked.filter(item => !item.unavailable && !item.count).length + positive.length - valid.length, unavailable: checked.filter(item => item.unavailable).length };
      });
    } catch { return { success: false, error: '分類標籤未完整確認，請稍後重試。' }; }
  }
  async function rankList({ category, genre, page = 1, forceRefresh = false }) {
    try {
      const data = await ranking(category, forceRefresh), tag = data.genres.find(item => item.slug === genre);
      if (!tag) return { success: false, error: '這個分類沒有該標籤，請重新選擇。' };
      const rows = data.results.filter(item => (item.tags || []).some(label => typeof label === 'string' && label.trim() === tag.label));
      return { success: true, results: rows.slice((page - 1) * 20, page * 20), total: rows.length, totalPages: Math.ceil(rows.length / 20), page, genres: data.genres, sourceUrl: data.sourceUrl };
    } catch { return { success: false, error: '榜單篩選未完整讀取，請稍後重試。' }; }
  }
  return { genres, rankList };
}
module.exports = { createCatalogFilters, TAG_TTL };
