// SPDX-License-Identifier: GPL-3.0-only
// Protocol checks for comic-api.js with synthetic keys and responses.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const api = require('./comic-api');

const STATIC = Buffer.from('ac25c67ddd8f38c1b37a2348828e222e', 'hex');
const identity = { device_id: '4474387174276572', iid: '4474387173477868', cdid: '11111111-2222-3333-4444-555555555555' };
const md5 = (n) => crypto.createHash('md5').update(String(n)).digest('hex');

function encryptChapter(json, key, { compress = true } = {}) {
    let raw = Buffer.from(JSON.stringify(json));
    if (compress) raw = zlib.gzipSync(raw);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    return { code: 0, data: { content: Buffer.concat([iv, cipher.update(raw), cipher.final()]).toString('base64'), compress_status: compress ? 1 : 0, title: '第1话 标题' } };
}

const chapterJson = (count = 3, extra = {}) => ({
    itemId: 1, encrypt: true, encrypt_key: crypto.randomBytes(32).toString('hex'),
    picInfos: Array.from({ length: count }, (_, i) => ({ md5: md5(i), width: 1500, height: 2666, picUrl: `https://p9-novel1-sign.byteimg.com/tos/${i}~x.image?sig=1` })), ...extra,
});

test('the key exchange payload is the device id under the shared exchange key, and the key reply decrypts', () => {
    const payload = Buffer.from(api.exchangePayload('4474387174276572'), 'base64');
    const decipher = crypto.createDecipheriv('aes-128-cbc', STATIC, payload.subarray(0, 16));
    const plain = Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]);
    assert.equal(plain.readBigUInt64LE(0), 4474387174276572n);
    assert.equal(plain.readBigUInt64LE(8), 0n);
    const contentKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', STATIC, iv);
    const reply = Buffer.concat([iv, cipher.update(contentKey), cipher.final()]).toString('base64');
    assert.ok(api.exchangeKey(reply).equals(contentKey));
    assert.throws(() => api.exchangeKey(''), (error) => error.code === 'INVALID_RESPONSE');
    assert.throws(() => api.exchangeKey('AAAA'), (error) => error.code === 'INVALID_RESPONSE');
});

test('a session registers the reader device and signs every call with the reader profile', async () => {
    const seen = [];
    const contentKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', STATIC, iv);
    const keyReply = Buffer.concat([iv, cipher.update(contentKey), cipher.final()]).toString('base64');
    const transport = async (url, options) => {
        seen.push({ url, options });
        if (url.includes('registerkey')) return { code: 0, data: { key: keyReply, keyver: 77 } };
        return encryptChapter(chapterJson(2), contentKey);
    };
    let profileUsed;
    const session = await api.createSession({ register: async (_t, profile) => { profileUsed = profile; return identity; }, transport });
    assert.equal(profileUsed.aid, 1967);
    assert.ok(session.key.equals(contentKey));
    assert.equal(session.keyver, 77);
    assert.equal(seen[0].options.method, 'POST');
    assert.equal(new URL(seen[0].url).searchParams.get('aid'), '1967');
    assert.equal(new URL(seen[0].url).searchParams.get('device_id'), identity.device_id);
    const chapter = await api.fetchChapter(session, '7113845784809997000');
    assert.equal(chapter.pictures.length, 2);
    assert.equal(chapter.title, '第1话 标题');
    assert.equal(seen[1].options.method, 'GET');
    assert.equal(new URL(seen[1].url).searchParams.get('item_id'), '7113845784809997000');
    await assert.rejects(api.fetchChapter(session, '12'), (error) => error.code === 'APP_INPUT');
    await assert.rejects(api.fetchChapter(session, 'abc'), (error) => error.code === 'APP_INPUT');
});

test('a business error code from the service is surfaced without leaking the response', async () => {
    const session = { identity, key: crypto.randomBytes(16), transport: async () => ({ code: 101021, message: 'PRIVATE', data: { secret: 'x' } }) };
    await assert.rejects(api.fetchChapter(session, '7113845784809997000'), (error) => error.code === 'BUSINESS_REJECTED' && error.apiCode === 101021 && !/PRIVATE|secret/.test(error.message));
});

