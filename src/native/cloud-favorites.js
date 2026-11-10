'use strict';

// The account's favorites. Only dramas that can already be played are kept in the account; favorites
// that are not online yet stay on this computer. A list that cannot be read completely is an error,
// never an empty list.

const LIST_PATH = '/reading/bookapi/bookshelf/video/list/v';
const UPDATE_PATH = '/reading/bookapi/bookshelf/video/update/v';
const ID = /^[1-9]\d{5,24}$/;
const MAX_ROWS = 10000;

function readId(value) {
  if (typeof value === 'string' && ID.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && ID.test(String(value))) return String(value);
  return '';
}

// Seconds or milliseconds; anything else is unknown (0).
function stamp(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  const ms = n < 100000000000 ? n * 1000 : n;
  return ms > 946684800000 && ms < 4102444800000 ? Math.floor(ms) : 0;
}

// Explicit category labels take precedence. Animated entries without an AI label are comic dramas.
function readCategory(raw) {
  const kind = String(raw.video_category_type || '').toLowerCase();
  if (kind === 'ai_video') return 'ai';
  if (kind === 'comic_video' || kind === 'anime_video') return 'comic';
  if (!kind && String(raw.content_type) === '1') return 'real';
  if (!kind && String(raw.content_type) === '1004') return 'comic';
  return '';
}

function parseFavorites(payload) {
  const data = payload && typeof payload.data === 'object' && payload.data && !Array.isArray(payload.data) ? payload.data : null;
  if (!data || !Array.isArray(data.video_shelf_info)) throw new Error('手机收藏的回应格式不对');
  if (data.video_shelf_info.length > MAX_ROWS) throw new Error('手机收藏太多，没有读完');
  const rows = new Map();
  for (const raw of data.video_shelf_info) {
    if (!raw || typeof raw !== 'object') continue;
    const id = readId(raw.series_id) || readId(raw.book_id) || readId(raw.series_id_str) || readId(raw.book_id_str);
    if (!id) continue;
    const at = stamp(raw.collect_time) || stamp(raw.modify_time) || stamp(raw.create_time);
    const old = rows.get(id);
    if (!old || at > old.favoritedAt) rows.set(id, { id, favoritedAt: at, category: readCategory(raw) || old?.category || '' });
  }
  return [...rows.values()].sort((a, b) => b.favoritedAt - a.favoritedAt);
}

async function fetchFavorites(request, userId) {
  if (!readId(userId) && !/^\d{1,30}$/.test(String(userId || ''))) throw new Error('帐号编号无效');
  return parseFavorites(await request('GET', LIST_PATH, { target_user_id: String(userId) }));
}

function updateBody(id, on, now) {
  return JSON.stringify({
    is_cancelled: false,
    shark_extra: { enter_from: '0', previous_page: '0', page_list: '0', is_active_behavior: '1', inactive_type: '0' },
    update_bookshelf_video_list: [{ book_id: id, book_type: 2, modify_time: now, video_shelf_operate_type: on ? 0 : 1 }],
  });
}

// Adds or cancels one favorite, then reads the list again: only a confirmed change counts.
async function setFavorite(request, userId, id, on, now = Date.now()) {
  const sid = readId(id);
  if (!sid) throw new Error('这部剧无法同步到手机收藏');
  await request('POST', UPDATE_PATH, {}, updateBody(sid, on === true, now));
  const after = await fetchFavorites(request, userId);
  if (after.some(row => row.id === sid) !== (on === true)) {
    const error = new Error(on ? '手机收藏没有确认加入，请稍后再试' : '手机收藏没有确认取消，请稍后再试');
    error.code = 'CLOUD_FAVORITE_UNCONFIRMED';
    error.rows = after;
    throw error;
  }
  return after;
}

module.exports = { parseFavorites, fetchFavorites, setFavorite, updateBody, readId, LIST_PATH, UPDATE_PATH };
