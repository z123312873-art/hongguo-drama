// Adapted from dawei233/hongguo-drama (GPL-3.0), commit c884fab6c6e36ad38173e251738b9b35f958383f.
// https://github.com/dawei233/hongguo-drama/tree/c884fab6c6e36ad38173e251738b9b35f958383f
'use strict';

/**
 * 红果官方弹幕抓取（带视频时间轴的真弹幕）。
 *
 * ## 与「本集评论」的区别
 *
 * `episode-comments.js` 抓的是官网**匿名**页面上那 15 条剧评，与视频时间无关，
 * 严格说不是弹幕。本模块抓的是官方客户端使用的分时弹幕接口：
 *
 *     POST https://api5-normal-sinfonlineb.fqnovel.com/novel/commentapi/comment/list/{vid}/v1/
 *
 * 每条弹幕都带 `offset_time`（毫秒），转换为秒后即可按播放进度投放。
 *
 * ## 不可控依赖（务必知情）
 *
 * 这个接口不是公开接口，需要伪造官方客户端的签名头（X-Gorgon / X-Argus /
 * X-Ladon）。上游随时可能改算法、改参数或封禁，**本模块无法保证长期可用**。
 * 因此：
 *   - 任何失败都返回 `success: false` 加一句人话说明，绝不抛异常；
 *   - 时间轴优先。一集大约 25 条，不够的部分才补本集评论；超过 60 条不再取评论。
 *     一条都没有或整次失败时，仍可显示本集评论兜底，但失败说明保持原样，不能改口说成没有弹幕；
 *   - 界面上不得把"拿不到"说成"本集没有弹幕"。
 *
 * ## 与参考实现的关系
 *
 * 分页与解析逻辑移植自 `nas-backend/danmaku.py`（后者是 guoapp Go 版的移植）。
 * 其中分页信号的两个来源、连续空页提前停止等细节都是参考实现实测踩出来的，
 * 注释里保留了原因，不要凭直觉"简化"。
 */

const axios = require('axios');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const sign = require('./danmaku-sign');

const BASE_URL = 'https://api5-normal-sinfonlineb.fqnovel.com';
const COMMENT_PATH = vid => `/novel/commentapi/comment/list/${encodeURIComponent(vid)}/v1/`;

// 冒充官方 Android 客户端；UA 与签名参数必须成套，不能只改一个。
const USER_AGENT =
  'com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; ' +
  'Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)';

const MAX_TEXT_LEN = 200;              // 超长文本直接丢弃（正常弹幕不会这么长）
const MAX_TIME_SECONDS = 604800;       // 7 天，超出视为脏数据
const PAGE_COUNT = 90;                 // 单次向上游要的条数
const MAX_PAGES = 40;                  // 分页上限，防死循环
const MAX_ITEMS = 3000;                // 单集上限，防内存与 IPC 载荷失控
const REQUEST_TIMEOUT = 20000;
const EFFECTIVE_DURATION_MS = 3600000; // 单次请求声明的"剧集时长"
const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // 上游窗口上限，超过会被拒
const MAX_EMPTY_PAGES = 2;             // 连续空页就停：上游偶尔 has_more=true 却一直给空
const PAGE_GAP_MS = 120;               // 相邻分页间隔，别把上游打急
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const CACHE_TTL_OK = 5 * 60 * 1000;
const CACHE_TTL_FAIL = 15 * 1000;
const CACHE_MAX = 64;

const cache = new Map();
const reviewCache = new Map();
const pending = new Map();
let danmakuLane = Promise.resolve();

function enqueueDanmaku(task) {
  const run = danmakuLane.then(task, task);
  danmakuLane = run.then(() => {}, () => {});
  return run;
}

// 上游按匿名标识分配弹幕子集，跨重启必须复用同一份本机标识。
let identity = null;
let identityFile = null;
function setDeviceIdentityFile(file) {
  identityFile = file;
  identity = null;
}
const deviceIdentity = () => {
  if (identity) return identity;
  const create = () => ({ deviceId: sign.newDeviceId(), installId: sign.newDeviceId() });
  if (!identityFile) return (identity = create());
  try {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(identityFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      saved = create();
      try { fs.writeFileSync(identityFile, JSON.stringify(saved), { flag: 'wx', mode: 0o600 }); }
      catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        saved = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      }
    }
    if (typeof saved?.deviceId !== 'string' || typeof saved?.installId !== 'string' ||
        !/^\d{19}$/.test(saved.deviceId) || !/^\d{19}$/.test(saved.installId)) throw new Error('Invalid local client');
    identity = { deviceId: saved.deviceId, installId: saved.installId };
  } catch {
    const error = new Error('Danmaku local configuration unavailable');
    error.code = 'DANMAKU_IDENTITY_IO';
    throw error;
  }
  return identity;
};

