



import { clipDanmakuText, measureDanmakuText } from './danmakuEmoji.mjs';
import { commentIsBlocked, danmakuLayout, keepDanmakuSpacing, retireDanmaku, TIMELINE_PLAYBACK_CAP } from './danmakuModel.mjs';

export const DANMAKU_SOURCES = Object.freeze(['official', 'comments']);


export const DEFAULT_DANMAKU_SOURCE = 'official';

export function normalizeDanmakuSource(value) {
  return DANMAKU_SOURCES.includes(value) ? value : DEFAULT_DANMAKU_SOURCE;
}

export const SOURCE_LABELS = Object.freeze({
  official: '时间轴弹幕',
  comments: '本集评论',
});



const LANE_HEAD_GAP = 24;


const MAX_EMIT_PER_FRAME = 4;


const EMIT_INTERVAL = Object.freeze({ sparse: 0.4, normal: 0.15, dense: 0.05 });


const STALE_SECONDS = 5;








const REDUCED_MOTION_READ_SECONDS = 6;








function isSeek(lastTime, currentTime, elapsed) {
  if (lastTime === undefined) return true;
  const jump = currentTime - lastTime;
  if (jump < 0) return true;
  return jump > elapsed * 3 + 1;
}


export function lowerBoundTime(list, currentTime) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].time < currentTime) low = mid + 1;
    else high = mid;
  }
  return low;
}


export function selectTimelinePlayback(items) {
  if (!Array.isArray(items)) return [];
  const sorted = items.slice().sort((a, b) => (a?.time || 0) - (b?.time || 0));
  const cap = TIMELINE_PLAYBACK_CAP;
  if (sorted.length <= cap) return sorted;
  const last = sorted.length - 1;
  const used = new Set();
  const indexes = [];
  for (let slot = 0; slot < cap; slot++) {
    let index = Math.round(slot * last / (cap - 1));
    if (used.has(index)) {
      let step = 1;
      while (step <= last) {
        if (index + step <= last && !used.has(index + step)) { index += step; break; }
        if (index - step >= 0 && !used.has(index - step)) { index -= step; break; }
        step += 1;
      }
    }
    used.add(index);
    indexes.push(index);
  }
  indexes.sort((a, b) => a - b);
  return indexes.map(index => sorted[index]);
}

export function createOfficialFeed(seriesId, vid) {
  return {
    source: 'official',
    seriesId: String(seriesId ?? ''),
    vid: String(vid ?? ''),
    danmaku: [],
    loaded: false,
    loading: false,
    error: '',
    notice: '',
    truncated: false,
    partial: false,


    animation: { items: [], nextId: 0, cursor: 0, cooldown: 0, lastTime: undefined },
  };
}








