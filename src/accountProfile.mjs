export const ACCOUNT_REGIONS = [
  { code: '+886', name: '中国台湾', min: 9, max: 10 },
  { code: '+86', name: '中国大陆', min: 11, max: 11 },
  { code: '+852', name: '中国香港', min: 8, max: 8 },
  { code: '+853', name: '中国澳门', min: 8, max: 8 },
  { code: '+60', name: '马来西亚', min: 9, max: 10 },
  { code: '+65', name: '新加坡', min: 8, max: 8 },
  { code: '+62', name: '印度尼西亚', min: 10, max: 13 },
  { code: '+95', name: '缅甸', min: 9, max: 10 },
  { code: '+63', name: '菲律宾', min: 7, max: 10 },
  { code: '+84', name: '越南', min: 9, max: 10 },
  { code: '+855', name: '柬埔寨', min: 8, max: 9 },
  { code: '+81', name: '日本', min: 9, max: 11 },
  { code: '+82', name: '韩国', min: 8, max: 11 },
  { code: '+971', name: '阿联酋', min: 9, max: 9 },
];

export const DEFAULT_REGION = '+886';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SKEW_MS = 5 * 60 * 1000;
const CODE_LIMIT = 8;
const NICKNAME_LIMIT = 32;

export function wirePhone(countryCode, phone) {
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

export function regionByCode(code) {
  return ACCOUNT_REGIONS.find(region => region.code === code) || null;
}

export function preparePhone(countryCode, value) {
  const region = regionByCode(countryCode);
  if (!region) return { ok: false, error: '请选择国家或地区' };
  const phone = String(value ?? '').replace(/\D/g, '');
  if (!phone) return { ok: false, error: '请输入手机号' };
  if (phone.length < region.min || phone.length > region.max) return { ok: false, error: '手机号位数不正确' };
  const calling = region.code.slice(1);
  if (calling.length + phone.length > 15) return { ok: false, error: '手机号位数不正确' };
  if (region.code === '+86' && !/^1[3-9]\d{9}$/.test(phone)) return { ok: false, error: '请检查手机号' };
  return { ok: true, countryCode: region.code, phone };
}

export function normalizeCode(value) {
  const text = String(value ?? '').replace(/\D/g, '').slice(0, CODE_LIMIT);
  return { text, ready: text.length >= 4 && text.length <= CODE_LIMIT };
}

export function retryDelay(value) {
  if (value === 0) return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 3600) return 60;
  return number;
}

export function httpsAvatar(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('mosaic-legacy')) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function sessionStatus(record, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { loggedIn: false };
  const userId = typeof record.userId === 'string' ? record.userId.trim() : '';
  const loggedInAt = Number(record.loggedInAt);
  if (!userId || userId === '0' || !Number.isFinite(loggedInAt)) return { loggedIn: false };
  if (loggedInAt > now + SKEW_MS) return { loggedIn: false };
  if (now - loggedInAt >= SESSION_MS) return { loggedIn: false, expired: true };
  const nickname = typeof record.nickname === 'string' ? record.nickname.trim().slice(0, NICKNAME_LIMIT) : '';
  return { loggedIn: true, nickname, avatarUrl: httpsAvatar(record.avatarUrl) };
}

export function acceptLogin(payload, now) {
  const userId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
  if (!userId || userId === '0') return { ok: false, error: '登录没有完成，请重试' };
  const nickname = typeof payload?.nickname === 'string' ? payload.nickname.trim().slice(0, NICKNAME_LIMIT) : '';
  return {
    ok: true,
    record: {
      userId,
      nickname,
      avatarUrl: httpsAvatar(payload?.avatarUrl),
      loggedInAt: now,
    },
  };
}

export function publicAccount(record, now) {
  const status = sessionStatus(record, now);
  if (!status.loggedIn) return { loggedIn: false };
  return { loggedIn: true, nickname: status.nickname, avatarUrl: status.avatarUrl };
}

export function normalizeStatus(value) {
  if (!value || value.loggedIn !== true) return { loggedIn: false };
  const nickname = typeof value.nickname === 'string' ? value.nickname.trim().slice(0, NICKNAME_LIMIT) : '';
  return { loggedIn: true, nickname, avatarUrl: httpsAvatar(value.avatarUrl) };
}

export function accountLabel(status) {
  if (!status?.loggedIn) return '尚未登录';
  return status.nickname || '已登录';
}

export function accountActionLabel(status) {
  return status?.loggedIn ? '帐号登出' : '红果立即登录';
}

export function initialLoginDraft() {
  return { step: 'phone', countryCode: DEFAULT_REGION, phone: '', code: '', error: '', retryAfter: 0, busy: false };
}

export function reduceLogin(state, action) {
  const current = state || initialLoginDraft();
  switch (action?.type) {
    case 'set-country': {
      const region = regionByCode(action.countryCode);
      if (!region) return { ...current, error: '请选择国家或地区' };
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
      if (current.step === 'code' && current.retryAfter > 0) return current;
      const phone = preparePhone(current.countryCode, current.phone);
      if (!phone.ok) return { ...current, error: phone.error, busy: false };
      return { ...current, error: '', busy: true };
    }
    case 'sent': {
      const result = action.result || {};
      if (!result.ok) return { ...current, busy: false, error: result.error || '验证码暂时无法发送，请稍后再试' };
      return { ...current, step: 'code', code: '', error: '', busy: false, retryAfter: retryDelay(result.retryAfter) };
    }
    case 'submit': {
      if (current.busy || current.step !== 'code') return current;
      if (!normalizeCode(current.code).ready) return { ...current, error: '请输入 4 到 8 位验证码' };
      return { ...current, error: '', busy: true };
    }
    case 'finished':
      if (!action.result?.ok) return { ...current, busy: false, error: action.result?.error || '登录没有完成，请重试' };
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
