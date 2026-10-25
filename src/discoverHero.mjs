// Discover-page banner. Rank 1 is the hottest item from the current hot-drama list.
// Nothing here names a series; callers pass whatever the ranking returned.
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

// One extra copy of the first slide lets the track move left onto it, then jump home.
export function heroSlides(items) {
  const lineup = Array.isArray(items) ? items : [];
  if (lineup.length < 2) return lineup.slice();
  return [...lineup, lineup[0]];
}

// translateX percentages are relative to the track, which is N slides wide.
export function heroOffsetPercent(index, slideCount) {
  const count = Math.floor(Number(slideCount));
  const position = Math.floor(Number(index));
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(position)) return 0;
  const clamped = Math.min(Math.max(position, 0), count - 1);
  if (clamped === 0) return 0;
  return -clamped * (100 / count);
}
