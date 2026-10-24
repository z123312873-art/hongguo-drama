import { clipDanmakuText } from './danmakuEmoji.mjs';

export const DEFAULT_DANMAKU_SETTINGS = Object.freeze({ opacity: 80, fontSize: 22, speed: 1, area: 'half', density: 'normal', sensitiveFilter: true, blockedWords: '' });

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
    animation: { items: [], cursor: 0, nextId: 0, cooldown: 0 } };
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

// Only fully departed comments enter the replay queue; active comments are never cloned.
export function retireDanmaku(state, reducedMotion) {
  state.replayQueue ??= [];
  state.items = state.items.filter(item => {
    if (reducedMotion ? item.age < 6 : item.x + item.width > 0) return true;
    if (!reducedMotion && !state.replayQueue.some(old => old.content === item.content)) state.replayQueue.push(item);
    return false;
  });
}

export function takeDanmakuReplay(state, options, pending = 0, currentTime = Infinity) {
  const { settings, reducedMotion } = options;
  if (reducedMotion) return undefined;
  const { lanes } = danmakuLayout(options);
  const target = { sparse: 1, normal: 3, dense: Math.max(6, lanes * 2) }[settings.density];
  if (state.items.length + pending >= target) return undefined;
  const index = state.replayQueue.findIndex(item =>
    (!item.entry || item.entry.time <= currentTime) && !commentIsBlocked(item.content, settings) &&
    !state.items.some(active => active.content === item.content));
  return index < 0 ? undefined : state.replayQueue.splice(index, 1)[0];
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

function commentGap(density, draw) {
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

export function advanceDanmaku(state, comments, elapsed, { width, height, settings, reducedMotion, bottomInset = 76, seed = 1 }) {
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
      state.items.push({ id: state.nextId++, text, content, lane, x: 12, y: top, width: (Array.from(text).length + 1) * settings.fontSize, age: 0, speed: 1 });
      state.cooldown = 6;
      changed = true;
    }
    return changed;
  }
  armCommentSchedule(state, seed);
  state.clock += delta;
  if (state.clock < state.nextGap) return changed;
  let content = '';
  let nextCursor = state.cursor;
  while (nextCursor < comments.length) {
    const comment = comments[nextCursor++];
    const full = typeof comment === 'string' ? comment : comment.content;
    if (!commentIsBlocked(full, settings)) { content = full; break; }
  }
  const fromReplay = !content;
  if (fromReplay) content = takeDanmakuReplay(state, { width, height, settings, reducedMotion, bottomInset })?.content;
  if (!content) {
    state.cursor = nextCursor;
    return changed;
  }
  const text = clipDanmakuText(content);
  const textWidth = (Array.from(text).length + 1) * settings.fontSize;
  const open = [];
  for (let lane = 0; lane < lanes; lane++) {
    const y = top + lane * lineHeight;
    if (commentLaneOpen(state, lane, y, lineHeight, width, textWidth)) open.push(lane);
  }
  if (!open.length) {
    if (fromReplay) state.replayQueue?.unshift({ content });
    return changed;
  }
  state.cursor = nextCursor;
  const lane = open[Math.floor(roll(state) * open.length)];
  const speed = 0.84 + roll(state) * 0.34;
  // 从画面外进入。开播时不要把整批评论摆进画面。
  state.items.push({ id: state.nextId++, text, content, lane, x: width, y: top + lane * lineHeight, width: textWidth, age: 0, speed });
  state.nextGap = state.clock + commentGap(settings.density, () => roll(state));
  return true;
}