/** 仅供测试：覆盖进程内设备指纹。 */
function setDeviceIdentity(value) {
  identity = value;
}

// ── 解析（对齐参考实现的清洗规则） ────────────────────────────────────────

const asText = value => (value === null || value === undefined ? '' : typeof value === 'boolean' ? (value ? '1' : '0') : String(value));

/** 归一成 `#RRGGBB`，拿不到用白色。 */
function normalizeColor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) return '#FFFFFF';
    return `#${(value & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0')}`;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '#FFFFFF';
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) return '#' + [...text.slice(1)].map(char => char + char).join('').toUpperCase();
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) return '#FFFFFF';
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed >= 0) return `#${(parsed & 0xFFFFFF).toString(16).toUpperCase().padStart(6, '0')}`;
  }
  return '#FFFFFF';
}

/**
 * 归一成 scroll / top / bottom。
 *
 * 红果评论接口目前**不下发**位置字段，所以实测恒为 `scroll`。保留多 holder 的
 * 兜底识别，是给上游将来补字段留的口子；不要因为"反正总是 scroll"就删掉。
 */
function normalizeMode(...holders) {
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of ['mode', 'danmaku_type', 'position', 'fix_type', 'danmaku_position']) {
      const value = holder[key];
      if (value === null || value === undefined) continue;
      const token = asText(value).trim().toLowerCase();
      if (['top', '2', 'fix_top', '顶部'].includes(token)) return 'top';
      if (['bottom', '3', 'fix_bottom', '底部'].includes(token)) return 'bottom';
    }
  }
  return 'scroll';
}

/** 控制字符与行分隔符换成空格，避免污染渲染层。 */
function cleanControl(text) {
  let out = '';
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    out += code < 0x20 || code === 0x7f || char === '\u2028' || char === '\u2029' ? ' ' : char;
  }
  return out.trim();
}

/** 毫秒 → 秒，并挡掉越界值。 */
function toSeconds(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const seconds = num / 1000;
  if (seconds < 0 || seconds > MAX_TIME_SECONDS) return null;
  return seconds;
}

/**
 * 解析一页，返回 `{ items, nextMs }`。
 *
 * 分页信号有两个来源，实测里都出现过：
 *   1. `data.extra.next_query_danmaku_list_time` —— 参考实现用的就是这个；
 *   2. `data.common_list_info`（`has_more` + `cursor.end_offset_time`）。
 * 实测响应里 `extra` 常常是空对象，真正的"还有没有"写在 `common_list_info` 里。
 * 只认第 1 个的话，`extra` 一空就会把"还有更多"误判成"没有了"，于是整集只拿到
 * 首页 90 条。两个都读，显式的 `has_more: false` 优先。
 */
