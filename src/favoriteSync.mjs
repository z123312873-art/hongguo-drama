



const MAX_CHANGES = 20;
const CATEGORIES = ['real', 'ai', 'comic'];
const kindOf = value => CATEGORIES.includes(value) ? value : '';

export const waitingOnline = (item, now) => Number(item?.online_time) > now;
const favoriteTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const placeholderTitle = id => `短剧 ${String(id).slice(-6)}`;



export function planFavorites({ items, cloud, userId, cancels = [], now = Date.now() }) {

  const pendingCancel = new Set(cancels.filter(id => !items.some(item => item.id === id && item.favorite)));
  const cloudIds = new Set(cloud.map(row => row.id));
  const byId = new Map(items.map(item => [item.id, { ...item }]));
  let changed = false;
  for (const row of cloud) {
    if (pendingCancel.has(row.id)) continue;
    const mine = byId.get(row.id);
    if (!mine) {
      byId.set(row.id, { id: row.id, title: row.title || placeholderTitle(row.id), published_at: null, favorite: true,
        favorited_at: favoriteTime(row.favoritedAt) || now, cover: row.cover || '', online_time: null, cloud_user: userId, category: kindOf(row.category) });
      changed = true;
      continue;
    }
    const next = { ...mine, favorite: true, cloud_user: userId,

      favorited_at: Math.max(mine.favorite ? favoriteTime(mine.favorited_at) : 0, favoriteTime(row.favoritedAt)) || now,
      title: mine.title && mine.title !== placeholderTitle(row.id) ? mine.title : row.title || mine.title,
      cover: mine.cover || row.cover || '',

      category: kindOf(row.category) || kindOf(mine.category) };
    if (JSON.stringify(next) !== JSON.stringify(mine)) { byId.set(row.id, next); changed = true; }
  }
  const toAdd = [];
  let kept = 0;
  for (const item of byId.values()) {
    if (!item.favorite || cloudIds.has(item.id) || waitingOnline(item, now)) continue;
    if (item.cloud_user === userId) {


      if (!cloud.length) { kept += 1; continue; }
      byId.set(item.id, { ...item, favorite: false, favorited_at: null, cloud_user: null });
      changed = true;
    } else if (!item.cloud_user) {
      toAdd.push(item.id);
    }

  }
  const toCancel = [...pendingCancel].filter(id => cloudIds.has(id));
  return {
    items: [...byId.values()], changed,
    toAdd: toAdd.slice(0, MAX_CHANGES), toCancel: toCancel.slice(0, MAX_CHANGES),
    cancels: cloud.length ? toCancel : [...pendingCancel],
    notice: kept ? `手机收藏是空的，这台电脑的 ${kept} 部收藏先保留，没有删除` : '',
  };
}



export function newCancels(before, after, userId) {
  const now = new Map(after.map(item => [item.id, item]));
  return before.filter(item => item.favorite && item.cloud_user === userId && !now.get(item.id)?.favorite).map(item => item.id);
}


export function markConfirmed(items, id, userId, on) {
  return items.map(item => item.id !== id ? item : { ...item, cloud_user: on ? userId : null });
}
