'use strict';

const { HONGGUO_PROFILE, registerDevice } = require('./playback-device');
const { cleanNickname, wirePhone, retryDelay } = require('./account-profile');
const { avatarCandidates } = require('./account-avatar');
const { signFull, signInternational, encodeQuery } = require('./account-sign');

const HOST = 'https://api5-normal-lq.fqnovel.com';
const UNAVAILABLE = '驗證碼暫時無法傳送，請稍後再試';
const INCOMPLETE = '登入沒有完成，請重試';
const PROFILE_TIMEOUT_MS = 8000;

function xorHex(value) {
  return Buffer.from(String(value)).map(byte => byte ^ 5).toString('hex');
}

function parseBody(text) {
  const safe = String(text || '').replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  try { return JSON.parse(safe); } catch { return null; }
}

function payloadData(payload) {
  return payload && typeof payload.data === 'object' && payload.data && !Array.isArray(payload.data) ? payload.data : {};
}

function errorCode(payload) {
  const data = payloadData(payload);
  const code = data.error_code ?? payload?.error_code;
  if (code === undefined || code === null || code === '') return '';
  return String(code);
}

function publicFailure(payload, fallback) {
  const data = payloadData(payload);
  let message = typeof data.description === 'string' ? data.description : typeof payload?.description === 'string' ? payload.description : '';
  if (/[\r\n]/.test(message) || /https?:/i.test(message) || [...message].length > 120) message = '';
  message = message.replace(/\d{7,}/g, '***');
  return message || fallback;
}

function headerValue(headers, name) {
  if (!headers) return '';
  const value = headers[name] || headers[name.toLowerCase()] || '';
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function cookieList(headers) {
  const value = headers?.['set-cookie'] || headers?.['Set-Cookie'];
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map(item => String(item));
}

function readId(value) {
  if (typeof value === 'string' && /^\d+$/.test(value) && value !== '0') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return '';
}

function avatarUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('https://') || value.includes('mosaic-legacy')) return '';
  try {
    const url = new URL(value);
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function queryFor(device) {
  return {
    ac: 'wifi', aid: '8662', app_name: 'novelread', channel: 'update_64', device_brand: 'Redmi',
    device_id: device.deviceId, device_platform: 'android', device_type: '25053RT47C', dpi: '520',
    iid: device.installId, language: 'zh', manifest_version_code: '73532', os: 'android', os_api: '36',
    os_version: '16', resolution: '1280*2772', ssmix: 'a', update_version_code: '73532',
    version_code: '73532', version_name: '7.3.5.32', cdid: device.cdid,
  };
}

function formBody(countryCode, phone, extra) {
  return Buffer.from(encodeQuery({
    mobile: xorHex(wirePhone(countryCode, phone)),
    account_sdk_source: 'app',
    passport_support_flow: 'captcha,verify',
    mix_mode: '1',
    ...extra,
  }));
}

async function defaultPost(url, options) {
  const axios = require('axios');
  const response = await axios({
    ...require('./direct-connect').directAxiosOptions(),
    url, method: 'POST', headers: options.headers, data: options.body,
    timeout: 20000, maxRedirects: 0, responseType: 'text', transformResponse: [data => data],
    validateStatus: () => true, maxContentLength: 1024 * 1024, maxBodyLength: 64 * 1024,
  });
  return { status: response.status, text: typeof response.data === 'string' ? response.data : '', headers: response.headers || {} };
}

async function defaultGet(url, options) {
  const axios = require('axios');
  const response = await axios({
    ...require('./direct-connect').directAxiosOptions(),
    url, method: 'GET', headers: options.headers,
    timeout: PROFILE_TIMEOUT_MS, maxRedirects: 0, responseType: 'text', transformResponse: [data => data],
    validateStatus: () => true, maxContentLength: 1024 * 1024,
  });
  return { status: response.status, text: typeof response.data === 'string' ? response.data : '', headers: response.headers || {} };
}



function readProfile(payload, userId = '') {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.code !== undefined && String(payload.code) !== '0') return null;
  const data = payloadData(payload);
  const owner = readId(data.user_id_str) || readId(data.user_id);
  if (userId && owner && owner !== userId) return null;
  const nickname = cleanNickname(data.user_name);

  const pictures = avatarCandidates(data.avatar_url, data.expand_avatar_url, data.basic_info?.user_avatar,
    data.avatar_large, data.avatar_thumb, data.avatar_medium, data.user_avatar);
  const picture = pictures.map(avatarUrl).find(Boolean) || '';
  if (!nickname && !pictures.length) return null;
  return { nickname, avatarUrl: picture, avatarCandidates: pictures };
}

