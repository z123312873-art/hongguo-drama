'use strict';

const { acceptLogin, httpsAvatar, mergeProfile, preparePhone, publicAccount, retryDelay, sessionStatus } = require('./account-profile');

const CODE_UNAVAILABLE = '驗證碼暫時無法傳送，請稍後再試';
const LOGIN_INCOMPLETE = '登入沒有完成，請重試';

async function sendLoginCode(input, transport) {
  const phone = preparePhone(input?.countryCode, input?.phone);
  if (!phone.ok) return phone;
  if (typeof transport !== 'function') return { ok: false, error: CODE_UNAVAILABLE };
  let result;
  try {
    result = await transport({ countryCode: phone.countryCode, phone: phone.phone });
  } catch {
    return { ok: false, error: CODE_UNAVAILABLE };
  }
  if (!result?.ok) return { ok: false, error: typeof result?.error === 'string' && result.error ? result.error : CODE_UNAVAILABLE, ...(result?.retryAfter !== undefined ? { retryAfter: retryDelay(result.retryAfter) } : {}) };
  return { ok: true, retryAfter: retryDelay(result.retryAfter) };
}

async function finishLogin(input, transport, now) {
  const phone = preparePhone(input?.countryCode, input?.phone);
  if (!phone.ok) return phone;
  const code = String(input?.code ?? '');
  if (!/^[0-9]{4,8}$/.test(code)) return { ok: false, error: '請輸入 4 到 8 位驗證碼' };
  if (typeof transport !== 'function') return { ok: false, error: LOGIN_INCOMPLETE };
  let result;
  try {
    result = await transport({ countryCode: phone.countryCode, phone: phone.phone, code });
  } catch {
    return { ok: false, error: LOGIN_INCOMPLETE };
  }
  if (!result?.ok) return { ok: false, error: typeof result?.error === 'string' && result.error ? result.error : LOGIN_INCOMPLETE };
  const accepted = acceptLogin(result, now);
  if (accepted.ok && Array.isArray(result.avatarCandidates)) accepted.avatarCandidates = result.avatarCandidates.filter(item => typeof item === 'string');
  return accepted;
}


async function withPicture(target, candidates, avatarTransport) {
  if (typeof avatarTransport !== 'function' || !Array.isArray(candidates) || !candidates.length) return target;
  let picture = null;
  try { picture = await avatarTransport(candidates); } catch { picture = null; }
  if (!picture?.data) return target;
  return { ...target, avatarData: picture.data, avatarUrl: httpsAvatar(picture.url) || target.avatarUrl };
}

function createAccountHandlers({ getAccount, saveAccount, now = () => Date.now(), sendTransport, loginTransport, profileTransport, avatarTransport }) {
  const read = () => {
    const record = getAccount();
    const status = publicAccount(record, now());
    if (record && !status.loggedIn) saveAccount(null);
    return status;
  };
  return {
    status: async () => read(),
    sendCode: async (input) => sendLoginCode(input, sendTransport),
    login: async (input) => {
      const result = await finishLogin(input, loginTransport, now());
      if (!result.ok) return { ok: false, error: result.error };
      const record = await withPicture(result.record, result.avatarCandidates, avatarTransport);
      saveAccount(record);
      return { ok: true, status: sessionStatus(record, now()) };
    },


    refresh: async () => {
      const before = getAccount();
      if (!publicAccount(before, now()).loggedIn || typeof profileTransport !== 'function') return read();
      let profile = null;
      try { profile = await profileTransport(); } catch { profile = null; }
      if (profile) profile = await withPicture(profile, profile.avatarCandidates, avatarTransport);
      const current = getAccount();
      const next = mergeProfile(current, before.userId, profile, now());
      if (next) saveAccount(next);
      return read();
    },
    logout: async () => {
      saveAccount(null);
      return { loggedIn: false };
    },
  };
}

module.exports = { CODE_UNAVAILABLE, LOGIN_INCOMPLETE, sendLoginCode, finishLogin, createAccountHandlers };
