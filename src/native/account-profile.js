'use strict';

const ACCOUNT_REGIONS = [
  { code: '+886', name: '臺灣', min: 9, max: 10 },
  { code: '+86', name: '大陸', min: 11, max: 11 },
  { code: '+852', name: '香港', min: 8, max: 8 },
  { code: '+853', name: '澳門', min: 8, max: 8 },
  { code: '+60', name: '馬來西亞', min: 9, max: 10 },
  { code: '+65', name: '新加坡', min: 8, max: 8 },
  { code: '+62', name: '印度尼西亞', min: 10, max: 13 },
  { code: '+95', name: '緬甸', min: 9, max: 10 },
  { code: '+63', name: '菲律賓', min: 7, max: 10 },
  { code: '+84', name: '越南', min: 9, max: 10 },
  { code: '+855', name: '柬埔寨', min: 8, max: 9 },
  { code: '+81', name: '日本', min: 9, max: 11 },
  { code: '+82', name: '韓國', min: 8, max: 11 },
  { code: '+971', name: '阿聯酋', min: 9, max: 9 },
];

const DEFAULT_REGION = '+886';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SKEW_MS = 5 * 60 * 1000;
const CODE_LIMIT = 8;
const NICKNAME_LIMIT = 32;

function regionLabel(name) {
  return String(name || '').replace(/^中国/, '');
}

function regionByCode(code) {
  return ACCOUNT_REGIONS.find(region => region.code === code) || null;
}

function wirePhone(countryCode, phone) {
  const region = regionByCode(countryCode);
  const local = String(phone ?? '');
  if (!region || !/^\d+$/.test(local)) return '';
  if (region.code === '+86') return `${region.code}${local}`;
  const widths = region.max === 10 ? [3, 4, 3] : region.max === 11 ? [3, 4, 4] : [];
  if (!widths.length) {
    const width = region.max % 4 === 0 ? 4 : 3;
    for (let left = region.max; left > 0; left -= width) widths.push(width);
  }
  const groups = [];
  let rest = local;
  for (const width of widths) {
    if (!rest) break;
    const take = Math.min(width, rest.length);
    groups.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return `${region.code}${groups.join(' ')}`;
}

function preparePhone(countryCode, value) {
  const region = regionByCode(countryCode);
  if (!region) return { ok: false, error: '請選擇國家或地區' };
  const phone = String(value ?? '').replace(/\D/g, '');
  if (!phone) return { ok: false, error: '請輸入手機號碼' };
  if (phone.length < region.min || phone.length > region.max) return { ok: false, error: '手機號碼位數不正確' };
  const calling = region.code.slice(1);
  if (calling.length + phone.length > 15) return { ok: false, error: '手機號碼位數不正確' };
  if (region.code === '+86' && !/^1[3-9]\d{9}$/.test(phone)) return { ok: false, error: '請檢查手機號碼' };
  return { ok: true, countryCode: region.code, phone };
}

function normalizeCode(value) {
  const text = String(value ?? '').replace(/\D/g, '').slice(0, CODE_LIMIT);
  return { text, ready: text.length >= 4 && text.length <= CODE_LIMIT };
}

function retryDelay(value) {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) return 60;
  if (value === 0) return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 3600) return 60;
  return number;
}


