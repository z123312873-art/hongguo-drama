// Public rank pages are 20 items across 5 pages. A one-page snapshot must not be shown as the whole rank.
export const RANK_PAGE_SIZE = 20;
export const RANK_SOURCE_PAGES = 5;
export const RANK_TOTAL = RANK_PAGE_SIZE * RANK_SOURCE_PAGES;

export function pageWindow(totalPages, page) {
  const total = Math.floor(Number(totalPages)) || 0;
  if (total < 1) return [];
  const current = Math.min(Math.max(1, Math.floor(Number(page)) || 1), total);
  const pages = new Set([1, total]);
  for (let offset = 0; offset < 5 && current + offset <= total; offset += 1) pages.add(current + offset);
  return [...pages].sort((left, right) => left - right);
}

const PUBLIC_CATEGORY_CAP = 800;
const CAPPED_CATEGORIES = new Set(['real-drama', 'comic-drama', 'ai-drama']);

export function shownBrowseTotal({ source, category, genre, total } = {}) {
  const count = Number(total);
  const reported = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (source !== 'hongguo') return reported;
  if (String(category || '').startsWith('hot-')) return genre ? reported : RANK_TOTAL;
  if (!genre && CAPPED_CATEGORIES.has(category) && reported === PUBLIC_CATEGORY_CAP) return 0;
  return reported;
}

export function reuseFreshSnapshot({ haveCards, stale, forceRefresh, neededSpan, pageSpan }) {
  return haveCards === true && stale !== true && forceRefresh !== true && Number(neededSpan) <= (Number(pageSpan) || 1);
}

export function keepRicherSnapshot(previous, incoming) {
  if (!previous?.results?.length) return incoming;
  const previousSpan = Number(previous.pageSpan) || 1;
  const incomingSpan = Number(incoming?.pageSpan) || 1;
  if (previousSpan > incomingSpan && previous.results.length >= (incoming?.results?.length || 0)) return previous;
  return incoming;
}
