import { clipDanmakuText, measureDanmakuText } from './danmakuEmoji.mjs';

export const DEFAULT_DANMAKU_SETTINGS = Object.freeze({ opacity: 80, fontSize: 22, speed: 1, area: 'half', density: 'normal', sensitiveFilter: true, blockedWords: '' });

// 时间轴不够 25 条时，用本集评论补到大约 25 条。
// 时间轴已经够 25 条就不再补；播放最多 35 条，避免一集里时间轴太密。
export const DANMAKU_MIX_TARGET = 25;
export const TIMELINE_PLAYBACK_CAP = 35;

export function commentFillCount(timelineCount) {
  const count = Number.isFinite(timelineCount) ? Math.max(0, Math.floor(timelineCount)) : 0;
  return Math.max(0, DANMAKU_MIX_TARGET - count);
}

export function normalizeDanmakuSettings(value) {
  const number = (key, min, max) => typeof value?.[key] === 'number' && Number.isFinite(value[key])
    ? Math.max(min, Math.min(max, value[key])) : DEFAULT_DANMAKU_SETTINGS[key];
  return {
    opacity: number('opacity', 20, 100), fontSize: number('fontSize', 16, 32), speed: number('speed', 0.5, 2),
    area: ['quarter', 'half', 'full'].includes(value?.area) ? value.area : 'half',
    density: ['sparse', 'normal', 'dense'].includes(value?.density) ? value.density : 'normal',
    sensitiveFilter: value?.sensitiveFilter !== false,
    blockedWords: typeof value?.blockedWords === 'string' ? value.blockedWords.slice(0, 10000) : '',
  };
}

const BUILTIN_BLOCKED_WORDS = ['习近平', '習近平', '共产党', '共產黨', '中国共产党', '中共', '国民党', '國民黨', '民进党', '民進黨',
  '毛泽东', '毛澤東', '邓小平', '鄧小平', '江泽民', '江澤民', '胡锦涛', '胡錦濤', '李克强', '李克強', '蔡英文', '赖清德', '賴清德',
  '台独', '台獨', '港独', '港獨', '藏独', '藏獨', '疆独', '疆獨', '六四', '天安门事件', '天安門事件', '法轮功', '法輪功', '反共', '反华', '反華',
  '文革', '文化大革命', '政治局', '颠覆政权', '顛覆政權', '操你妈', '操你媽', '傻逼', '傻屄'];
