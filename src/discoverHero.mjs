

export const HERO_LIMIT = 10;
export const HERO_INTERVAL_MS = 5000;
export const HERO_RESERVED_ROWS = 2;

export function heroLineup(items, limit = HERO_LIMIT) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 0;
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.series_id || '');
    const rank = Number(item?.rank);
    const title = typeof item?.series_title === 'string' ? item.series_title.trim() : '';
    if (!/^\d{6,}$/.test(id) || !title || !Number.isSafeInteger(rank) || rank < 1) continue;
    const existing = byId.get(id);
    if (!existing || rank < Number(existing.rank)) byId.set(id, item);
  }
  return [...byId.values()]
    .sort((a, b) => Number(a.rank) - Number(b.rank) || String(a.series_id).localeCompare(String(b.series_id)))
    .slice(0, cap);
}


export function heroSlides(items) {
  const lineup = Array.isArray(items) ? items : [];
  if (lineup.length < 2) return lineup.slice();
  return [...lineup, lineup[0]];
}


export const DISCOVER_SHELF_KEY = 'hongguo:discover-shelf';

function shelfCard(item) {
  if (!item || typeof item !== 'object') return null;
  const seriesId = String(item.series_id || '');
  const title = typeof item.series_title === 'string' ? item.series_title.trim() : '';
  if (!seriesId || !title) return null;
  return {
    series_id: seriesId,
    series_title: title,
    cover: typeof item.cover === 'string' ? item.cover : '',
    rank: Number(item.rank) || 0,
    rating: item.rating ?? null,
    heat: typeof item.heat === 'string' ? item.heat : '',
    tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string').slice(0, 4) : [],
    is_new: item.is_new === true,
    is_premiere: item.is_premiere === true,
    episode_label: typeof item.episode_label === 'string' ? item.episode_label : '',
    episode_count: Number(item.episode_count) || 0,
    completion_status: typeof item.completion_status === 'string' ? item.completion_status : '',
  };
}

export function readDiscoverShelf(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(DISCOVER_SHELF_KEY) || 'null');
    const hero = heroLineup(Array.isArray(parsed?.hero) ? parsed.hero : []).map(shelfCard).filter(Boolean);
    const posters = (Array.isArray(parsed?.posters) ? parsed.posters : []).map(shelfCard).filter(Boolean).slice(0, 40);
    return { hero, posters };
  } catch {
    return { hero: [], posters: [] };
  }
}

export function writeDiscoverShelf(storage, patch = {}) {
  if (typeof storage?.getItem !== 'function' || typeof storage?.setItem !== 'function') return;
  const current = readDiscoverShelf(storage);
  const next = {
    hero: Object.prototype.hasOwnProperty.call(patch, 'hero')
      ? heroLineup(patch.hero).map(shelfCard).filter(Boolean)
      : current.hero,
    posters: Object.prototype.hasOwnProperty.call(patch, 'posters')
      ? (Array.isArray(patch.posters) ? patch.posters : []).map(shelfCard).filter(Boolean).slice(0, 40)
      : current.posters,
  };
  try { storage.setItem(DISCOVER_SHELF_KEY, JSON.stringify(next)); } catch {                                      }
}

export function heroOffsetPercent(index, slideCount) {
  const count = Math.floor(Number(slideCount));
  const position = Math.floor(Number(index));
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(position)) return 0;
  const clamped = Math.min(Math.max(position, 0), count - 1);
  if (clamped === 0) return 0;
  return -clamped * (100 / count);
}
