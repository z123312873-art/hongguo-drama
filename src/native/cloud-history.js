'use strict';



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



function finished(index, total) {
  return Number.isInteger(index) && Number.isInteger(total) && total > 0 && index >= total;
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



async function fetchHistory(request, { maxPages = MAX_PAGES, onSummary } = {}) {
  const rows = new Map();
  const seen = new Set();
  let offset = 0;
  let reportedTotal = null;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await request('GET', LIST_PATH, {
      limit: '0', offset: String(offset), book_type: '2', full_field: 'false', query_soft_deleted: 'false',
      last_min_read_timestamp_ms: '0', is_first_load: offset === 0 ? 'true' : 'false',
    });
    const { rows: list, hasMore, nextOffset } = parsePage(payload);
    const total = number(payload.data.total);
    if (Number.isInteger(total) && total >= 0) reportedTotal = Math.max(reportedTotal ?? 0, total);
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
    if (!hasMore) {
      onSummary?.({ reportedTotal, returnedCount: rows.size });
      return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    if (!list.length) throw new Error('手机历史没有读完，请稍后重试');
    offset = nextOffset > offset ? nextOffset : offset + PAGE_STRIDE;
  }
  throw new Error('手机历史太多页，没有读完');
}


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
    is_interactive_game: false, is_listen_mode: false, is_multi_season: entry.multiSeason === true ? 1 : 0,
    season_index: Number(entry.seasonIndex) || 0, duration: ms(entry.duration), episode_cnt: Number(entry.total) || 0,
  };
  if (readId(entry.cloudVid)) row.vid = asId(entry.cloudVid);
  return idJson({ update_datas: [row] });
}

async function uploadEntry(request, entry, now = Date.now()) {
  if (!readId(entry?.series_id) || !Number.isInteger(entry?.vid_index) || entry.vid_index < 1) throw new Error('这部剧的进度无法同步');
  await request('POST', UPDATE_PATH, {}, updateBody(entry, now, false));
}


async function deleteEntry(request, entry, now = Date.now(), options = {}) {
  if (!readId(entry?.series_id)) throw new Error('这部剧无法从手机历史移除');
  await request('POST', UPDATE_PATH, {}, updateBody(entry, now, true));
  const after = await fetchHistory(request, options);
  if (after.some(row => row.series_id === entry.series_id)) {
    const error = new Error(DELETE_UNCONFIRMED);
    error.code = 'CLOUD_DELETE_UNCONFIRMED';
    error.rows = after;
    throw error;
  }
  return after;
}

const DELETE_UNCONFIRMED = '手机历史没有确认移除，请稍后再试';

async function deleteEntries(request, entries, { now = Date.now, keepGoing = () => true, ...options } = {}) {
  const posted = [];
  const failed = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = readId(entry?.series_id);
    if (!id) { failed.push({ id: String(entry?.series_id ?? ''), code: 'CLOUD_DELETE_INVALID', message: '这部剧无法从手机历史移除' }); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    if (!keepGoing()) { failed.push({ id, code: 'CLOUD_DELETE_STOPPED', message: '' }); continue; }
    try {
      await request('POST', UPDATE_PATH, {}, updateBody(entry, now(), true));
      posted.push(id);
    } catch (error) {
      failed.push({ id, code: 'CLOUD_DELETE_FAILED', message: String(error?.message || '请稍后重试') });
    }
  }
  if (!posted.length) return { rows: null, removed: [], failed };
  if (!keepGoing()) return { rows: null, removed: [], failed: [...failed, ...posted.map(id => ({ id, code: 'CLOUD_DELETE_STOPPED', message: '' }))] };
  let rows;
  try { rows = await fetchHistory(request, options); }
  catch (error) {
    const message = String(error?.message || '请稍后重试');
    return { rows: null, removed: [], failed: [...failed, ...posted.map(id => ({ id, code: 'CLOUD_DELETE_FAILED', message }))] };
  }
  const listed = new Set(rows.map(row => row.series_id));
  return {
    rows,
    removed: posted.filter(id => !listed.has(id)),
    failed: [...failed, ...posted.filter(id => listed.has(id)).map(id => ({ id, code: 'CLOUD_DELETE_UNCONFIRMED', message: DELETE_UNCONFIRMED }))],
  };
}

const HONGGUO_ID = /^\d{6,30}$/;
const SAME_MS = 1000;






function reconcileHistory({ playback, cloudRows, userId }) {
  const next = { ...(playback || {}) };
  const toUpload = [];
  const removed = [];
  const cloud = new Map(cloudRows.map(row => [row.series_id, row]));
  for (const row of cloudRows) {
    const mine = next[row.series_id];
    const remote = { title: row.series_title, cover: row.cover || '', total: row.total };
    const finished = row.completed ? { completedEpisode: row.vid_index } : {};
    if (!mine || !(Number.isFinite(mine.updatedAt) && Number.isInteger(mine.vid_index) && mine.vid_index > 0)) {
      next[row.series_id] = { ...(mine || {}), vid_index: row.vid_index, currentTime: row.currentTime, updatedAt: row.updatedAt, watched: true,
        knownTotal: Math.max(Number(mine?.knownTotal) || 0, row.total), acknowledgedTotal: mine?.acknowledgedTotal ?? row.total,
        ...finished, remote, cloudSynced: userId };
      continue;
    }
    const merged = { ...mine, remote, cloudSynced: userId, knownTotal: Math.max(Number(mine.knownTotal) || 0, row.total) };
    if (row.updatedAt > mine.updatedAt + SAME_MS) {
      Object.assign(merged, { vid_index: row.vid_index, currentTime: row.currentTime, updatedAt: row.updatedAt, watched: true, ...finished });
      if (!row.completed) delete merged.completedEpisode;
    } else if (mine.updatedAt > row.updatedAt + SAME_MS) {
      toUpload.push(row.series_id);
    } else if (row.vid_index === mine.vid_index) {

      if (row.completed) merged.completedEpisode = row.vid_index;
      else delete merged.completedEpisode;
    }
    next[row.series_id] = merged;
  }
  let kept = 0;
  for (const [id, record] of Object.entries(next)) {
    if (cloud.has(id) || !HONGGUO_ID.test(id) || !record || !Number.isInteger(record.vid_index) || record.vid_index < 1) continue;
    if (record.cloudSynced === userId) {
      if (!cloudRows.length) { kept += 1; continue; }
      delete next[id];
      removed.push(id);
    } else if (!record.cloudSynced) {
      toUpload.push(id);
    }

  }
  return {
    playback: next, toUpload, removed,
    notice: kept ? `手机历史是空的，这台电脑的 ${kept} 部记录先保留，没有删除` : '',
  };
}

module.exports = { cloudRow, parsePage, fetchHistory, uploadEntry, deleteEntry, deleteEntries, reconcileHistory, updateBody, finished, LIST_PATH, UPDATE_PATH };
