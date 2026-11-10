// The favorites page is one list: newest favorite first, narrowed by a filter. Categories come from
// the account list or from the section the heart was clicked in; unknown stays uncategorized.

export const FAVORITE_CATEGORIES = ['real', 'ai', 'comic'];

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'playable', label: '可播放' },
  { id: 'waiting', label: '尚未上线' },
  { id: 'real', label: '真人剧' },
  { id: 'comic', label: '漫剧' },
  { id: 'ai', label: 'AI 剧' },
];

export const favoriteCategory = value => FAVORITE_CATEGORIES.includes(value) ? value : '';

// Section of the discover page → category of a favorite clicked there.
export function categoryFromBrowse(category) {
  const name = String(category || '').replace(/^hot-/, '');
  if (name === 'real-drama') return 'real';
  if (name === 'ai-drama') return 'ai';
  if (name === 'comic-drama') return 'comic';
  return '';
}

// Not online yet, or online by date but not confirmed playable.
export function isWaiting(item, now, released = {}) {
  const at = Number(item?.online_time);
  return Number.isFinite(at) && at > 0 && (at > now || released[item.id] !== true);
}

function matches(item, filter, now, released) {
  if (filter === 'all') return true;
  if (filter === 'waiting') return isWaiting(item, now, released);
  if (filter === 'playable') return !isWaiting(item, now, released);
  return favoriteCategory(item.category) === filter;
}

const newestFirst = (a, b) => {
  const left = Number(a.favorited_at) > 0 ? Number(a.favorited_at) : 0;
  const right = Number(b.favorited_at) > 0 ? Number(b.favorited_at) : 0;
  return right - left || String(a.title).localeCompare(String(b.title), 'zh-CN') || String(a.id).localeCompare(String(b.id));
};

// Keep the same filters visible even when a category is empty or the account has not loaded yet.
export function favoriteView(items, { filter = 'all', now = Date.now(), released = {}, folderIds = null } = {}) {
  const favorites = (Array.isArray(items) ? items : []).filter(item => item && item.favorite && (!Array.isArray(folderIds) || folderIds.includes(String(item.id))));
  const counts = Object.fromEntries(FILTERS.map(({ id }) => [id, favorites.filter(item => matches(item, id, now, released)).length]));
  const filters = FILTERS.map(row => ({ ...row, count: counts[row.id] }));
  const chosen = filters.some(row => row.id === filter) ? filter : 'all';
  return { filter: chosen, filters, rows: favorites.filter(item => matches(item, chosen, now, released)).sort(newestFirst), total: favorites.length };
}