test('chapter decoding handles gzip and plain content and rejects damaged data', () => {
    const key = crypto.randomBytes(16);
    for (const compress of [true, false]) {
        const decoded = api.decodeChapter(encryptChapter(chapterJson(4), key, { compress }), key);
        assert.equal(decoded.pictures.length, 4);
        assert.deepEqual(decoded.pictures.map((item) => item.index), [0, 1, 2, 3]);
        assert.equal(decoded.encrypted, true);
        assert.match(decoded.encryptKey, /^[0-9a-f]{64}$/);
    }
    assert.throws(() => api.decodeChapter(encryptChapter(chapterJson(1), key), crypto.randomBytes(16)), (error) => error.code === 'INVALID_RESPONSE', 'wrong key');
    assert.throws(() => api.decodeChapter({ data: {} }, key), (error) => error.code === 'INVALID_RESPONSE');
    assert.throws(() => api.decodeChapter({ data: { content: 'AAAA' } }, key), (error) => error.code === 'INVALID_RESPONSE');
    const bomb = encryptChapter({ picInfos: [], pad: 'a'.repeat(20 * 1024 * 1024) }, key);
    assert.throws(() => api.decodeChapter(bomb, key), (error) => error.code === 'INVALID_RESPONSE', 'oversized output is refused');
});

test('chapter parsing keeps only valid pictures and trusted signed hosts', () => {
    const json = chapterJson(0, { picInfos: [
        { md5: md5(1), width: 1500, height: 2666, picUrl: 'https://p9.byteimg.com/a.image' },
        { md5: 'not-a-hash', width: 1, height: 1, picUrl: 'https://p9.byteimg.com/b.image' },
        { md5: md5(2), width: -5, height: 'x', picUrl: 'http://p9.byteimg.com/c.image' },
        { md5: md5(3), width: 1, height: 1, picUrl: 'https://evil.example.com/d.image' },
        { md5: md5(4), width: 1, height: 1, picUrl: 'https://user:pw@p9.byteimg.com/e.image' },
        { md5: md5(5), width: 1, height: 1, picUrl: 'https://p9.byteimg.com.evil.com/f.image' },
        { md5: md5(6), width: 1, height: 1, picUrl: 'https://p9.byteimg.com:8443/g.image' },
        null, 'junk',
    ] });
    const parsed = api.parseChapter(json);
    assert.deepEqual(parsed.pictures.map((item) => item.index), [0, 1, 2, 3, 4, 5], 'bad hashes are skipped, order is dense');
    assert.equal(parsed.pictures[0].signedUrl, 'https://p9.byteimg.com/a.image');
    for (const item of parsed.pictures.slice(1)) assert.equal(item.signedUrl, '', 'untrusted links are dropped but the plain CDN copy still works');
    assert.equal(parsed.pictures[1].width, 0);
    assert.equal(parsed.pictures[1].height, 0);
    assert.throws(() => api.parseChapter({ picInfos: [] }), (error) => error.code === 'EMPTY_CHAPTER');
    assert.throws(() => api.parseChapter(null), (error) => error.code === 'EMPTY_CHAPTER');
    assert.equal(api.parseChapter(chapterJson(1, { encrypt_key: 'zz' })).encrypted, false, 'a malformed key means the signed copy is not trusted as encrypted');
    assert.equal(api.parseChapter(chapterJson(1, { encrypt: false })).encrypted, false);
});

test('directories keep order, drop duplicates and malformed ids', async () => {
    const rows = [{ item_id: '7000000000001', title: ' 预告 ' }, { item_id: '7000000000002', title: '第1话' }, { item_id: '7000000000002', title: 'dup' }, { item_id: 'bad', title: 'x' }, {}, { item_id: '7000000000003' }];
    const session = { identity, key: Buffer.alloc(16), transport: async () => ({ code: 0, data: { item_data_list: rows } }) };
    const list = await api.fetchDirectory(session, '7111943588446997534');
    assert.deepEqual(list.map((item) => [item.index, item.itemId, item.title]), [[1, '7000000000001', '预告'], [2, '7000000000002', '第1话'], [3, '7000000000003', '']]);
    await assert.rejects(api.fetchDirectory(session, 'nope'), (error) => error.code === 'APP_INPUT');
    const none = { ...session, transport: async () => ({ code: 0, data: {} }) };
    assert.deepEqual(await api.fetchDirectory(none, '7111943588446997534'), []);
});

