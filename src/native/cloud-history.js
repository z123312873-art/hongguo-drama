'use strict';

// The account's watch history (the phone app's 「历史」). When signed in this list is the source of
// truth for which dramas appear and how many; this computer's own progress is only used when it is newer.

const { compatibleCover } = require('./cover-url');

const LIST_PATH = '/reading/bookapi/read_history/list/v';
const UPDATE_PATH = '/reading/bookapi/read_history/update/v';
const PAGE_STRIDE = 500;
const MAX_PAGES = 40;
const ID = /^[1-9]\d{0,24}$/;

function readId(value) {
  if (typeof value === 'string' && ID.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return '';
}

function number(value) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : NaN;
}

function flag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

// Finished on the phone means: the last episode, played to (nearly) its end. Without a duration the
// last episode alone does not count, so an unknown never inflates 已看完.
function finished(index, total, positionSec, durationSec) {
  if (!(total > 0) || index < total) return false;
  if (!(durationSec > 0)) return false;
  return positionSec >= durationSec - Math.max(1.5, durationSec * 0.03);
}

function cloudRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = readId(raw.book_id_str) || readId(raw.book_id);
  if (!id || flag(raw.is_delete)) return null;
  const index = number(raw.vid_index);
  const stamp = number(raw.read_timestamp_ms);
  if (!Number.isInteger(index) || index < 1 || index > 100000 || !(stamp > 0)) return null;
  const position = Math.max(0, number(raw.current_play_position) / 1000 || 0);
  const duration = Math.max(0, number(raw.duration) / 1000 || 0);
  const total = Math.max(0, Math.floor(number(raw.episode_cnt) || 0));
  const title = typeof raw.book_name === 'string' ? raw.book_name.trim().slice(0, 200) : '';
  const cover = typeof raw.thumb_url === 'string' ? compatibleCover(raw.thumb_url) : '';
  return {
    series_id: id, series_title: title || `短剧 ${id.slice(-6)}`, cover, total: Math.max(total, index),
    vid_index: index, currentTime: Math.min(position, 86400), duration, updatedAt: Math.floor(stamp),
    completed: finished(index, total, position, duration),
    cloudVid: readId(raw.vid) || readId(raw.item_id), seasonIndex: Math.max(0, Math.floor(number(raw.season_index) || 0)),
    multiSeason: flag(raw.is_multi_season),
  };
}

function parsePage(payload) {
  const data = payload && typeof payload.data === 'object' && payload.data && !Array.isArray(payload.data) ? payload.data : null;
  if (!data || !Array.isArray(data.data_list)) throw new Error('手机历史的回应格式不对');
  return { rows: data.data_list, hasMore: flag(data.has_more), nextOffset: Math.floor(number(data.next_offset)) };
}

// Reads every page. A repeated page or a page cap means the list is incomplete, which is an error,
// not a shorter list: a partial list must never delete or hide anything.
async function fetchHistory(request, { maxPages = MAX_PAGES } = {}) {
  const rows = new Map();
  const seen = new Set();
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await request('GET', LIST_PATH, {
      limit: '0', offset: String(offset), book_type: '2', full_field: 'false', query_soft_deleted: 'false',
      last_min_read_timestamp_ms: '0', is_first_load: offset === 0 ? 'true' : 'false',
    });
    const { rows: list, hasMore, nextOffset } = parsePage(payload);
    if (list.length) {
      const fingerprint = JSON.stringify(list.map(item => [item?.book_id_str ?? item?.book_id, item?.read_timestamp_ms]));
      if (seen.has(fingerprint)) throw new Error('手机历史分页重复，请稍后重试');
      seen.add(fingerprint);
    }
    for (const raw of list) {
      const row = cloudRow(raw);
      if (!row) continue;
      const old = rows.get(row.series_id);
      if (!old || row.updatedAt > old.updatedAt) rows.set(row.series_id, row);
    }
    if (!hasMore) return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!list.length) throw new Error('手机历史没有读完，请稍后重试');
    offset = nextOffset > offset ? nextOffset : offset + PAGE_STRIDE;
  }
  throw new Error('手机历史太多页，没有读完');
}

