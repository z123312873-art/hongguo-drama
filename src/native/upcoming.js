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

function taipeiParts(seconds) {
  const instant = Number(seconds);
  if (!Number.isFinite(instant) || instant <= 0) return null;
  const shifted = new Date(instant * 1000 + TAIPEI_OFFSET_MS);
  return { month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), time: instant * 1000 };
}

function reservationPhrase(count) {
  const value = Number(count);
  if (!Number.isFinite(value) || value <= 0) return '';
  const unit = value >= 100000000 ? [100000000, '亿'] : value >= 10000 ? [10000, '万'] : null;
  if (!unit) return `预约人数${Math.round(value)}人预约`;
  const text = (value / unit[0]).toFixed(1).replace(/\.0$/, '');
  return `预约人数${text}${unit[1]}人预约`;
}

function onlineLabel(timestamp) {
  if (!timestamp) return '';
  return `预计${timestamp.month}月${timestamp.day}日上线`;
}

function selectUpcoming(items, now = Date.now()) {
  const rows = [];
  for (const item of items || []) {
    if (!item) continue;
    const title = String(item.name || item.title || '').trim();
    const id = String(item.item_id || item.series_id || item.id || '').trim();
    if (!title || !id) continue;
    const sentence = String(item.sub_info || item.schedule_text || '');
    const timestamp = taipeiParts(item.expected_publish_time);
    if (!timestamp) continue;
    const reservations = reservationCount(item.expected_rec_text) || unitReservation(sentence);
    const cover = comicCover(item.cover || item.cover_url || '', 320);
    rows.push({
      series_id: id,
      series_title: title,
      cover: cover,
      online_label: onlineLabel(timestamp),
      online_time: timestamp.time,
      reservations,
      reservation_label: reservationPhrase(reservations),
      is_new: false,
      is_premiere: false,
      rating: null,
      heat: '',
    });
  }
  rows.sort((a, b) => a.online_time - b.online_time || b.reservations - a.reservations || a.series_title.localeCompare(b.series_title, 'zh'));
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
  reservationPhrase,
  selectUpcoming,
  absorbUpcoming,
  fetchUpcomingPage,
};