function parsePage(payload, vid) {
  const empty = { items: [], nextMs: null, hasMore: null };
  if (!payload || typeof payload !== 'object') return empty;
  const data = payload.data;
  if (!data || typeof data !== 'object') return empty;
  const rows = Array.isArray(data.data_list) ? data.data_list : [];

  let nextMs = null;
  let hasMore = null;

  const extra = data.extra;
  if (extra && typeof extra === 'object') {
    const raw = asText(extra.next_query_danmaku_list_time).trim();
    if (raw) {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) nextMs = parsed;
    }
  }

  const info = data.common_list_info;
  if (info && typeof info === 'object') {
    const flag = info.has_more;
    if (typeof flag === 'boolean') hasMore = flag;
    else if (typeof flag === 'string') hasMore = ['1', 'true', 'yes'].includes(flag.trim().toLowerCase());
    else if (asText(flag)) hasMore = !['0', 'false', 'no'].includes(asText(flag));

    let cursor = info.cursor;
    if (typeof cursor === 'string' && cursor.trim().startsWith('{')) {
      try {
        cursor = JSON.parse(cursor);
      } catch {
        cursor = null;
      }
    }
    if (cursor && typeof cursor === 'object') {
      for (const key of ['end_offset_time', 'next_offset_time', 'offset']) {
        const candidate = Number.parseInt(cursor[key], 10);
        if (!Number.isFinite(candidate)) continue;
        if (nextMs === null || candidate > nextMs) nextMs = candidate;
        break;
      }
    }
  }

  // 明确说没有更多了，就别再翻（此时即便有 cursor 也不该继续）
  if (hasMore === false) nextMs = null;

  const items = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const comment = raw.comment;
    if (!comment || typeof comment !== 'object') continue;
    const common = comment.common && typeof comment.common === 'object' ? comment.common : {};

    // 只收本视频、且状态正常的弹幕：别的值会把待审核/已折叠的脏数据混进来
    const groupId = asText(common.group_id);
    if (groupId && groupId !== vid) continue;
    if (asText(common.status) !== '1') continue;

    const content = common.content;
    const text = asText(content && typeof content === 'object' ? content.text : null);

    const expand = comment.expand && typeof comment.expand === 'object' ? comment.expand : {};
    let timeRaw = expand.offset_time;
    if (timeRaw === null || timeRaw === undefined) timeRaw = comment.offset_time;

    let colorRaw;
    for (const holder of [content, common, expand, comment]) {
      if (!holder || typeof holder !== 'object') continue;
      for (const key of ['color', 'font_color', 'text_color', 'col']) {
        if (holder[key] !== null && holder[key] !== undefined) {
          colorRaw = holder[key];
          break;
        }
      }
      if (colorRaw !== undefined) break;
    }

    items.push({ text, timeRaw, color: normalizeColor(colorRaw), mode: normalizeMode(raw, comment) });
  }

  if (nextMs !== null && nextMs <= 0) nextMs = null;
  let cursor = null;
  let cursorText = '';
  if (info && typeof info === 'object') {
    if (typeof info.cursor === 'string') cursorText = info.cursor;
    else if (info.cursor && typeof info.cursor === 'object') cursor = info.cursor;
    if (!cursor && cursorText.trim().startsWith('{')) {
      try { cursor = JSON.parse(cursorText); } catch { cursor = null; }
    }
  }
  return { items, nextMs, hasMore, cursor, cursorText };
}

// ── 请求 ──────────────────────────────────────────────────────────────────

function buildBody(vid, bookId, start, duration, cursor = '') {
  return {
    comment_source: 601,
    server_channel: 1000,
    group_id: vid,
    group_type: 30,
    comment_type: 20,
    sort: 1,
    count: PAGE_COUNT,
    cursor: typeof cursor === 'string' ? cursor : '',
    aid: 8662,
    compliance_status: 0,
    business_param: {
      book_id: bookId,
      start_offset_time: start,
      playlet_item_duration: duration,
      need_danmaku_guide_type: [1, 3, 4, 2],
    },
  };
}

/**
 * 向评论接口请求一个时间窗口。
 *
 * 时间戳与 nonce 在**同一个函数里**生成并共用：签名是对 query 字符串算的，
 * query 里含 `_rticket`，而 `X-Khronos` 用的是秒。三者不一致就是无效签名。
 */
async function postComment({ vid, body, commentSource, serverChannel, transport = axios.post, now = Date.now, random = require('node:crypto').randomBytes }) {
  const stampMs = now();
  const stamp = Math.floor(stampMs / 1000);
  const nonce = random(sign.NONCE_BYTES);
  const { deviceId, installId } = deviceIdentity();

  const rawQuery = sign.buildQuery({ stampMs, deviceId, installId });
  const url = `${BASE_URL}${COMMENT_PATH(vid)}?${rawQuery}`;
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'X-XS-From-Web': '0',
    'Sdk-Version': '2',
    'Content-Type': 'application/json; charset=utf-8',
    'Comment-Source': String(commentSource),
    'Server-Channel': String(serverChannel),
    ...sign.signCommentHeaders({ rawQuery, stamp, nonce }),
  };

  const response = await transport(url, JSON.stringify(body), {
    headers,
    timeout: REQUEST_TIMEOUT,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    maxRedirects: 0,
    responseType: 'text',
    maxContentLength: MAX_RESPONSE_BYTES,
  });

  const raw = typeof response?.data === 'string' ? response.data : JSON.stringify(response?.data ?? null);
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error('弹幕响应过大');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('弹幕接口返回了非 JSON 内容');
  }
  const code = payload?.code;
  if ((code !== 0 && code !== '0') || !Array.isArray(payload?.data?.data_list)) {
    throw new Error('弹幕接口响应无效');
  }
  return payload;
}