// JSON with the long ids written as numbers, as the app sends them, without float rounding.
function idJson(value) {
  return JSON.stringify(value).replace(/"\\u0000id:(\d+)"/g, '$1');
}
const asId = id => `\u0000id:${id}`;

function updateBody(entry, now, deleted) {
  const ms = value => Math.max(0, Math.round((Number(value) || 0) * 1000));
  const stamp = deleted ? now : Math.floor(Number(entry.updatedAt) || now);
  const row = {
    book_id: asId(entry.series_id), book_type: 2, vid_index: entry.vid_index, chapter_index: 0,
    current_play_position: ms(entry.currentTime), player_accumulate_total_time: ms(entry.currentTime),
    read_timestamp_ms: stamp, update_timestamp_ms: now, is_delete: deleted, use_soft_delete: false,
    is_interactive_game: false, is_listen_mode: false, is_multi_season: entry.multiSeason === true,
    season_index: Number(entry.seasonIndex) || 0, duration: ms(entry.duration), episode_cnt: Number(entry.total) || 0,
  };
  if (readId(entry.cloudVid)) row.vid = asId(entry.cloudVid);
  return idJson({ update_datas: [row] });
}

async function uploadEntry(request, entry, now = Date.now()) {
  if (!readId(entry?.series_id) || !Number.isInteger(entry?.vid_index) || entry.vid_index < 1) throw new Error('这部剧的进度无法同步');
  await request('POST', UPDATE_PATH, {}, updateBody(entry, now, false));
}

// Deletes on the account, then reads the list again: only a row that is really gone counts as deleted.
async function deleteEntry(request, entry, now = Date.now()) {
  if (!readId(entry?.series_id)) throw new Error('这部剧无法从手机历史移除');
  await request('POST', UPDATE_PATH, {}, updateBody(entry, now, true));
  const after = await fetchHistory(request);
  if (after.some(row => row.series_id === entry.series_id)) {
    const error = new Error('手机历史没有确认移除，请稍后再试');
    error.code = 'CLOUD_DELETE_UNCONFIRMED';
    error.rows = after;
    throw error;
  }
  return after;
}

// Account rows decide what is listed. A local row for the same drama adds this computer's extras
// (update checks, sequels) and wins on progress only when it is newer. Local rows played while signed
// in that the account has not confirmed yet are listed once, marked pending; older local-only rows stay
// on this computer and come back after signing out.
function mergeHistory(cloudRows, localRows, pending = new Set()) {
  const local = new Map((localRows || []).map(row => [String(row.series_id), row]));
  const merged = cloudRows.map(row => {
    const mine = local.get(row.series_id);
    if (!mine) return { ...row, sequels: [], hasUpdates: false, unreadEpisodes: 0, lastCheckedAt: 0, lastCheckError: '', synced: true };
    const newer = Number(mine.updatedAt) > row.updatedAt;
    return {
      ...mine,
      series_title: mine.series_title || row.series_title,
      cover: mine.cover || row.cover,
      total: Math.max(Number(mine.total) || 0, row.total),
      vid_index: newer ? mine.vid_index : row.vid_index,
      currentTime: newer ? mine.currentTime : row.currentTime,
      updatedAt: Math.max(Number(mine.updatedAt) || 0, row.updatedAt),
      completed: newer ? mine.completed === true : row.completed,
      cloudVid: row.cloudVid, duration: row.duration, seasonIndex: row.seasonIndex, multiSeason: row.multiSeason,
      synced: true,
    };
  });
  const listed = new Set(merged.map(row => row.series_id));
  for (const row of localRows || []) {
    const id = String(row.series_id);
    if (!listed.has(id) && pending.has(id)) merged.push({ ...row, synced: false });
  }
  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

module.exports = { cloudRow, parsePage, fetchHistory, uploadEntry, deleteEntry, mergeHistory, updateBody, finished, LIST_PATH, UPDATE_PATH };