function cleanNickname(value) {
  if (typeof value !== 'string') return '';
  return [...value.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').trim()]
    .slice(0, NICKNAME_LIMIT).join('').trim();
}



const PROFILE_FROM = 'user-info';


const AVATAR_DATA = /^data:image\/(?:jpeg|png|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;
const AVATAR_DATA_LIMIT = 700 * 1024;
function avatarData(value) {
  return typeof value === 'string' && value.length <= AVATAR_DATA_LIMIT && AVATAR_DATA.test(value) ? value : '';
}

function httpsAvatar(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || value.includes('mosaic-legacy')) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function sessionStatus(record, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { loggedIn: false };
  const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
  const loggedInAt = Number(record.loggedInAt);
  if (!userId || userId === '0' || !Number.isFinite(loggedInAt)) return { loggedIn: false };
  if (loggedInAt > now + SKEW_MS) return { loggedIn: false };
  if (now - loggedInAt >= SESSION_MS) return { loggedIn: false, expired: true };
  const nickname = record.profileFrom === PROFILE_FROM ? cleanNickname(record.nickname) : '';
  return { loggedIn: true, nickname, avatarUrl: httpsAvatar(record.avatarUrl), avatarData: avatarData(record.avatarData) };
}

function acceptLogin(payload, now) {
  const userId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
  if (!userId || userId === '0') return { ok: false, error: '登入沒有完成，請重試' };
  const fromProfile = payload?.profileFrom === PROFILE_FROM;
  return {
    ok: true,
    record: {
      userId,
      nickname: fromProfile ? cleanNickname(payload?.nickname) : '',
      avatarUrl: httpsAvatar(payload?.avatarUrl),
      avatarData: avatarData(payload?.avatarData),
      profileFrom: fromProfile ? PROFILE_FROM : '',
      loggedInAt: now,
    },
  };
}



function pictureKey(url) {
  try {
    const path = new URL(url).pathname;
    const marker = path.indexOf('~');
    return (marker > 0 ? path.slice(0, marker) : path).replace(/^\/large\//, '/');
  } catch { return ''; }
}

function mergeProfile(record, userId, profile, now) {
  if (!profile || !sessionStatus(record, now).loggedIn || record.userId !== userId) return null;
  const nickname = cleanNickname(profile.nickname);
  const avatarUrl = httpsAvatar(profile.avatarUrl);
  const picture = avatarData(profile.avatarData);
  if (!nickname && !avatarUrl && !picture) return null;
  return {
    ...record,
    nickname: nickname || (record.profileFrom === PROFILE_FROM ? cleanNickname(record.nickname) : ''),
    avatarUrl: avatarUrl || httpsAvatar(record.avatarUrl),


    avatarData: picture || (!avatarUrl || pictureKey(avatarUrl) === pictureKey(record.avatarUrl) ? avatarData(record.avatarData) : ''),
    profileFrom: nickname || record.profileFrom === PROFILE_FROM ? PROFILE_FROM : '',
  };
}

function publicAccount(record, now) {
  const status = sessionStatus(record, now);
  if (!status.loggedIn) return { loggedIn: false };
  return { loggedIn: true, nickname: status.nickname, avatarUrl: status.avatarUrl, avatarData: status.avatarData };
}

function normalizeStatus(value) {
  if (!value || value.loggedIn !== true) return { loggedIn: false };
  const nickname = cleanNickname(value.nickname);
  return { loggedIn: true, nickname, avatarUrl: httpsAvatar(value.avatarUrl), avatarData: avatarData(value.avatarData) };
}




function avatarPicture(status, failed) {
  if (!status?.loggedIn) return '';
  const skip = new Set((Array.isArray(failed) ? failed : [failed]).filter(Boolean));
  return [avatarData(status.avatarData), httpsAvatar(status.avatarUrl)].find(value => value && !skip.has(value)) || '';
}

function accountLabel(status) {
  if (!status?.loggedIn) return '尚未登入';
  return status.nickname || '已登入';
}

function accountActionLabel(status) {
  return status?.loggedIn ? '帳號登出' : '紅果立即登入';
}

function initialLoginDraft() {
  return { step: 'phone', countryCode: DEFAULT_REGION, phone: '', code: '', error: '', retryAfter: 0, busy: false };
}

function reduceLogin(state, action) {
  const current = state || initialLoginDraft();
  switch (action?.type) {
    case 'set-country': {
      const region = regionByCode(action.countryCode);
      if (!region) return { ...current, error: '請選擇國家或地區' };
      return {
        ...current,
        countryCode: region.code,
        phone: current.phone.slice(0, region.max),
        error: '',
      };
    }
    case 'set-phone': {
      const region = regionByCode(current.countryCode);
      const limit = region ? region.max : 15;
      return { ...current, phone: String(action.phone ?? '').replace(/\D/g, '').slice(0, limit), error: '' };
    }
    case 'set-code':
      return { ...current, code: normalizeCode(action.code).text, error: '' };
    case 'send': {
      if (current.busy) return current;
      if (current.retryAfter > 0) return current;
      const phone = preparePhone(current.countryCode, current.phone);
      if (!phone.ok) return { ...current, error: phone.error, busy: false };
      return { ...current, error: '', busy: true };
    }
    case 'sent': {
      const result = action.result || {};
      if (!result.ok) return { ...current, busy: false, error: result.error || '驗證碼暫時無法傳送，請稍後再試', retryAfter: result.retryAfter === undefined ? current.retryAfter : retryDelay(result.retryAfter) };
      return { ...current, step: 'code', code: '', error: '', busy: false, retryAfter: retryDelay(result.retryAfter) };
    }
    case 'submit': {
      if (current.busy || current.step !== 'code') return current;
      if (!normalizeCode(current.code).ready) return { ...current, error: '請輸入 4 到 8 位驗證碼' };
      return { ...current, error: '', busy: true };
    }
    case 'finished':
      if (!action.result?.ok) return { ...current, busy: false, error: action.result?.error || '登入沒有完成，請重試' };
      return initialLoginDraft();
    case 'change-number':
      return { ...current, step: 'phone', code: '', error: '', retryAfter: 0, busy: false };
    case 'tick':
      return { ...current, retryAfter: Math.max(0, current.retryAfter - 1) };
    case 'close':
      return initialLoginDraft();
    default:
      return current;
  }
}

module.exports = {
  ACCOUNT_REGIONS, DEFAULT_REGION, SESSION_MS, NICKNAME_LIMIT, PROFILE_FROM,
  regionLabel, regionByCode, wirePhone, preparePhone, normalizeCode, retryDelay,
  cleanNickname, httpsAvatar, avatarData, avatarPicture, sessionStatus, acceptLogin, mergeProfile, publicAccount, normalizeStatus,
  accountLabel, accountActionLabel, initialLoginDraft, reduceLogin,
};