async function requestWindow({ vid, bookId, start, duration, cursor = '', transport = axios.post, now = Date.now, random = require('node:crypto').randomBytes }) {
  return postComment({
    vid,
    body: buildBody(vid, bookId, start, duration, cursor),
    commentSource: '601',
    serverChannel: '1000',
    transport,
    now,
    random,
  });
}

const REVIEW_PAGE_COUNT = 20;

function buildReviewBody(vid, bookId, cursor, count) {
  return {
    aid: 8662,
    business_param: { book_id: bookId, need_count: cursor === '', req_type: 0 },
    comment_source: 4,
    comment_type: 4,
    compliance_status: 0,
    count,
    cursor,
    group_id: vid,
    group_type: 30,
    server_channel: 18,
    sort: 1,
  };
}

function reviewCursor(payload) {
  const cursor = payload?.data?.common_list_info?.cursor;
  if (typeof cursor === 'string') return cursor;
  if (cursor && typeof cursor === 'object') return JSON.stringify(cursor);
  return '';
}

function reviewTotal(payload) {
  const total = Number(payload?.data?.common_list_info?.total);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

// ── 对外接口 ──────────────────────────────────────────────────────────────

/**
 * 汇总成最终返回值。
 *
 * **所有出口都走这里**：源不可用、被限流、部分成功都要经过同一个地方计算
 * `notice`，否则某条分支提前 return 就会把"拿不到"显示成"本集没有弹幕"。
 *
 * `error` 非空时 `notice` 一律沿用错误说明，绝不因为 `items` 为空就改口说
 * "本集暂无弹幕" —— 这两件事对用户的意义完全不同（一个是源的问题，一个是
 * 这集真的没人发）。
 */
function finalize({ seriesId, vid, items, truncated, error }) {
  let notice;
  if (error) notice = error;
  else if (truncated) notice = `弹幕较多，本次仅载入前 ${items.length} 条`;
  else if (!items.length) notice = '本集暂无弹幕';
  else notice = '';
  return {
    success: !error,
    source: 'official',
    series_id: seriesId,
    episode_id: vid,
    items,
    total: items.length,
    truncated: Boolean(truncated),
    partial: Boolean(error) && items.length > 0,
    error: error || '',
    notice,
  };
}

/**
 * 按 limit 裁剪后再算一次说明。
 *
 * 裁剪只能改变"多少条"，不能改变"为什么是这些条"：错误说明必须原样保留，
 * 否则缓存里的失败结果会在命中缓存时被重新包装成正常结果。
 */
function present(result, items, limit) {
  if (items.length <= limit) return { ...result, items, total: items.length };
  const sliced = items.slice(0, limit);
  return {
    ...result,
    items: sliced,
    total: sliced.length,
    truncated: true,
    notice: result.error ? result.notice : `弹幕较多，本次仅载入前 ${sliced.length} 条`,
  };
}

/**
 * 抓取一集的官方弹幕。
 *
 * @param {object} options
 * @param {string} options.seriesId 剧集 ID（business_param.book_id）
 * @param {string} options.vid      本集视频 ID（group_id）。两者不同，填错会被上游拒。
 * @returns {Promise<{success:boolean, source:string, items:Array<{time:number,text:string,color:string,mode:string}>, notice:string, error:string}>}
 *          按时间升序；任何异常都转成 `success:false` + 中文说明，不抛出。
 */
function reviewHasMore(payload) {
  const flag = payload?.data?.common_list_info?.has_more;
  if (typeof flag === 'boolean') return flag;
  if (typeof flag === 'string') return ['1', 'true', 'yes'].includes(flag.trim().toLowerCase());
  return false;
}

function reviewResult(seriesId, episodeId, items, total) {
  return {
    success: true, series_id: seriesId, episode_id: episodeId, items, total: total ?? items.length,
    next_cursor: null, has_more: false, source_limited: false, notice: '',
  };
}

// 本集评论走评论列表参数，不走时间轴窗口，也不跟随公开页的 302。
// 调用方按空档传入条数上限；这里只翻到够用为止，不把整份评论拉完。
async function fetchEpisodeCommentList(options = {}) {
  const seriesId = typeof options.seriesId === 'string' ? options.seriesId.trim() : '';
  const episodeId = typeof options.episodeId === 'string' ? options.episodeId.trim() : '';
  const limit = options.limit === undefined ? 25 : options.limit;
  if (!/^\d{6,30}$/.test(seriesId) || !/^\d{6,30}$/.test(episodeId) || !Number.isInteger(limit) || limit < 1 || limit > 30) {
    return { success: false, retryable: false, items: [], error: '评论请求编号或条数无效' };
  }
  const cacheKey = `${seriesId}:${episodeId}`;
  const hit = reviewCache.get(cacheKey);
  if (hit && hit.expires > Date.now() && (hit.complete || hit.items.length >= limit)) {
    return reviewResult(seriesId, episodeId, hit.items.slice(0, limit), hit.total);
  }
  const transport = options.transport;
  const now = options.now;
  const random = options.random;
  try {
    return await enqueueDanmaku(async () => {
      const fresh = reviewCache.get(cacheKey);
      const reusable = fresh && fresh.expires > Date.now() ? fresh : null;
      const items = reusable ? reusable.items.slice() : [];
      let cursor = reusable && !reusable.complete ? reusable.cursor : '';
      let total = reusable ? reusable.total : null;
      let complete = false;
      const seen = new Set(items.map(item => item.content));
      for (let page = 0; page < 3 && items.length < limit && !complete; page++) {
        if (page > 0) await new Promise(resolve => setTimeout(resolve, PAGE_GAP_MS));
        const sent = page === 0 && !items.length ? '' : cursor;
        const count = Math.min(REVIEW_PAGE_COUNT, limit - items.length);
        const payload = await postComment({
          vid: episodeId,
          body: buildReviewBody(episodeId, seriesId, sent, count),
          commentSource: '4',
          serverChannel: '18',
          transport,
          now,
          random,
        });
        const parsed = parsePage(payload, episodeId);
        for (const item of parsed.items) {
          const content = cleanControl(item.text).replace(/\s+/g, ' ').trim();
          if (!content || content.length > MAX_TEXT_LEN || seen.has(content)) continue;
          seen.add(content);
          items.push({ id: createHash('sha256').update(`${seriesId}\n${episodeId}\n${content}`).digest('hex'), content });
          if (items.length >= limit) break;
        }
        const nextTotal = reviewTotal(payload);
        if (nextTotal != null) total = nextTotal;
        const next = reviewCursor(payload);
        const more = reviewHasMore(payload);
        if (!more || !next || next === sent) {
          complete = true;
          break;
        }
        cursor = next;
      }
      reviewCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_OK, items: items.slice(), cursor, total, complete });
      while (reviewCache.size > CACHE_MAX) reviewCache.delete(reviewCache.keys().next().value);
      return reviewResult(seriesId, episodeId, items.slice(0, limit), total);
    });
  } catch (error) {
    return {
      success: false, retryable: true, items: [],
      error: error?.code === 'DANMAKU_IDENTITY_IO'
        ? '弹幕本机配置读取或保存失败，请检查资料目录权限后重试'
        : '本集评论接口暂时不可用，请重试',
    };
  }
}