test('comic search first opens a general search, then pages the comic tab with its id', async () => {
    const urls = [];
    const session = { identity, key: Buffer.alloc(16), transport: async (url) => {
        urls.push(new URL(url).searchParams);
        if (urls.length === 1) return { code: 0, search_tabs: [{ tab_type: 1 }, { tab_type: 8, search_id: 'SID', passback: 'PB' }] };
        return { code: 0, search_tabs: [{ tab_type: 8, search_id: 'SID2', has_more: true, next_offset: 20, data: [{ book_data: [{ book_id: '1' }] }, { book_data: [] }, {}] }] };
    } };
    const page = await api.searchComicPage(session, '都市');
    assert.equal(urls[0].get('tab_type'), '1');
    assert.equal(urls[1].get('tab_type'), '8');
    assert.equal(urls[1].get('search_id'), 'SID');
    assert.equal(urls[1].get('passback'), 'PB');
    assert.equal(page.books.length, 1);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 20);
    assert.equal(page.searchId, 'SID2');
    const next = await api.searchComicPage(session, '都市', { offset: 20, searchId: 'SID2' });
    assert.equal(urls.length, 3, 'a known search id skips the opening call');
    assert.equal(urls[2].get('offset'), '20');
    const nothing = { ...session, transport: async () => ({ code: 0, search_tabs: [{ tab_type: 1 }] }) };
    assert.deepEqual(await api.searchComicPage(nothing, 'x'), { books: [], hasMore: false, nextOffset: 0, searchId: '' });
    assert.ok(next.books.length >= 0);
});

test('picture and cover URLs pick the nearest rendition and reject anything that is not a hash', () => {
    const hash = md5('x').toUpperCase();
    assert.equal(api.pictureUrl(hash, 700), `https://p3-novel.byteimg.com/novel-pic/${hash.toLowerCase()}~tplv-resize:720:0.webp`);
    for (const [need, expected] of [[1, 360], [360, 360], [361, 540], [540, 540], [541, 720], [900, 900], [901, 1080], [1081, 1440], [1441, 1440], [99999, 1440], [NaN, 360], [undefined, 360]]) {
        assert.match(api.pictureUrl(md5('y'), need), new RegExp(`resize:${expected}:0\\.webp$`), `need ${need}`);
    }
    assert.throws(() => api.pictureUrl('../etc', 720));
    assert.throws(() => api.pictureUrl('', 720));
    assert.equal(api.coverUrl('novel-pic/' + md5('a')), `https://p3-novel.byteimg.com/novel-pic/${md5('a')}~tplv-resize:320:0.webp`);
    assert.equal(api.coverUrl('https://p6-novel.byteimg.com/novel-pic/' + md5('a') + '~tplv-shrink:640:0.image'), `https://p3-novel.byteimg.com/novel-pic/${md5('a')}~tplv-resize:320:0.webp`);
    assert.equal(api.coverUrl('https://example.com/cover.jpg'), '');
    assert.equal(api.coverUrl(''), '');
    assert.equal(api.coverUrl(null), '');
});

test('image decryption is authenticated: a flipped byte or a wrong key is an error, never garbage', () => {
    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const plain = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(100)]);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const blob = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    assert.ok(api.decryptImage(blob, key.toString('hex')).equals(plain));
    const flipped = Buffer.from(blob); flipped[20] ^= 1;
    assert.throws(() => api.decryptImage(flipped, key.toString('hex')), (error) => error.code === 'INVALID_RESPONSE');
    assert.throws(() => api.decryptImage(blob, crypto.randomBytes(32).toString('hex')), (error) => error.code === 'INVALID_RESPONSE');
    assert.throws(() => api.decryptImage(blob, 'abcd'), (error) => error.code === 'INVALID_RESPONSE');
    assert.throws(() => api.decryptImage(Buffer.alloc(10), key.toString('hex')), (error) => error.code === 'INVALID_RESPONSE');
    assert.throws(() => api.decryptImage('text', key.toString('hex')), (error) => error.code === 'INVALID_RESPONSE');
});

test('image downloads accept only trusted HTTPS CDN hosts and retry only transient failures', async () => {
    for (const bad of ['http://p9.byteimg.com/a', 'https://evil.com/a', 'https://127.0.0.1/a', 'file:///etc/passwd', 'https://p9.byteimg.com.evil.com/a', '', null, 'https://u:p@p9.byteimg.com/a']) {
        await assert.rejects(api.downloadImage(bad, { fetcher: async () => Buffer.alloc(1) }), (error) => error.code === 'SECURITY_BLOCKED', String(bad));
    }
    let calls = 0;
    const ok = await api.downloadImage('https://p9.byteimg.com/a', { fetcher: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); return Buffer.from('ok'); } });
    assert.equal(ok.toString(), 'ok');
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(api.downloadImage('https://p9.byteimg.com/a', { fetcher: async () => { calls += 1; throw Object.assign(new Error('gone'), { status: 404 }); } }), (error) => error.status === 404);
    assert.equal(calls, 1, 'a 404 is final');
    calls = 0;
    await assert.rejects(api.downloadImage('https://p9.byteimg.com/a', { fetcher: async () => { calls += 1; throw Object.assign(new Error('bad gateway'), { status: 502 }); } }));
    assert.equal(calls, 2, 'a server error gets one more try');
});
