


export const FEED_CACHE_LIMIT = 24;

const cache = new Map();

export function feedCacheKey(revision, source, category) {
  return `${revision}\u0000${source}\u0000${category}`;
}

export function readFeedCache(key) {
  return cache.get(key) || null;
}

export function writeFeedCache(key, items, savedAt = Date.now()) {
  if (typeof key !== 'string' || !key || !Array.isArray(items) || items.length === 0) return null;
  cache.delete(key);
  cache.set(key, { items, savedAt });
  while (cache.size > FEED_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return cache.get(key);
}

export function clearFeedCache() {
  cache.clear();
}