async function fetchDanmaku(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return finalize({ seriesId: '', vid: '', items: [], error: '弹幕请求无效' });
  }
  const seriesId = typeof options.seriesId === 'string' ? options.seriesId.trim() : '';
  const vid = typeof options.vid === 'string' ? options.vid.trim() : '';
  const limit = options.limit === undefined ? MAX_ITEMS : options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ITEMS ||
      (options.fresh !== undefined && typeof options.fresh !== 'boolean')) {
    return finalize({ seriesId, vid, items: [], error: '弹幕请求参数无效' });
  }
  // 允许测试注入：不打网络的假传输层、固定时钟与固定 nonce
  const transport = options.transport;
  const now = options.now || Date.now;
  const random = options.random;

  if (!/^\d{6,30}$/.test(seriesId) || !/^\d{6,30}$/.test(vid)) {
    return finalize({ seriesId, vid, items: [], error: '仅红果来源的剧集支持弹幕' });
  }

  const cacheKey = `${seriesId}:${vid}`;
  const hit = cache.get(cacheKey);
  // `fresh` 供界面上的"重试"使用：失败结果有 15 秒 TTL，不绕过的话用户点了重试
  // 只会再拿到同一条缓存失败，看起来像按钮没反应。
  if (hit && hit.expires > Date.now() && options.fresh !== true) return present(hit.result, hit.items, limit);
  if (pending.has(cacheKey)) {
    const existing = pending.get(cacheKey);
    if (options.prefetch !== true) {
      existing.prefetch = false;
      existing.stop = false;
    }
    const shared = await existing.promise;
    if (!shared?.skipped) return present(shared.result, shared.items, limit);
    if (pending.get(cacheKey) === existing) pending.delete(cacheKey);
  }

  const job = { prefetch: options.prefetch === true, stop: false, promise: null };
  if (!job.prefetch) {
    for (const [key, other] of pending) if (key !== cacheKey && other.prefetch) other.stop = true;
  }
  const task = enqueueDanmaku(async () => {
    if (job.stop) return { skipped: true };
    return (async () => {
    const collected = [];
    const seen = new Set();
    let start = 0;
    let duration = EFFECTIVE_DURATION_MS;
    let emptyPages = 0;
    let truncated = false;
    let failure = '';
    let cursorText = '';
    let knownWindows = null;
    let retriedSparse = false;
    const rememberWindows = cursor => {
      const counts = cursor?.danmaku_window_count;
      if (counts && typeof counts === 'object') knownWindows = counts;
    };
    const laterWindow = from => {
      if (!knownWindows) return null;
      const marks = Object.entries(knownWindows)
        .map(([mark, count]) => [Number(mark), Number(count)])
        .filter(([mark, count]) => Number.isFinite(mark) && mark > from && Number.isFinite(count) && count > 0)
        .sort((a, b) => a[0] - b[0]);
      return marks.length ? marks[0][0] : null;
    };

    let stopped = false;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        if (job.stop) { stopped = true; break; }
        if (page > 0) await new Promise(resolve => setTimeout(resolve, PAGE_GAP_MS));
        if (job.stop) { stopped = true; break; }

        let payload;
        try {
          payload = await requestWindow({ vid, bookId: seriesId, start, duration, cursor: cursorText, transport, now, random });
        } catch (error) {
          // 错误说明要能让用户自己判断：发生了什么、已经试过什么、还能做什么。
          // 首页失败说明源不可用；后续页失败则保留已拿到的部分，不把整集判死。
          // 不透传异常文本：Axios 错误可能携带签名 URL 或设备指纹。
          failure = error?.code === 'DANMAKU_IDENTITY_IO'
            ? '弹幕本机配置读取或保存失败，请检查资料目录权限后重试'
            : collected.length
            ? '后续弹幕加载中断，已保留已获取的部分'
            : error?.code === 'ECONNABORTED' || error?.name === 'TimeoutError' || error?.code === 'ERR_CANCELED'
              ? '弹幕接口响应超时（已用官方签名请求），可稍后再试'
              : error?.response
                ? `弹幕接口不可用（HTTP ${Number.isInteger(error.response.status) ? error.response.status : '错误'}），已尝试官方签名请求；可改用「本集评论」`
                : '弹幕接口暂不可用（已尝试官方签名请求），请稍后重试';
          break;
        }

        let parsed = parsePage(payload, vid);
        rememberWindows(parsed.cursor);
        const rows = Array.isArray(payload?.data?.data_list) ? payload.data.data_list : [];
        const foreign = rows.some(row => {
          const groupId = row?.comment?.common?.group_id;
          return groupId !== undefined && groupId !== null && String(groupId) !== vid;
        });
        // 一小时窗口有时只回引导或空页。没有后续时间窗可走时，用短窗口再要一次。
        if (!parsed.items.length && !foreign && !retriedSparse && !collected.length && !laterWindow(start)) {
          retriedSparse = true;
          try {
            const retryPayload = await requestWindow({ vid, bookId: seriesId, start, duration: 30000, cursor: '', transport, now, random });
            const retry = parsePage(retryPayload, vid);
            if (retry.items.length || retry.hasMore === false) parsed = retry;
            rememberWindows(parsed.cursor);
          } catch { /* 保留第一次的分页信号。 */ }
        }
        let { items: pageItems, nextMs, hasMore, cursor, cursorText: nextCursor } = parsed;
        cursorText = nextCursor || '';
        if (pageItems.length) emptyPages = 0;
        else emptyPages++;

        for (const item of pageItems) {
          const seconds = toSeconds(item.timeRaw);
          if (seconds === null) continue;
          const text = cleanControl(item.text);
          if (!text || text.length > MAX_TEXT_LEN) continue;
          const key = `${seconds.toFixed(3)}|${text}`;
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push({ time: seconds, text, color: item.color, mode: item.mode });
          if (collected.length >= MAX_ITEMS) break;
        }

        // 这一页已经到手。若当前集要插队，就停在这里，别再把空页写成「本集没有弹幕」。
        if (job.stop) { stopped = true; break; }

        if (collected.length >= MAX_ITEMS) {
          truncated = true;
          break;
        }
        if (nextMs === null || nextMs <= start) {
          const jump = laterWindow(start);
          if (jump && page < MAX_PAGES - 1) {
            start = jump;
            cursorText = '';
            duration = Math.min(Math.max(duration, start + EFFECTIVE_DURATION_MS), MAX_DURATION_MS);
            continue;
          }
          if (hasMore === true) truncated = true;
          if (hasMore === true && !collected.length) failure = '弹幕接口未返回有效分页，请稍后重试';
          break;
        }
        // 游标还标着后面的时间窗有弹幕时，空窗只是这一段没有，不能当成分页坏了。
        // 没有这种计数时仍按连续空页停止，避免上游一直 has_more 却不给内容。
        if (nextMs > MAX_TIME_SECONDS * 1000 || page === MAX_PAGES - 1
          || (emptyPages >= MAX_EMPTY_PAGES && !laterWindow(start))) {
          truncated = true;
          if (!collected.length && hasMore === true && !laterWindow(start)) failure = '弹幕接口未返回有效分页，请稍后重试';
          break;
        }
        start = nextMs;
        // 上游拒绝超过 24 小时的窗口，所以 duration 向后延时要封顶
        duration = Math.min(Math.max(duration, start + EFFECTIVE_DURATION_MS), MAX_DURATION_MS);
        // 上游说"还有更多"但连续给空页 —— 上面的分页护栏会停止并注明截断。
      }
    } catch (error) {
      failure = '弹幕处理失败，请稍后重试';
    }

    collected.sort((a, b) => a.time - b.time);

    // 预载被当前集打断、而且一条都还没有时，不写入缓存，避免把让路记成「这一集没有弹幕」。
    if (stopped && !failure && !collected.length) return { skipped: true };
    // 缓存完整结果与完整列表；limit 只在呈现时裁剪，避免缓存被"半截"结果污染。
    const result = finalize({ seriesId, vid, items: collected, truncated: stopped ? false : truncated, error: stopped && !failure ? '' : failure });
    cache.set(cacheKey, {
      expires: Date.now() + (failure && !stopped ? CACHE_TTL_FAIL : CACHE_TTL_OK),
      items: collected,
      result,
    });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { result, items: collected };
    })();
  });
  job.promise = task;
  pending.set(cacheKey, job);
  try {
    const shared = await task;
    if (shared?.skipped) {
      return { success: false, source: 'official', series_id: seriesId, episode_id: vid, items: [], total: 0, truncated: false, partial: false, error: '', notice: '', skipped: true };
    }
    return present(shared.result, shared.items, limit);
  } finally {
    if (pending.get(cacheKey) === job) pending.delete(cacheKey);
  }
}

/** 仅供测试：清空缓存与在途状态。 */
function resetDanmakuCache() {
  cache.clear();
  reviewCache.clear();
  pending.clear();
}

module.exports = {
  fetchDanmaku,
  fetchEpisodeCommentList,
  // 测试与复用需要的内部件
  parsePage,
  normalizeColor,
  normalizeMode,
  cleanControl,
  toSeconds,
  buildBody,
  requestWindow,
  resetDanmakuCache,
  setDeviceIdentity,
  setDeviceIdentityFile,
  BASE_URL,
  COMMENT_PATH,
  USER_AGENT,
  MAX_ITEMS,
  MAX_TEXT_LEN,
  MAX_TIME_SECONDS,
  PAGE_COUNT,
};
