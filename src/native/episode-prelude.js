'use strict';

// Catalog pages already include a full vid_list. Search snippets often do not
// (a handful of vids against a much larger episode_cnt) and must not be reused.

const TTL_MS = 10 * 60 * 1000;
const LIMIT = 1000;
const store = new Map();

function episodeIds(list) {
  if (!Array.isArray(list)) return [];
  const ids = [];
  for (const item of list) {
    const id = String(item ?? '').trim();
    if (!/^\d{6,30}$/.test(id)) return [];
    ids.push(id);
  }
  return ids;
}

function rememberWebEpisodes(seriesId, info = {}) {
  const id = String(seriesId || info.series_id || '');
  if (!/^\d{6,30}$/.test(id)) return false;
  const total = Number(info.episode_cnt ?? info.episode_count);
  const vids = episodeIds(info.vid_list);
  if (!Number.isInteger(total) || total < 1 || vids.length !== total || new Set(vids).size !== vids.length) return false;
  const accessibleRaw = Number(info.accessible_episode_cnt);
  const accessible = Number.isInteger(accessibleRaw) && accessibleRaw >= 0 ? Math.min(accessibleRaw, vids.length) : null;
  const title = typeof info.series_title === 'string' && info.series_title.trim()
    ? info.series_title.trim()
    : (typeof info.series_name === 'string' && info.series_name.trim() ? info.series_name.trim() : '未命名短剧');
  const cover = typeof info.cover === 'string' ? info.cover
    : (typeof info.series_cover === 'string' ? info.series_cover : '');
  store.delete(id);
  store.set(id, { expires: Date.now() + TTL_MS, title, cover: cover || '', vids, accessible });
  while (store.size > LIMIT) store.delete(store.keys().next().value);
  return true;
}

function takeWebEpisodes(seriesId) {
  const id = String(seriesId || '');
  const hit = store.get(id);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    store.delete(id);
    return null;
  }
  return {
    series_id: id,
    series_title: hit.title,
    cover: hit.cover,
    total: hit.vids.length,
    web_accessible_episodes: hit.accessible,
    episodes: hit.vids.map((vid, index) => ({
      vid,
      vid_index: index + 1,
      title: '',
      series_id: id,
      series_title: hit.title,
      cover: hit.cover,
      web_available: hit.accessible === null ? null : index < hit.accessible,
    })),
    source: 'web',
  };
}

function clearWebEpisodes() {
  store.clear();
}

module.exports = { rememberWebEpisodes, takeWebEpisodes, clearWebEpisodes };
