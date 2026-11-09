'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { avatarCandidates, sniffImage, avatarDataUri, fetchAvatar } = require('./account-avatar');
const { createAccountHandlers } = require('./account-session');
const { mergeProfile, avatarPicture } = require('./account-profile');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 2)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(20, 3)]);

test('candidates: original first, then JPEG renditions; signed hosts keep only the plain-host rendition', () => {
  const signed = `https://p3-sign.fqnovelpic.com/novel-pic/abc123~tplv-resize:300:300.heic?x-expires=1&x-signature=${'s'.repeat(900)}`;
  const list = avatarCandidates(signed);
  assert.equal(list[0], signed, 'a long signed address is still accepted');
  assert.ok(!list.some(url => url.startsWith('https://p3-sign.fqnovelpic.com/novel-pic/abc123~tplv-shrink')), 'signed host template is not rewritten');
  assert.ok(list.includes('https://p3-novel.byteimg.com/novel-pic/abc123~tplv-shrink:240:0.jpeg'));
  const plain = avatarCandidates('http://p6-novel.byteimg.com/large/novel-static/xyz.heic');
  assert.deepEqual(plain, [
    'https://p6-novel.byteimg.com/large/novel-static/xyz.heic',
    'https://p6-novel.byteimg.com/large/novel-static/xyz.heic~tplv-shrink:240:0.jpeg',
    'https://p3-novel.byteimg.com/novel-static/xyz.heic~tplv-shrink:240:0.jpeg',
  ]);
});

test('candidates: url_list objects, nested arrays, dedupe and limits', () => {
  const list = avatarCandidates({ url_list: ['https://p1-novel.byteimg.com/a/b~x.jpeg', 'https://p1-novel.byteimg.com/a/b~x.jpeg'] }, [[{ uri: 'https://example.com/me.png' }]]);
  assert.equal(list.filter(url => url === 'https://p1-novel.byteimg.com/a/b~x.jpeg').length, 1);
  assert.ok(list.includes('https://example.com/me.png'));
  assert.ok(list.length <= 8);
  assert.ok(avatarCandidates(...Array.from({ length: 20 }, (_, i) => `https://p1-novel.byteimg.com/f/${i}.jpeg`)).length <= 8);
});

test('candidates reject unsafe or placeholder addresses', () => {
  assert.deepEqual(avatarCandidates('http://example.com/a.jpg', 'https://u:p@example.com/a.jpg', 'javascript:alert(1)', 'file:///etc/passwd',
    `https://example.com/${'a'.repeat(2100)}`, 'https://p3-passport.byteacctimg.com/img/mosaic-legacy/3795~120x256.image', '', null, 42, {}), []);
});

test('sniff keeps only formats a page can draw', () => {
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(HEIC), '');
  assert.equal(sniffImage(Buffer.from('<html>error</html>')), '');
  assert.equal(sniffImage(Buffer.alloc(3)), '');
  assert.equal(sniffImage('not a buffer'), '');
});

test('fetch skips failures, HEIC, errors and oversize, and returns the first drawable picture', async () => {
  const seen = [];
  const replies = {
    a: () => { throw new Error('offline'); },
    b: () => ({ status: 404, body: JPEG }),
    c: () => ({ status: 200, body: HEIC }),
    d: () => ({ status: 200, body: Buffer.alloc(600 * 1024, 0xff) }),
    e: () => ({ status: 200, body: PNG }),
    f: () => ({ status: 200, body: JPEG }),
  };
  const result = await fetchAvatar(Object.keys(replies).map(key => `https://x/${key}`), async (url) => { seen.push(url); return replies[url.slice(-1)](); });
  assert.equal(result.url, 'https://x/e');
  assert.ok(result.data.startsWith('data:image/png;base64,'));
  assert.equal(avatarDataUri(result.data), result.data);
  assert.equal(seen.includes('https://x/f'), false, 'stops at the first good picture');
  assert.equal(await fetchAvatar([], async () => ({ status: 200, body: JPEG })), null);
  assert.equal(await fetchAvatar(null), null);
  assert.equal(await fetchAvatar(['https://x/c'], async () => ({ status: 200, body: HEIC })), null);
});

