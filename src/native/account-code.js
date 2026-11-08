'use strict';

const { HONGGUO_PROFILE, registerDevice } = require('./playback-device');
const { wirePhone } = require('./account-profile');
const { signFull, signInternational, encodeQuery } = require('./account-sign');

const HOST = 'https://api5-normal-lq.fqnovel.com';
const UNAVAILABLE = '验证码暂时无法发送，请稍后再试';
const INCOMPLETE = '登录没有完成，请重试';

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
  if (typeof value !== 'string' || !value.startsWith('https://') || value.includes('mosaic-legacy')) return '';
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

function createCodeClient({
  post = defaultPost,
  register = () => registerDevice(require('./app-source').requestJson),
  getDevice = () => null,
  saveDevice = () => {},
  now = () => Date.now(),
} = {}) {
  const cookies = new Map();
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
  const call = async (path, countryCode, body) => {
    const current = await device();
    const bytes = Buffer.from(body);
    const stamp = now();
    const signed = countryCode === '+86'
      ? signFull(queryFor(current), bytes, stamp, current.deviceId)
      : signInternational(queryFor(current), bytes, stamp);
    const headers = {
      ...signed.headers,
      'User-Agent': HONGGUO_PROFILE.userAgent,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-XS-From-Web': '0',
      'Sdk-Version': '2',
      'Passport-Sdk-Version': '5051452',
      'X-SS-DP': '8662',
      'X-Tt-Store-Region': cookies.get('store-region') || 'cn',
      'X-Tt-Store-Region-Src': 'did',
      'X-Vc-Bdturing-Sdk-Version': '4.0.3.cn',
      Lc: '101',
    };
    if (cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await post(`${HOST}${path}?${signed.raw}`, { headers, body: bytes });
    remember(response?.headers);
    return response;
  };
  return {
    reset() { cookies.clear(); },
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
      if (!sent) return { ok: false, error: publicFailure(payload, UNAVAILABLE) };
      const retry = Number(data.retry_time);
      return { ok: true, retryAfter: Number.isInteger(retry) && retry >= 0 && retry <= 3600 ? retry : 60 };
    },
    async login({ countryCode, phone, code } = {}) {
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
      const token = headerValue(response.headers, 'x-tt-token');
      const session = cookies.get('sessionid') || cookies.get('sessionid_ss') || '';
      if (!userId || (numeric && numeric !== userId) || (!token && !session)) return { ok: false, error: INCOMPLETE };
      const nickname = [data.screen_name, data.name].find(value => typeof value === 'string' && value.trim()) || '';
      return { ok: true, userId, nickname: nickname.trim().slice(0, 32), avatarUrl: avatarUrl(data.avatar_url) };
    },
  };
}

module.exports = { createCodeClient, xorHex, parseBody };
