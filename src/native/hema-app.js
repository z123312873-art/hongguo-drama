const crypto = require('node:crypto');
const axios = require('axios');
const { CERT_HINT } = require('./cert-hint');

const HOST = 'https://freevideo.zqqds.cn';
const PORTAL = '/free-video-portal/portal/';
const AES_KEY = Buffer.from('dzkjgfyxgshylgzm');
const AES_IV = Buffer.from('apiupdownedcrypt');
const HMAC_KEY = Buffer.from('1pQ86jdDNQR584CmGICPnfdzydOLfU/EebtAKkZ5jkE=');
const DATAS_KEYS = ['version', 'pname', 'channelCode', 'utdidTmp', 'token', 'utdid', 'os', 'osv', 'brand', 'model', 'manu', 'userId', 'launch', 'mchid', 'nchid', 'session1', 'session2', 'startScene', 'recSwitch', 'installTime', 'p', 'nonce', 'timeZone', 'timestamp'];
const MAX_RATE = '720P';

let session;
let sessionPending;
let sessionCooldownUntil = 0;

function dumps(obj) { return JSON.stringify(obj); }
function aesEncrypt(plain) {
  const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
  return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]).toString('base64');
}
function aesDecrypt(blob) {
  const raw = Buffer.from(String(blob || ''), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', AES_KEY, AES_IV);
  return Buffer.concat([decipher.update(raw), decipher.final()]).toString('utf8');
}
function hmacSign(timestamp, nonce, body) {
  return crypto.createHmac('sha256', HMAC_KEY).update(`${timestamp}\n${nonce}\n${body}`).digest('base64');
}
function uuid() { return crypto.randomUUID(); }
function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}
function pickPlayUrl(obj, depth = 0) {
  if (!obj || depth > 8) return '';
  if (typeof obj === 'string') return httpsUrl(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) { const found = pickPlayUrl(item, depth + 1); if (found) return found; }
    return '';
  }
  if (typeof obj === 'object') {
    for (const key of ['mp4Url', 'mp4720pUrl', 'm3u8720pUrl', 'm3u8', 'playUrl', 'videoUrl', 'downLoadUrl']) {
      const found = httpsUrl(obj[key]);
      if (found) return found;
    }
    for (const value of Object.values(obj)) {
      const found = pickPlayUrl(value, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function freshSessionSeed() {
  const now = Date.now();
  return {
    version: '2.21.3', pname: 'com.dz.hmjc', channelCode: 'HMJC1000004',
    utdidTmp: crypto.randomBytes(12).toString('base64url'), token: '', utdid: '',
    os: 'Android', osv: 30, brand: 'google', model: 'Pixel 5', manu: 'Google',
    userId: '', launch: 'coldBoot', mchid: 'HMJC1000004', nchid: 'HMJC1000004',
    session1: uuid(), session2: uuid(), startScene: 'iconOpen', recSwitch: true,
    installTime: now - 86400000, p: 30, timeZone: 'GMT+08:00', scDistinctId: uuid(),
  };
}

function buildDatas(sess, timestamp, nonce) {
  const data = {};
  for (const key of DATAS_KEYS) {
    if (key === 'nonce') data[key] = nonce;
    else if (key === 'timestamp') data[key] = timestamp;
    else if (key === 'token') data[key] = sess.token || '';
    else data[key] = sess[key] ?? '';
  }
  return data;
}

async function portalCall(action, body, sess, options = {}) {
  const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 12000;
  if (remaining <= 0) throw new Error('河马加载超时，请重试');
  const timeout = Math.min(12000, remaining);
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyPlain = body == null ? '' : (typeof body === 'string' ? body : dumps(body));
  const bodyWire = aesEncrypt(bodyPlain === '' ? '' : bodyPlain);
  const datasWire = aesEncrypt(dumps(buildDatas(sess, timestamp, nonce)));
  const sign = hmacSign(timestamp, nonce, bodyWire);
  const headers = {
    alg: 'HG45LKBS', sign, datas: datasWire, 'x-request-id': uuid(),
    'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip',
    'user-agent': 'okhttp/4.10.0',
  };
  let response;
  try {
    response = await axios.post(`${HOST}${PORTAL}${action}`, bodyWire, {
      ...require('./direct-connect').directAxiosOptions(),
      headers, timeout, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024,
      responseType: 'text', transformResponse: [(data) => data], validateStatus: () => true,
      signal: options.signal,
    });
  } catch (error) {
    if (/^(?:CERT_|UNABLE_TO_(?:VERIFY|GET)|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED|HOSTNAME_MISMATCH|ERR_TLS_CERT)/.test(String(error?.code || ''))) {
      throw Object.assign(new Error(CERT_HINT), { code: 'ERR_TLS_CERT' });
    }
    throw new Error(['ECONNABORTED', 'ETIMEDOUT'].includes(error.code) || options.signal?.aborted
      ? '河马加载超时，请重试' : '河马来源暂不可用，请稍后重试');
  }
  if (response.status !== 200) throw new Error(`河马来源暂不可用（HTTP ${response.status}）`);
  let parsed;
  try { parsed = JSON.parse(response.data); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object') {
    try { parsed = JSON.parse(aesDecrypt(response.data)); } catch (_) { throw new Error('河马返回数据异常，请稍后重试'); }
  }
  let data = parsed.data;
  if (typeof data === 'string' && data) {
    try { data = JSON.parse(aesDecrypt(data)); } catch (_) {
      try { data = JSON.parse(data); } catch (_) {}
    }
  }
  return { code: parsed.code, msg: parsed.msg, subCode: parsed.subCode, data };
}

async function ensureSession(options = {}) {
  if (session?.userId) return session;
  if (sessionPending) return sessionPending;
  if (Date.now() < sessionCooldownUntil) throw Object.assign(new Error('河马登录暂时不可用，请稍后重试'), { code: 'SESSION_COOLDOWN' });
  sessionPending = (async () => {
    const seed = freshSessionSeed();
    const body = {
      oaid: '', requestType: 1, activeType: 2, isFirstLaunch: true, todayLaunchNums: 1,
      launchTime: Date.now(), scDistinctId: seed.scDistinctId, deviceType: 'Android', systemVersion: '11',
    };
    const res = await portalCall('1103', body, seed, options);
    if (Number(res.code) !== 0) throw new Error(res.msg || '河马访客初始化失败，请稍后重试');
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    const ui = data.userInfoVo && typeof data.userInfoVo === 'object' ? data.userInfoVo : {};
    const userId = String(ui.userId || data.userId || seed.userId || '');
    if (!/^\d{1,30}$/.test(userId)) throw new Error('河马访客初始化失败，请稍后重试');
    session = { ...seed, userId };
    sessionCooldownUntil = 0;
    return session;
  })().catch(error => { sessionCooldownUntil = Date.now() + 60000; throw error; }).finally(() => { sessionPending = undefined; });
  return sessionPending;
}

function resetSession() { session = undefined; sessionPending = undefined; }

async function call(action, body, options = {}) {
  let sess = await ensureSession(options);
  let res = await portalCall(action, body, sess, options);
  if (Number(res.code) === 0) return res;
  resetSession();
  sess = await ensureSession(options);
  res = await portalCall(action, body, sess, options);
  if (Number(res.code) !== 0) throw new Error(res.msg || '河马来源暂不可用，请稍后重试');
  return res;
}

async function fetchDetail(bookId, chapterId, options = {}) {
  const body = {
    bookId: String(bookId), needNextChapter: 0, isNeedAlias: '', bookAlias: '',
    resolutionRate: MAX_RATE, preview: 1, commentType: 2, excludeInfo: 0,
    screenClearType: 2, bottomStyle: 1, showOriginNovel: 0,
  };
  if (chapterId) body.chapterId = String(chapterId);
  const res = await call('1131', body, options);
  if (!res.data || typeof res.data !== 'object') throw new Error('河马详情数据异常，请稍后重试');
  return res.data;
}

async function fetchPlay(bookId, chapterId, options = {}) {
  const body = {
    bookId: String(bookId), chapterIds: [String(chapterId)], unClockType: 'load',
    chapterId: String(chapterId),
    tierPlaySource: { firstTierPlaySource: null, secondTierPlaySource: null, thirdTierPlaySource: null },
    resolutionRate: MAX_RATE, preview: 1, playPercentage: 0, continuousAd: 0, commentType: 2,
  };
  const res = await call('1139', body, options);
  if (!res.data || typeof res.data !== 'object') throw new Error('河马未提供有效 HTTPS 播放地址');
  const url = pickPlayUrl(res.data);
  if (!url) {
    return { url: null, locked: true, error: '本集暂时无法取得播放地址，请稍后重试或改看其他集' };
  }
  return { url, locked: false, rate: MAX_RATE };
}

module.exports = { ensureSession, resetSession, fetchDetail, fetchPlay, pickPlayUrl, MAX_RATE, httpsUrl };
