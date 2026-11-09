'use strict';

const assert = require('node:assert/strict');
const { createCodeClient, xorHex, readProfile } = require('./account-code');

const PROFILE_OK = '{"code":0,"message":"SUCCESS","data":{"user_name":"用户名34908929","biz_user_id":"214708381505","avatar_url":"https://p6-novel.byteimg.com/large/novel-static/abc.jpeg"}}';

function client(handler, profileHandler = () => ({ status: 200, text: PROFILE_OK, headers: {} })) {
  const calls = [];
  const gets = [];
  const saved = [];
  let device = null;
  const api = createCodeClient({
    post: async (url, options) => {
      calls.push({ url, headers: options.headers, body: options.body.toString() });
      return handler(calls.at(-1), calls.length);
    },
    get: async (url, options) => {
      gets.push({ url, headers: options.headers });
      return profileHandler(gets.at(-1), gets.length);
    },
    register: async () => ({ device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '12345678-1234-1234-1234-123456789abc' }),
    getDevice: () => device,
    saveDevice: (value) => { saved.push(value); device = value; },
  });
  return { api, calls, gets, saved };
}

(async () => {
  const sent = client(() => ({
    status: 200,
    text: '{"message":"success","data":{"retry_time":60,"captcha":"","mobile_ticket":"ticket"}}',
    headers: { 'set-cookie': ['store-region=tw'] },
  }));
  const first = await sent.api.send({ countryCode: '+886', phone: '912345678' });
  assert.equal(first.ok, true);
  assert.equal(first.retryAfter, 60);
  assert.match(sent.calls[0].url, /^https:\/\/api5-normal-lq\.fqnovel\.com\/passport\/mobile\/send_code\/v1\/\?/);
  assert.equal(sent.calls[0].headers['X-Medusa'], undefined);
  assert.ok(sent.calls[0].headers['X-Argus']);
  assert.equal(sent.calls[0].body.includes(xorHex('+886912 3456 78')), true);
  assert.equal(sent.calls[0].body.includes(xorHex('24')), true);
  assert.equal(JSON.stringify(sent.saved[0]).includes('912345678'), false);
  await sent.api.send({ countryCode: '+886', phone: '912345678' });
  assert.equal(sent.saved.length, 1);
  assert.match(sent.calls[1].headers.Cookie, /store-region=tw/);

  const limited = client(() => ({ status: 200, text: '{"message":"error","data":{"error_code":7,"description":"访问太频繁，请稍后再试"}}', headers: {} }));
  const blocked = await limited.api.send({ countryCode: '+886', phone: '912345678' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /访问太频繁/);
  assert.equal(limited.calls.length, 1);

  const mainland = client(() => ({ status: 200, text: '{"message":"success","data":{"retry_time":0}}', headers: {} }));
  await mainland.api.send({ countryCode: '+86', phone: '13912345678' });
  assert.ok(mainland.calls[0].headers['X-Medusa']);
  assert.equal(mainland.calls[0].headers['X-Argus'], undefined);
  assert.equal(mainland.calls[0].body.includes(xorHex('+8613912345678')), true);

  const logged = client(() => ({
    status: 200,
    text: '{"message":"success","data":{"user_id":1234567890123456,"user_id_str":"1234567890123456","screen_name":"测试昵称","avatar_url":"https://p9-passport.byteacctimg.com/mosaic-legacy/example.png"}}',
    headers: { 'x-tt-token': 'header-token', 'set-cookie': ['sessionid=abc'] },
  }));
  await logged.api.send({ countryCode: '+886', phone: '912345678' });
  const login = await logged.api.login({ countryCode: '+886', phone: '912345678', code: '0740' });
  assert.equal(login.ok, true);
  assert.equal(login.userId, '1234567890123456');
  assert.equal(login.nickname, '用户名34908929', 'the name comes from the app profile, not screen_name');
  assert.equal(login.avatarUrl, 'https://p6-novel.byteimg.com/large/novel-static/abc.jpeg');
  assert.equal(login.profileFrom, 'user-info');
  assert.equal(login.token, undefined);
  assert.equal(logged.gets.length, 1);
  assert.match(logged.gets[0].url, /^https:\/\/api5-normal-lq\.fqnovel\.com\/reading\/user\/info\/v1\/\?/);
  assert.equal(logged.gets[0].headers['X-Tt-Token'], 'header-token');
  assert.match(logged.gets[0].headers.Cookie, /sessionid=abc/);
  assert.equal(logged.gets[0].headers['Content-Type'], undefined);
  assert.ok(logged.gets[0].headers['X-Argus'], 'international numbers keep the international signature');
  assert.equal(logged.calls[1].headers['X-Tt-Token'], undefined, 'sign-in requests never carry an old token');
  assert.equal(logged.calls[1].body.includes(xorHex('0740')), true);
  assert.equal(logged.calls[1].body.includes('740='), false);
  assert.equal(logged.calls[1].url.includes('/passport/mobile/sms_login/'), true);
  assert.equal(JSON.stringify(login).includes('header-token'), false);

  // The profile read fails or is slow: sign-in still succeeds, without the passport default name.
  for (const profileHandler of [
    () => ({ status: 500, text: '', headers: {} }),
    () => { throw new Error('timeout of 8000ms exceeded'); },
    () => ({ status: 200, text: '{"code":100107,"message":"network err"}', headers: {} }),
    () => ({ status: 200, text: 'not json', headers: {} }),
    () => ({ status: 200, text: '{"code":0,"data":{"user_name":"   ","avatar_url":""}}', headers: {} }),
  ]) {
    const quiet = client(() => ({
      status: 200,
      text: '{"message":"success","data":{"user_id_str":"1234567890123456","screen_name":"用户1690411710523","avatar_url":"https://p9-passport.byteacctimg.com/mosaic-legacy/x.png"}}',
      headers: { 'x-tt-token': 'header-token' },
    }), profileHandler);
    const result = await quiet.api.login({ countryCode: '+886', phone: '912345678', code: '0740' });
    assert.equal(result.ok, true);
    assert.equal(result.nickname, '');
    assert.equal(result.avatarUrl, '');
    assert.equal(result.profileFrom, '');
  }

  // A profile for another account is ignored.
  const other = client(() => ({
    status: 200,
    text: '{"message":"success","data":{"user_id_str":"1234567890123456"}}',
    headers: { 'x-tt-token': 'header-token' },
  }), () => ({ status: 200, text: '{"code":0,"data":{"user_id_str":"9999999999999999","user_name":"别人"}}', headers: {} }));
  assert.equal((await other.api.login({ countryCode: '+886', phone: '912345678', code: '0740' })).nickname, '');

  // Mainland numbers keep the full signature for the profile read too.
  const mainlandLogin = client(() => ({
    status: 200,
    text: '{"message":"success","data":{"user_id_str":"1234567890123456"}}',
    headers: { 'set-cookie': ['sessionid=abc'] },
  }));
  const mainlandResult = await mainlandLogin.api.login({ countryCode: '+86', phone: '13912345678', code: '0740' });
  assert.equal(mainlandResult.nickname, '用户名34908929');
  assert.ok(mainlandLogin.gets[0].headers['X-Medusa']);
  assert.equal(mainlandLogin.gets[0].headers['X-Tt-Token'], undefined);

  // Signing out drops the session, so a later profile read does not go out.
  assert.ok(await logged.api.profile());
  logged.api.reset();
  assert.equal(await logged.api.profile(), null);
  assert.equal(logged.gets.length, 2);

  // Profile fields: a picture from any of the three fields, never the passport default, http, or an overlong address.
  assert.equal(readProfile({ code: 0, data: { user_name: 'A', expand_avatar_url: 'https://p6-novel.byteimg.com/b.jpeg' } }).avatarUrl, 'https://p6-novel.byteimg.com/b.jpeg');
  assert.equal(readProfile({ code: 0, data: { user_name: 'A', basic_info: { user_avatar: 'https://p6-novel.byteimg.com/c.jpeg' } } }).avatarUrl, 'https://p6-novel.byteimg.com/c.jpeg');
  assert.equal(readProfile({ code: 0, data: { user_name: 'A', avatar_url: 'http://p6-novel.byteimg.com/c.jpeg' } }).avatarUrl, '');
  assert.equal(readProfile({ code: 0, data: { user_name: 'A', avatar_url: 'https://p9-passport.byteacctimg.com/mosaic-legacy/x.png' } }).avatarUrl, '');
  assert.equal(readProfile({ code: 0, data: { user_name: 'A', avatar_url: `https://p6-novel.byteimg.com/${'a'.repeat(500)}.jpeg` } }).avatarUrl, '');
  assert.equal(readProfile({ code: 0, data: { user_name: 'x'.repeat(80) } }).nickname.length, 32);
  assert.equal(readProfile({ code: 0, data: { user_name: '😀'.repeat(40) } }).nickname, '😀'.repeat(32), 'emoji are not cut in half');
  assert.equal(readProfile({ code: 0, data: { user_name: 'A\nB\u200bC' } }).nickname, 'ABC');
  assert.equal(readProfile({ code: '0', data: { user_name: '名' } }).nickname, '名');
  assert.equal(readProfile({ code: 0, data: {} }), null);
  assert.equal(readProfile(null), null);

  const mismatch = client(() => ({
    status: 200,
    text: '{"message":"success","data":{"user_id":"42","user_id_str":"43"}}',
    headers: { 'x-tt-token': 'header-token' },
  }));
  const bad = await mismatch.api.login({ countryCode: '+886', phone: '912345678', code: '0740' });
  assert.equal(bad.ok, false);

  const wires = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/passport-international.json'), 'utf8')).regions;
const { wirePhone } = await import('../accountProfile.mjs');
for (const region of wires) assert.equal(wirePhone(region.code, region.local), region.wire, region.code);

console.log('PASS account code client');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