export function appendOfficialPage(feed, data) {
  if (!data || typeof data !== 'object' || typeof data.success !== 'boolean' || !Array.isArray(data.items)) throw new Error('Invalid official danmaku page');
  if (String(data.series_id) !== feed.seriesId || String(data.episode_id) !== feed.vid) {
    throw new Error('Invalid official danmaku page');
  }
  const incoming = Array.isArray(data.items) ? data.items : [];
  const seen = new Set(feed.danmaku.map(item => `${item.time.toFixed(3)}|${item.text}`));
  for (const item of incoming) {
    if (!item || typeof item.text !== 'string' || !Number.isFinite(item.time)) continue;
    const key = `${item.time.toFixed(3)}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    feed.danmaku.push(item);
  }
  feed.danmaku.sort((a, b) => a.time - b.time);
  feed.loaded = true;
  feed.truncated = data.truncated === true;
  feed.partial = data.partial === true;
  feed.notice = (typeof data.notice === 'string' ? data.notice : '') || (feed.partial ? '仅取得部分弹幕，可重试加载' : feed.truncated ? '已达到本次读取限制，仅展示部分弹幕' : '');
  feed.animation.lastTime = undefined;
  feed.error = data.success === false ? (typeof data.error === 'string' && data.error ? data.error : '弹幕加载失败') : '';
  return feed;
}











export function advanceTimedDanmaku(state, danmaku, currentTime, elapsed, options) {
  const { width, height, settings, reducedMotion } = options;
  if (!(width >= 40) || !(height >= 60)) return false;
  const list = Array.isArray(danmaku) ? danmaku : [];
  const delta = Math.min(Math.max(elapsed, 0), 0.25);
  let changed = false;

  const emitting = options.emitting !== false;
  const staleAfter = reducedMotion ? REDUCED_MOTION_READ_SECONDS : STALE_SECONDS;
  if (emitting && isSeek(state.lastTime, currentTime, elapsed)) {

    state.cursor = lowerBoundTime(list, Math.max(0, currentTime - staleAfter));
    state.cooldown = 0;
  }
  if (emitting) state.lastTime = currentTime;

  const before = state.items.length;
  for (const item of state.items) {
    item.age += delta;
    if (!reducedMotion) item.x -= 85 * settings.speed * delta;
  }
  if (!reducedMotion) keepDanmakuSpacing(state);
  retireDanmaku(state, reducedMotion);
  if (state.items.length !== before) changed = true;
  state.cooldown = Math.max(0, state.cooldown - delta);

  const { top, lineHeight, lanes } = danmakuLayout(options);

  const obstacles = Array.isArray(options.obstacles) ? options.obstacles : [];
  const laneFree = index => {
    const y = top + index * lineHeight;
    const occupants = state.items.filter(item => item.lane === index || Math.abs(item.y - y) < lineHeight);
    const foreign = obstacles.filter(item => item && Math.abs((Number(item.y) || 0) - y) < lineHeight);
    const blockers = occupants.concat(foreign);
    if (!blockers.length) return true;

    const newest = blockers.reduce((a, b) => ((Number(a.x) || 0) > (Number(b.x) || 0) ? a : b));
    return (Number(newest.x) || 0) + (Number(newest.width) || 0) + LANE_HEAD_GAP <= width;
  };

  let emitted = 0;
  while (emitting && emitted < MAX_EMIT_PER_FRAME) {
    let entry = list[state.cursor];
    const timed = entry && entry.time <= currentTime;
    const stale = timed && currentTime - entry.time > staleAfter;
    const blocked = timed && commentIsBlocked(entry.text, settings);
    const visible = timed && state.items.some(item => item.entry === entry);
    if (blocked || stale || visible) {
      state.cursor++;
      continue;
    }
    if (state.cooldown > 0) break;

    const candidates = Array.from({ length: lanes }, (_, index) => index);

    const lane = candidates.find(laneFree);
    if (lane === undefined) break;
    if (!timed) break;

    const text = clipDanmakuText(entry.text);
    const textWidth = measureDanmakuText(text, settings.fontSize);
    state.items.push({
      id: state.nextId++,
      text,
      content: entry.text,
      entry,
      color: entry.color,
      mode: entry.mode,
      lane,
      x: reducedMotion ? 12 : width,
      y: top + lane * lineHeight,
      width: textWidth,
      age: 0,
      speed: 1,
    });
    state.cooldown = reducedMotion ? REDUCED_MOTION_READ_SECONDS : (EMIT_INTERVAL[settings.density] ?? EMIT_INTERVAL.normal);
    if (timed) state.cursor++;
    emitted++;
    changed = true;
  }

  return changed;
}








export function resolveDanmakuStatus({ source, supported, enabled, active, visible, error, loading, notice, loaded, count }) {
  if (!supported) return source === 'official' ? '仅红果来源的剧集支持弹幕' : '仅红果来源的当前集支持评论弹幕';
  if (!enabled) return source === 'official' ? '开启后按视频时间展示时间轴弹幕' : '开启后展示本集公开评论';
  if (!active) return source === 'official' ? '播放本集后显示弹幕' : '播放本集后显示评论弹幕';
  if (!visible) return '';

  if (error) return error;
  if (loading) return '正在加载弹幕…';
  if (notice && !count) return notice;
  if (!loaded) return '正在加载弹幕…';
  if (!count) return notice || '本集暂无弹幕';
  return `已载入 ${count} 条弹幕${notice ? `（${notice}）` : ''}`;
}
