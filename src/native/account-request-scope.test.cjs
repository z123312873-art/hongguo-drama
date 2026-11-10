const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodeClient } = require('./account-code');
const A = '1000000000000001', B = '1000000000000002';
const session = id => ({ userId: id, region: '+886', token: `fixture-${id}`, cookies: { sessionid: `fixture-session-${id}` } });
const device = { deviceId: '7000000000000000001', installId: '7000000000000000002', cdid: '12345678-1234-1234-1234-123456789abc' };
function fixture(post = async () => ({ status: 200, text: '{"code":0,"data":{}}', headers: {} })) {
  const calls = [];
  const api = createCodeClient({ getDevice: () => device, post: async (url, options) => { calls.push({ url, options }); return post(url, options); } });
  return { api, calls };
}
test('a guarded mutation is never retried on a failure or empty response', async () => {
  for (const response of [{ status: 200, text: '', headers: {} }, { status: 200, text: '{"code":100}', headers: {} }, { status: 500, text: '', headers: {} }]) {
    const h = fixture(async () => response); h.api.restore(session(A));
    await assert.rejects(h.api.request('POST', '/fixture/change', {}, '{}', { retry: false, expectedUserId: A }));
    assert.equal(h.calls.length, 1);
  }
});
test('logged-out and stale-account actions send no request', async () => {
  const h = fixture();
  await assert.rejects(h.api.request('POST', '/fixture/change', {}, '{}', { retry: false, expectedUserId: A }), /NOT_SIGNED_IN/);
  h.api.restore(session(B));
  await assert.rejects(h.api.request('POST', '/fixture/change', {}, '{}', { retry: false, expectedUserId: A }), /ACCOUNT_CHANGED/);
  assert.equal(h.calls.length, 0);
});
test('an account switch while device resolution yields cannot send another account credentials', async () => {
  const h = fixture(); h.api.restore(session(A));
  const pending = h.api.request('POST', '/fixture/change', {}, '{}', { retry: false, expectedUserId: A });
  h.api.restore(session(B));
  await assert.rejects(pending, /ACCOUNT_CHANGED/);
  assert.equal(h.calls.length, 0);
});
test('late responses cannot replace another account cookies or initiate a second request', async () => {
  let finish;
  const h = fixture(() => new Promise(resolve => finish = resolve)); h.api.restore(session(A));
  const pending = h.api.request('POST', '/fixture/change', {}, '{}', { retry: false, expectedUserId: A });
  for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
  assert.equal(typeof finish, 'function');
  h.api.restore(session(B));
  finish({ status: 200, text: '{"code":0,"data":{}}', headers: { 'set-cookie': ['sessionid=old-fixture'] } });
  await assert.rejects(pending, /ACCOUNT_CHANGED/);
  assert.equal(h.api.snapshot().cookies.sessionid, session(B).cookies.sessionid);
  assert.equal(h.calls.length, 1);
});
test('same-account session replacement also invalidates in-flight work', async () => {
  const h = fixture(); h.api.restore(session(A));
  const pending = h.api.request('POST', '/fixture/change', {}, '{}', { retry: false, expectedUserId: A });
  h.api.restore(session(A));
  await assert.rejects(pending, /ACCOUNT_CHANGED/);
  assert.equal(h.calls.length, 0);
});
