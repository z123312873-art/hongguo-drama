const { comicCover } = require('./cover-url');

const UPCOMING_PATH = '/reading/user/subscribe/list/v1/';
const PAGE_LIMIT = 50;
const MAX_PAGES = 10;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function unitReservation(text) {
  const match = String(text ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万萬亿億])/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return 0;
  if (match[2] === '万' || match[2] === '萬') return value * 10000;
  return value * 100000000;
}

function reservationCount(text) {
  const counted = unitReservation(text);
  if (counted) return counted;
  const bare = String(text ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!bare) return 0;
  const value = Number(bare[1]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function dayParts(text) {
  const match = String(text ?? '').match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

function taipeiParts(seconds) {
  const instant = Number(seconds);
  if (!Number.isFinite(instant) || instant <= 0) return null;
  const shifted = new Date(instant * 1000 + TAIPEI_OFFSET_MS);
  return { month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), time: instant * 1000 };
}

function futureTimestamp(seconds, now) {
  const parts = taipeiParts(seconds);
  if (!parts) return null;
  return parts.time > now ? parts : null;
}

function onlineLabel(sentence, timestamp) {
  const written = dayParts(sentence);
  const source = written || timestamp;
  if (!source) return '';
  return `${source.month}月${source.day}日`;
}

function selectUpcoming(items, now = Date.now()) {
  const moment = Number(now);
  const rows = [];
  for (const item of items || []) {
    if (!item || item.is_online === true) continue;
    const title = String(item.name || item.title || '').trim();
    const id = String(item.item_id || item.series_id || item.id || '').trim();
    if (!title || !id) continue;
    const sentence = String(item.sub_info || item.schedule_text || '');
    const timestamp = futureTimestamp(item.expected_publish_time, moment);
    if (!timestamp) continue;
    const cover = comicCover(item.cover || item.cover_url || '', 320);
    rows.push({
      series_id: id,
      series_title: title,
      cover: cover,
      online_label: onlineLabel(sentence, timestamp),
      online_time: timestamp.time,
      reservations: reservationCount(item.expected_rec_text) || unitReservation(sentence),
      is_new: false,
      is_premiere: false,
      rating: null,
      heat: '',
    });
  }
  rows.sort((a, b) => b.reservations - a.reservations || a.online_time - b.online_time || a.series_title.localeCompare(b.series_title, 'zh'));
  return rows;
}

function absorbUpcoming(state, batch, now = Date.now()) {
  const raw = [...(state?.raw || []), ...(batch?.items || [])];
  const offset = Number(state?.offset) || 0;
  const nextOffset = Number(batch?.nextOffset);
  const advanced = Number.isFinite(nextOffset) && nextOffset > offset;
  const done = batch?.hasMore !== true || !advanced;
  return {
    raw,
    items: selectUpcoming(raw, now),
    done,
    offset: done ? offset : nextOffset,
    sessionId: done ? String(state?.sessionId || '') : String(batch?.sessionId || state?.sessionId || ''),
  };
}

async function fetchUpcomingPage(options, request) {
  const offset = Math.max(0, Number(options.offset) || 0);
  const sessionId = String(options.sessionId || '');
  const values = { is_online: '0', tab_type: '2', limit: String(PAGE_LIMIT), offset: String(offset), version: '1' };
  if (sessionId) values.session_id = sessionId;
  const json = await request(UPCOMING_PATH, values);
  const data = json?.data || json || {};
  const items = Array.isArray(data.subscribe_items) ? data.subscribe_items : [];
  return {
    items,
    hasMore: data.has_more === true,
    nextOffset: Number(data.next_offset ?? offset + items.length) || 0,
    sessionId: String(data.session_id || sessionId),
  };
}

module.exports = {
  UPCOMING_PATH,
  PAGE_LIMIT,
  MAX_PAGES,
  reservationCount,
  selectUpcoming,
  absorbUpcoming,
  fetchUpcomingPage,
};
