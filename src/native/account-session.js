'use strict';

const { acceptLogin, preparePhone, publicAccount, retryDelay, sessionStatus } = require('./account-profile');

const CODE_UNAVAILABLE = '验证码暂时无法发送，请稍后再试';
const LOGIN_INCOMPLETE = '登录没有完成，请重试';

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
  if (!result?.ok) return { ok: false, error: typeof result?.error === 'string' && result.error ? result.error : CODE_UNAVAILABLE };
  return { ok: true, retryAfter: retryDelay(result.retryAfter) };
}

async function finishLogin(input, transport, now) {
  const phone = preparePhone(input?.countryCode, input?.phone);
  if (!phone.ok) return phone;
  const code = String(input?.code ?? '');
  if (!/^[0-9]{4,8}$/.test(code)) return { ok: false, error: '请输入 4 到 8 位验证码' };
  if (typeof transport !== 'function') return { ok: false, error: LOGIN_INCOMPLETE };
  let result;
  try {
    result = await transport({ countryCode: phone.countryCode, phone: phone.phone, code });
  } catch {
    return { ok: false, error: LOGIN_INCOMPLETE };
  }
  if (!result?.ok) return { ok: false, error: typeof result?.error === 'string' && result.error ? result.error : LOGIN_INCOMPLETE };
  return acceptLogin(result, now);
}

function createAccountHandlers({ getAccount, saveAccount, now = () => Date.now(), sendTransport, loginTransport }) {
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
      saveAccount(result.record);
      return { ok: true, status: sessionStatus(result.record, now()) };
    },
    logout: async () => {
      saveAccount(null);
      return { loggedIn: false };
    },
  };
}

module.exports = { CODE_UNAVAILABLE, LOGIN_INCOMPLETE, sendLoginCode, finishLogin, createAccountHandlers };