test('data URIs outside drawable images are refused', () => {
  assert.equal(avatarDataUri('data:image/svg+xml;base64,PHN2Zz4='), '');
  assert.equal(avatarDataUri('data:text/html;base64,PGI+'), '');
  assert.equal(avatarDataUri(`data:image/jpeg;base64,${'A'.repeat(800000)}`), '');
});

function handlers({ profile, picture, record }) {
  let saved = record;
  const api = createAccountHandlers({
    getAccount: () => saved,
    saveAccount: (next) => { saved = next; },
    now: () => 1_000_000,
    loginTransport: async () => ({ ok: true, userId: '123456789', nickname: '用户名34908929', avatarUrl: 'https://p3-sign.fqnovelpic.com/novel-pic/abc~tplv-r.heic?x-signature=1', avatarCandidates: ['https://p3-sign.fqnovelpic.com/novel-pic/abc~tplv-r.heic?x-signature=1', 'https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:240:0.jpeg'], profileFrom: 'user-info' }),
    profileTransport: async () => profile,
    avatarTransport: picture,
  });
  return { api, saved: () => saved };
}

test('sign-in stores the downloaded picture so the sidebar draws it even when the address is HEIC', async () => {
  const data = `data:image/jpeg;base64,${JPEG.toString('base64')}`;
  const h = handlers({ picture: async (list) => ({ data, url: list[1] }) });
  const result = await h.api.login({ countryCode: '+886', phone: '912345678', code: '1234' });
  assert.equal(result.ok, true);
  assert.equal(result.status.avatarData, data);
  assert.equal(result.status.avatarUrl, 'https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:240:0.jpeg');
  assert.equal(result.status.nickname, '用户名34908929');
  assert.deepEqual(avatarPicture(result.status, []), data);
});

test('a failed picture download still signs in, and the address stays as a fallback', async () => {
  const h = handlers({ picture: async () => { throw new Error('offline'); } });
  const result = await h.api.login({ countryCode: '+886', phone: '912345678', code: '1234' });
  assert.equal(result.ok, true);
  assert.equal(result.status.avatarData, '');
  assert.ok(result.status.avatarUrl.startsWith('https://p3-sign.fqnovelpic.com/'));
});

test('refresh: a re-signed address of the same picture keeps the stored picture; a new picture replaces it', () => {
  const now = 1_000_000;
  const old = `data:image/jpeg;base64,${JPEG.toString('base64')}`;
  const record = { userId: '1', nickname: 'a', avatarUrl: 'https://p3-sign.fqnovelpic.com/novel-pic/abc~tplv-r.heic?x-signature=1', avatarData: old, profileFrom: 'user-info', loggedInAt: now, expiresAt: now + 1e9 };
  const same = mergeProfile(record, '1', { nickname: 'a', avatarUrl: 'https://p9-sign.fqnovelpic.com/novel-pic/abc~tplv-r.heic?x-signature=2' }, now);
  assert.equal(same.avatarData, old);
  const changed = mergeProfile(record, '1', { nickname: 'a', avatarUrl: 'https://p3-sign.fqnovelpic.com/novel-pic/NEW~tplv-r.heic?x-signature=3' }, now);
  assert.equal(changed.avatarData, '');
  const fresh = `data:image/png;base64,${PNG.toString('base64')}`;
  const replaced = mergeProfile(record, '1', { nickname: 'a', avatarUrl: 'https://p3-novel.byteimg.com/novel-pic/NEW~tplv-shrink:240:0.jpeg', avatarData: fresh }, now);
  assert.equal(replaced.avatarData, fresh);
});