const comparable = text => text.normalize('NFKC').toLowerCase().replace(/[\s\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
const cleanText = text => text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

export function commentIsBlocked(content, settings) {
  const words = (settings.blockedWords || '').split(/[\n,，;；]+/).map(comparable).filter(Boolean);
  if (settings.sensitiveFilter) words.push(...BUILTIN_BLOCKED_WORDS);
  const text = comparable(content);
  return words.some(word => text.includes(word));
}

export function createCommentFeed(seriesId, episodeId) {
  return { seriesId: String(seriesId), episodeId: String(episodeId), comments: [], seen: new Set(), cursors: new Set(), cursor: null,
    hasMore: true, emptyPages: 0, pages: 0, loading: false, loaded: false, error: '', notice: '', lastRequest: 0,
    attempts: 0, emptyTries: 0, nextTryAt: 0,
    animation: { items: [], cursor: 0, nextId: 0, cooldown: 0 } };
}

const COMMENT_RETRY_DELAYS = [3000, 7000, 15000];

export function commentFetchBlocked(feed, now, hidden) {
  if (hidden || feed.loading || !feed.hasMore || feed.error) return true;
  if (feed.nextTryAt && now < feed.nextTryAt) return true;
  if (feed.comments.length - (feed.animation?.cursor || 0) >= 15) return true;
  if (now - feed.lastRequest < 1500) return true;
  return false;
}

// 超时、限流和空页面都先再试。确认过仍然没有，才停下来给用户重试。
export function commentFailureAction(feed, data, now) {
  const message = typeof data?.error === 'string' ? data.error : '';
  const retryable = data == null || data.retryable === true;
  feed.attempts = (feed.attempts || 0) + 1;
  if (retryable && feed.attempts < 4) {
    feed.nextTryAt = now + (COMMENT_RETRY_DELAYS[feed.attempts - 1] || 15000);
    feed.notice = '本集评论暂时没有载入，稍后会再试';
    feed.error = '';
    return 'retry';
  }
  feed.nextTryAt = 0;
  feed.error = message || '本集评论加载失败，可重试继续加载';
  return 'stop';
}

export function acceptCommentPage(feed, data, settings, now) {
  if (!data?.success || !Array.isArray(data.items) || String(data.series_id) !== feed.seriesId || String(data.episode_id) !== feed.episodeId) {
    return commentFailureAction(feed, data, now);
  }
  if (!data.items.length && (feed.emptyTries || 0) < 1) {
    feed.emptyTries = (feed.emptyTries || 0) + 1;
    feed.nextTryAt = now + 4000;
    feed.notice = '正在再确认一次本集评论';
    feed.error = '';
    return 'retry';
  }
  appendCommentPage(feed, data, settings);
  feed.attempts = 0;
  feed.nextTryAt = 0;
  return 'done';
}

export function appendCommentPage(feed, data, settings) {
  if (!data?.success || String(data.series_id) !== feed.seriesId || String(data.episode_id) !== feed.episodeId || !Array.isArray(data.items)) throw new Error('Invalid episode comment page');
  let accepted = 0;
  for (const item of data.items) {
    if (typeof item?.content !== 'string') continue;
    const content = cleanText(item.content);
    if (!content) continue;
    const id = item.id == null || item.id === '' ? `text:${content}` : `id:${item.id}`;
    if (feed.seen.has(id)) continue;
    feed.seen.add(id);
    feed.comments.push({ id, content });
    if (!commentIsBlocked(content, settings)) accepted++;
  }
  feed.loaded = true;
  feed.sourceLimited = data.source_limited === true;
  if (feed.sourceLimited) feed.notice = typeof data.notice === 'string' && data.notice ? data.notice : '公开网页仅提供部分评论，暂无可用后续页';
  feed.pages++;
  feed.emptyPages = accepted ? 0 : feed.emptyPages + 1;
  const next = typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null;
  feed.hasMore = data.has_more === true && next !== null && next !== feed.cursor && !feed.cursors.has(next);
  if (data.has_more === true && !feed.hasMore) feed.notice = '评论游标未前进，已停止加载';
  if (feed.hasMore) { feed.cursor = next; feed.cursors.add(next); }
  if (feed.hasMore && feed.emptyPages >= 5) feed.error = '连续多页没有可显示的新评论，可继续加载';
  // shortcut: bound per-episode memory and requests; add queue compaction if a real viewing session reaches this limit.
  if (feed.pages >= 500) { feed.hasMore = false; feed.notice = '已达到本次评论加载上限'; }
}

export function danmakuLayout({ height, settings, reducedMotion, bottomInset = 76 }) {
  const top = 12;
  const lineHeight = settings.fontSize + 12;
  const bottom = Math.min(height - bottomInset, height * ({ quarter: 0.25, half: 0.5, full: 1 }[settings.area] ?? 0.5));
  return { top, lineHeight, lanes: reducedMotion ? 1 : Math.max(1, Math.floor((bottom - top) / lineHeight)) };
}

export function resizeDanmaku(state, before, after) {
  if (after.width < 40 || after.height < 60) return false;
  const { top, lineHeight, lanes } = danmakuLayout(after);
  const placed = [];
  for (const item of state.items) {
    const x = after.reducedMotion ? 12 : after.width - (before.width - item.x) / (before.width + item.width) * (after.width + item.width);
    const lane = Array.from({ length: lanes }, (_, offset) => (item.lane + offset) % lanes).find(index =>
      !placed.some(other => other.lane === index && x < other.x + other.width + 24 && x + item.width + 24 > other.x));
    if (lane === undefined) continue; // 缩小后放不下的条目才移除，保留时间光标与可见弹幕。
    Object.assign(item, { x, lane, y: top + lane * lineHeight });
    placed.push(item);
  }
  state.items = placed;
  return true;
}

// 飞出画面就结束。不再放回复用队列，避免同一条在时间轴走完或评论很少时不停重播。
export function retireDanmaku(state, reducedMotion) {
  state.items = state.items.filter(item => (reducedMotion ? item.age < 6 : item.x + item.width > 0));
}

// 本集评论没有视频时间点。节奏按这一集的种子打散，换集就换一套间隔、轨道和速度。
// 时间轴弹幕走 advanceTimedDanmaku，不经过这里。
export function danmakuSeed(seriesId, episodeId) {
  let hash = 2166136261;
  for (const char of `${seriesId}\0${episodeId}`) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return (hash >>> 0) || 1;
}

function roll(state) {
  let value = state.randState | 0;
  value = (value + 0x6D2B79F5) | 0;
  let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  state.randState = value >>> 0;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

function armCommentSchedule(state, seed) {
  const next = (seed >>> 0) || 1;
  if (state.scheduleSeed === next) return;
  state.scheduleSeed = next;
  state.randState = next;
  state.clock = 0;
  state.nextGap = 0.02 + roll(state) * 0.05;
}

function commentGap(density, draw, duration, total) {
  if (Number.isFinite(duration) && duration >= 8 && total > 0) {
    const pace = density === 'sparse' ? 1.45 : density === 'dense' ? 0.72 : 1;
    const slot = Math.min(duration * 0.9, 180) / total;
    const jitter = 0.62 + draw() * 0.7;
    const pause = draw() < 0.18 ? draw() * slot * pace : 0;
    return Math.max(0.45, slot * pace * jitter + pause);
  }
  const base = density === 'sparse' ? 2.3 : density === 'dense' ? 0.45 : 1.15;
  const spread = density === 'sparse' ? 2.1 : density === 'dense' ? 0.95 : 1.45;
  const pause = draw() < 0.16 ? 0.7 + draw() * 1.6 : 0;
  return base + draw() * spread + pause;
}

function commentLaneOpen(state, lane, y, lineHeight, x, textWidth) {
  return !state.items.some(item => {
    const sameLane = item.lane === lane || Math.abs(item.y - y) < lineHeight;
    return sameLane && x < item.x + item.width + 24 && x + textWidth + 24 > item.x;
  });
}

// 后发的可以更慢，但不能比同道上已经在飞的更快，否则会从后面追上并盖住。
function laneSpeedCap(state, lane) {
  let cap = 1.18;
  for (const item of state.items) if (item.lane === lane) cap = Math.min(cap, item.speed || 1);
  return cap;
}

// 时间轴弹幕没有自己的随机速度，缺省就是 1。同一行只要有它，评论就改成这个速度。
function foreignSpeed(obstacles, y, lineHeight) {
  let speed = null;
  for (const other of obstacles || []) {
    if (!other || Math.abs((Number(other.y) || 0) - y) >= lineHeight) continue;
    const value = Number.isFinite(other.speed) && other.speed > 0 ? other.speed : 1;
    speed = speed == null ? value : Math.min(speed, value);
  }
  return speed;
}

function foreignClear(obstacles, y, lineHeight, x, textWidth) {
  return !(obstacles || []).some(other => Math.abs(other.y - y) < lineHeight
    && x < other.x + other.width + 24 && x + textWidth + 24 > other.x);
}

// 本集评论让路。时间轴仍按自己的速度走，不改它的位置。
// 同一行的评论改成和时间轴一样的速度：更快会追上它，更慢则会被它从后面盖住。
// 已经叠在一起时，把评论推到时间轴后面，间距沿用同一条 24px。
export function yieldToForeignDanmaku(state, obstacles, lineHeight, gap = 24) {
  if (!obstacles?.length) return;
  for (const item of state.items) {
    const matched = foreignSpeed(obstacles, item.y, lineHeight);
    if (matched == null) continue;
    item.speed = matched;
    for (let guard = 0; guard <= obstacles.length; guard++) {
      let pushed = false;
      for (const other of obstacles) {
        if (!other || Math.abs((Number(other.y) || 0) - item.y) >= lineHeight) continue;
        const overlaps = item.x < other.x + other.width + gap && item.x + item.width + gap > other.x;
        const behind = other.x + other.width + gap;
        if (overlaps && item.x < behind) {
          item.x = behind;
          pushed = true;
        }
      }
      if (!pushed) break;
    }
  }
}

export function keepDanmakuSpacing(state, gap = 24) {
  const groups = new Map();
  for (const item of state.items) {
    const list = groups.get(item.lane);
    if (list) list.push(item);
    else groups.set(item.lane, [item]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.x - b.x);
    for (let index = 1; index < list.length; index++) {
      const ahead = list[index - 1];
      const behind = list[index];
      const minX = ahead.x + ahead.width + gap;
      if (behind.x < minX) {
        behind.x = minX;
        if ((behind.speed || 1) > (ahead.speed || 1)) behind.speed = ahead.speed || 1;
      }
    }
  }
}

export function advanceDanmaku(state, comments, elapsed, { width, height, settings, reducedMotion, bottomInset = 76, seed = 1, obstacles = [], duration = 0 }) {
  if (!(elapsed > 0) || !comments.length || width < 40 || height < 60) return false;
  const delta = Math.min(elapsed, 0.25);
  const layout = danmakuLayout({ height, settings, reducedMotion, bottomInset });
  const { lineHeight, top } = layout;
  const laneCap = reducedMotion ? 1 : ({ sparse: 3, normal: 5, dense: 7 }[settings.density] ?? 5);
  const lanes = Math.min(layout.lanes, laneCap);
  const before = state.items.length;
  for (const item of state.items) {
    item.age += delta;
    if (!reducedMotion) item.x -= 85 * settings.speed * (item.speed || 1) * delta;
  }
  if (!reducedMotion) {
    yieldToForeignDanmaku(state, obstacles, lineHeight);
    keepDanmakuSpacing(state);
  }
  retireDanmaku(state, reducedMotion);
  let changed = before !== state.items.length;
  if (reducedMotion) {
    state.cooldown = Math.max(0, (state.cooldown || 0) - delta);
    const lane = state.items.length ? undefined : 0;
    if (state.cooldown === 0 && lane !== undefined) {
      let content = '';
      while (state.cursor < comments.length) {
        const comment = comments[state.cursor++];
        const full = typeof comment === 'string' ? comment : comment.content;
        if (!commentIsBlocked(full, settings)) { content = full; break; }
      }
      if (!content) return changed;
      const text = clipDanmakuText(content);
      state.items.push({ id: state.nextId++, text, content, lane, x: 12, y: top, width: measureDanmakuText(text, settings.fontSize), age: 0, speed: 1 });
      state.cooldown = 6;
      changed = true;
    }
    return changed;
  }
  armCommentSchedule(state, seed);
  if (state.clock === 0 && Number.isFinite(duration) && duration >= 8) {
    state.nextGap = commentGap(settings.density, () => roll(state), duration, comments.length);
  }
  state.clock += delta;
  if (state.clock < state.nextGap) return changed;
  let content = '';
  let nextCursor = state.cursor;
  while (nextCursor < comments.length) {
    const comment = comments[nextCursor++];
    const full = typeof comment === 'string' ? comment : comment.content;
    if (!commentIsBlocked(full, settings)) { content = full; break; }
  }
  if (!content) {
    state.cursor = nextCursor;
    return changed;
  }
  const text = clipDanmakuText(content);
  const textWidth = measureDanmakuText(text, settings.fontSize);
  const open = [];
  for (let lane = 0; lane < lanes; lane++) {
    const y = top + lane * lineHeight;
    if (commentLaneOpen(state, lane, y, lineHeight, width, textWidth) && foreignClear(obstacles, y, lineHeight, width, textWidth)) open.push(lane);
  }
  if (!open.length) return changed;
  state.cursor = nextCursor;
  // 有空行时不要跟时间轴挤在同一行，评论才能用自己的速度。只有行都被占住才共行，并改成相同速度。
  const quiet = open.filter(lane => foreignSpeed(obstacles, top + lane * lineHeight, lineHeight) == null);
  const pool = quiet.length ? quiet : open;
  const lane = pool[Math.floor(roll(state) * pool.length)];
  const y = top + lane * lineHeight;
  const matched = foreignSpeed(obstacles, y, lineHeight);
  const speed = matched == null
    ? Math.min(0.68 + roll(state) * 0.64, laneSpeedCap(state, lane))
    : Math.min(matched, laneSpeedCap(state, lane));
  // 从画面外进入。开播时不要把整批评论摆进画面。
  state.items.push({ id: state.nextId++, text, content, lane, x: width, y, width: textWidth, age: 0, speed });
  state.nextGap = state.clock + commentGap(settings.density, () => roll(state), duration, comments.length);
  return true;
}