function createCodeClient({
  post = defaultPost,
  get = defaultGet,
  register = () => registerDevice(require('./app-source').requestJson),
  getDevice = () => null,
  saveDevice = () => {},
  now = () => Date.now(),
} = {}) {
  const cookies = new Map();
  let token = '';
  let signedRegion = '';
  let signedUser = '';
  const remember = (headers) => {
    for (const row of cookieList(headers)) {
      const part = row.split(';', 1)[0];
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (/max-age=0|Max-Age=0/.test(row)) cookies.delete(name);
      else if (name && value) cookies.set(name, value);
    }
  };
  const device = async () => {
    const saved = getDevice();
    if (saved?.deviceId && saved?.installId && saved?.cdid) return saved;
    const registered = await register();
    const next = { deviceId: registered?.device_id || '', installId: registered?.iid || '', cdid: registered?.cdid || '' };
    if (!/^\d{1,30}$/.test(next.deviceId) || !/^\d{1,30}$/.test(next.installId) || !next.cdid) throw new Error(UNAVAILABLE);
    saveDevice(next);
    return next;
  };
  const call = async (path, countryCode, body, method = 'POST', extraQuery = {}, contentType = 'application/x-www-form-urlencoded; charset=UTF-8', scope = null) => {
    const checkScope = () => {
      if (scope && (scope.generation !== generation || scope.userId !== signedUser)) throw new Error('ACCOUNT_CHANGED');
    };
    checkScope();
    const current = await device();
    checkScope();
    const bytes = Buffer.from(body || '');
    const stamp = now();
    const query = { ...queryFor(current), ...extraQuery };
    const signed = countryCode === '+86'
      ? signFull(query, bytes, stamp, current.deviceId)
      : signInternational(query, bytes, stamp);
    const headers = {
      ...signed.headers,
      'User-Agent': HONGGUO_PROFILE.userAgent,
      Accept: 'application/json',
      'X-XS-From-Web': '0',
      'Sdk-Version': '2',
      'Passport-Sdk-Version': '5051452',
      'X-SS-DP': '8662',
      'X-Tt-Store-Region': cookies.get('store-region') || 'cn',
      'X-Tt-Store-Region-Src': 'did',
      'X-Vc-Bdturing-Sdk-Version': '4.0.3.cn',
      Lc: '101',
    };
    if (method === 'POST') headers['Content-Type'] = contentType;

    if (!path.startsWith('/passport/mobile/') && token) headers['X-Tt-Token'] = token;
    if (cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const url = `${HOST}${path}?${signed.raw}`;
    const response = method === 'GET' ? await get(url, { headers }) : await post(url, { headers, body: bytes });
    checkScope();
    remember(response?.headers);
    return response;
  };
  const signedIn = () => Boolean(token || cookies.get('sessionid') || cookies.get('sessionid_ss'));
  const profile = async () => {
    if (!signedIn() || !signedRegion) return null;
    try {
      const response = await call('/reading/user/info/v1/', signedRegion, '', 'GET');
      if (response?.status !== 200) return null;
      return readProfile(parseBody(response.text), signedUser);
    } catch {
      return null;
    }
  };




  let readingSign = '';
  let generation = 0;
  const requestOnce = async (signAs, method, path, query, body, scope) => {
    const response = await call(path, signAs, body, method, query, 'application/json; charset=utf-8', scope);
    if (response?.status !== 200) throw new Error(`HTTP ${response?.status || 0}`);
    const payload = parseBody(response.text);
    if (!payload || typeof payload !== 'object') throw new Error('BAD_BODY');
    if (payload.code === undefined || String(payload.code) !== '0') throw Object.assign(new Error(`CODE ${payload.code}`), { code: String(payload.code) });
    const nested = errorCode(payload);
    if (nested && nested !== '0') throw Object.assign(new Error(`CODE ${nested}`), { code: String(nested) });
    return payload;
  };
  const request = async (method, path, query = {}, json = undefined, options = {}) => {
    if (!signedIn() || !signedRegion) throw new Error('NOT_SIGNED_IN');
    if (options.expectedUserId !== undefined && String(options.expectedUserId) !== signedUser) throw new Error('ACCOUNT_CHANGED');
    const scope = { generation, userId: signedUser };
    const body = json === undefined ? '' : (typeof json === 'string' ? json : JSON.stringify(json));
    const first = readingSign || signedRegion;
    try {
      const payload = await requestOnce(first, method, path, query, body, scope);
      if (scope.generation !== generation || scope.userId !== signedUser) throw new Error('ACCOUNT_CHANGED');
      readingSign = first;
      return payload;
    } catch (error) {
      if (options.retry === false || scope.generation !== generation || scope.userId !== signedUser) throw error;
      const other = first === '+86' ? signedRegion : '+86';
      if (other === first || error.message === 'NOT_SIGNED_IN') throw error;
      let payload;
      try { payload = await requestOnce(other, method, path, query, body, scope); } catch { throw error; }
      if (scope.generation !== generation || scope.userId !== signedUser) throw new Error('ACCOUNT_CHANGED');
      readingSign = other;
      return payload;
    }
  };
  return {
    reset() { generation++; cookies.clear(); token = ''; signedRegion = ''; signedUser = ''; readingSign = ''; },
    profile,
    request,
    signedIn: () => Boolean(signedIn() && signedRegion && signedUser),
    user: () => signedUser,

    snapshot() {
      if (!signedIn() || !signedRegion || !signedUser) return null;
      return { userId: signedUser, region: signedRegion, token, cookies: Object.fromEntries(cookies) };
    },
    restore(session) {
      if (!session || typeof session !== 'object') return false;
      const userId = readId(session.userId);
      const region = typeof session.region === 'string' && /^\+\d{1,4}$/.test(session.region) ? session.region : '';
      const saved = session.cookies && typeof session.cookies === 'object' && !Array.isArray(session.cookies) ? session.cookies : {};
      const pairs = Object.entries(saved).filter(([name, value]) => /^[\w.-]{1,64}$/.test(name) && typeof value === 'string' && value && value.length <= 4096 && !/[;\r\n]/.test(value));
      const savedToken = typeof session.token === 'string' && session.token.length <= 4096 && !/[\r\n]/.test(session.token) ? session.token : '';
      if (!userId || !region || (!savedToken && !pairs.some(([name]) => name === 'sessionid' || name === 'sessionid_ss'))) return false;
      generation++;
      cookies.clear();
      for (const [name, value] of pairs) cookies.set(name, value);
      token = savedToken;
      readingSign = '';
      signedRegion = region;
      signedUser = userId;
      return true;
    },
    async send({ countryCode, phone } = {}) {
      const extra = { auto_read: '0', unbind_exist: '34', type: xorHex('24') };
      let response;
      try { response = await call('/passport/mobile/send_code/v1/', countryCode, await formBody(countryCode, phone, extra)); }
      catch { return { ok: false, error: UNAVAILABLE }; }
      if (response?.status === 429) return { ok: false, error: UNAVAILABLE, retryAfter: 60 };
      if (response?.status !== 200) return { ok: false, error: UNAVAILABLE };
      const payload = parseBody(response.text);
      if (!payload || typeof payload !== 'object') return { ok: false, error: UNAVAILABLE };
      const data = payloadData(payload);
      if (typeof data.captcha === 'string' && data.captcha) return { ok: false, error: publicFailure(payload, UNAVAILABLE) };
      const code = errorCode(payload);
      const sent = payload.message === 'success' && (!code || code === '0');
      if (!sent) return { ok: false, error: publicFailure(payload, UNAVAILABLE), ...(data.retry_time !== undefined ? { retryAfter: retryDelay(data.retry_time) } : {}) };
      return { ok: true, retryAfter: retryDelay(data.retry_time) };
    },
    async login({ countryCode, phone, code } = {}) {
      generation++;
      token = '';
      readingSign = '';
      signedRegion = '';
      signedUser = '';
      let response;
      try {
        response = await call('/passport/mobile/sms_login/', countryCode, await formBody(countryCode, phone, { code: xorHex(code) }));
      } catch { return { ok: false, error: INCOMPLETE }; }
      if (response?.status !== 200) return { ok: false, error: INCOMPLETE };
      const payload = parseBody(response.text);
      if (!payload || payload.message !== 'success') return { ok: false, error: publicFailure(payload, INCOMPLETE) };
      const data = payloadData(payload);
      const userId = readId(data.user_id_str) || readId(data.user_id);
      const numeric = readId(data.user_id);
      const headerToken = headerValue(response.headers, 'x-tt-token');
      const session = cookies.get('sessionid') || cookies.get('sessionid_ss') || '';
      if (!userId || (numeric && numeric !== userId) || (!headerToken && !session)) return { ok: false, error: INCOMPLETE };
      if (headerToken) token = headerToken;
      signedRegion = countryCode;
      signedUser = userId;

      const read = await profile();
      return {
        ok: true,
        userId,
        nickname: read?.nickname || '',
        avatarUrl: read?.avatarUrl || avatarUrl(data.avatar_url),
        avatarCandidates: read?.avatarCandidates || [],
        profileFrom: read ? 'user-info' : '',
      };
    },
  };
}

module.exports = { createCodeClient, xorHex, parseBody, readProfile, readId, PROFILE_TIMEOUT_MS };
