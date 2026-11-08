'use strict';

const assert = require('node:assert/strict');
const { createCodeClient, xorHex } = require('./account-code');

function client(handler) {
  const calls = [];
  const saved = [];
  let device = null;
  const api = createCodeClient({
    post: async (url, options) => {
      calls.push({ url, headers: options.headers, body: options.body.toString() });
      return handler(calls.at(-1), calls.length);
    },
    register: async () => ({ device_id: '7000000000000000001', iid: '7000000000000000002', cdid: '12345678-1234-1234-1234-123456789abc' }),
    getDevice: () => device,
    saveDevice: (value) => { saved.push(value); device = value; },
  });
  return { api, calls, saved };
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
  assert.equal(login.nickname, '测试昵称');
  assert.equal(login.avatarUrl, '');
  assert.equal(login.token, undefined);
  assert.equal(logged.calls[1].body.includes(xorHex('0740')), true);
  assert.equal(logged.calls[1].body.includes('740='), false);
  assert.equal(logged.calls[1].url.includes('/passport/mobile/sms_login/'), true);
  assert.equal(JSON.stringify(login).includes('header-token'), false);

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
