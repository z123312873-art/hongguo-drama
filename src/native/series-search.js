const { seasonTitle, sourceOf, findSequels } = require('./watch-history');
const { canonicalTitle } = require('./script-query');

const normalizeTitle = title => canonicalTitle(title);
const score = (title, keyword) => title === keyword ? 0 : title.includes(keyword) ? 1 : 2;
function rankedUnique(results, keyword) {
  const seen = new Set(), normalized = normalizeTitle(keyword);
  return results.filter(item => {
    if (!item?.series_id || !item.series_title) return false;
    const id = String(item.series_id);
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).sort((a, b) => score(normalizeTitle(a.series_title), normalized) - score(normalizeTitle(b.series_title), normalized));
}

function nextSeasonQueries(base, season, samples = []) {
  if (!base || !Number.isInteger(season) || season < 2 || season > 99) return [];
  const digits = '零一二三四五六七八九';
  const chinese = season < 10 ? digits[season] : `${season < 20 ? '' : digits[Math.floor(season / 10)]}十${season % 10 ? digits[season % 10] : ''}`;
  const wrapped = samples.some(item => /[（(]第[^）)]+[季部][）)]/.test(canonicalTitle(item?.series_title || '')));
  // Keep two supplements. Bracketed titles such as （第一季） also ask for （第N季）.
  return wrapped ? [`${base}（第${chinese}季）`, `${base}第${chinese}季`] : [`${base}第${chinese}季`, `${base}第${season}季`];
}

// One primary search plus at most two supplements; never recursively expand upstream results.
async function searchSeries(keyword, search, knownSeries = [], { afterSeason = 1 } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw || kw.length > 200) return { success: false, results: [], error: '请输入 1 至 200 字的搜索词' };
  const primary = await search(kw);
  if (!primary?.success) return primary || { success: false, results: [], error: '搜索暂不可用' };
  const results = [...(primary.results || [])], parsed = seasonTitle(kw);
  let queries = [];
  if (parsed.base && !parsed.invalid && parsed.season <= 99) {
    if (parsed.explicit) {
      if (!results.some(item => normalizeTitle(item.series_title) === normalizeTitle(kw))) queries = [parsed.base];
    } else {
      const seasons = [...results, ...knownSeries].map(item => seasonTitle(item.series_title)).filter(item => item.base === parsed.base && !item.invalid);
      if (seasons.length) {
        const knownSeasons = new Set(seasons.map(item => item.season));
        let nextSeason = afterSeason + 1;
        while (nextSeason <= 99 && knownSeasons.has(nextSeason)) nextSeason++;
        queries = nextSeasonQueries(parsed.base, nextSeason, [...results, ...knownSeries]);
      }
    }
  }
  const errors = [];
  for (const query of queries) {
    try {
      const response = await search(query);
      if (!response?.success) throw new Error(response?.error || '来源未返回结果');
      results.push(...(response.results || []));
    } catch (error) { errors.push(error.message); }
  }
  return { ...primary, results: rankedUnique(results, kw), ...(errors.length ? { partial: true, error: `补充搜索未完成：${[...new Set(errors)].join('；')}` } : {}) };
}

async function findSeriesSequels(series, localCandidates, search, { localOnly = false } = {}) {
  const parsed = seasonTitle(series?.series_title), source = sourceOf(String(series?.series_id || ''));
  if (!source) return { success: false, results: [], error: '此来源暂不支持查找下一季，请按完整剧名搜索。' };
  if (!parsed.base || parsed.invalid || parsed.season > 99) return { success: false, results: [], error: '剧名或季数无法识别，请按完整剧名搜索。' };
  const local = findSequels(series, localCandidates);
  if (localOnly) return { success: true, results: local };
  try {
    const response = await searchSeries(parsed.base, search, [series, ...local], { afterSeason: parsed.season });
    if (!response?.success) throw new Error(response?.error || '来源搜索失败');
    return { success: true, results: findSequels(series, [...local, ...(response.results || [])]), ...(response.partial ? { partial: true, error: response.error } : {}) };
  } catch (error) {
    return { success: local.length > 0, results: local, partial: true, error: `联网查找未完成：${error.message}${local.length ? '；已保留本机候选。' : '；可稍后重试。'}` };
  }
}

module.exports = { searchSeries, findSeriesSequels };
