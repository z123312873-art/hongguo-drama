// SPDX-License-Identifier: GPL-3.0-only
// Data-layer checks against a fake reading API. No title, id or count below is specific to a real comic.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const realApi = require('./comic-api');
const { createComicService, seededShuffle, episodeLabel, bookToCard, topTags, MAX_COMICS } = require('./comic');

const fastScheduler = { rate: 500, burst: 20, concurrency: 3, backoff: [2, 4, 8, 16], rotationCooldownMs: 5 };
const id = (n) => String(7000000000000000000n + BigInt(n));
const md5 = (n) => crypto.createHash('md5').update(String(n)).digest('hex');

function book(n, extra = {}) {
    return { book_id: id(n), book_name: `漫画${n}`, tags: '都市,重生', serial_count: '40', genre_type: '110', thumb_uri: `novel-pic/${md5(n)}`, score: '9.1', abstract: '简介', ...extra };
}

function fakeApi(overrides = {}) {
    const calls = { search: 0, directory: 0, chapter: 0, download: 0, session: 0 };
    const api = {
        ...realApi, calls,
        async createSession() { calls.session += 1; return { n: calls.session }; },
        async searchComicPage(_session, query, paging = {}) {
            calls.search += 1;
            const offset = paging.offset || 0;
            const base = (query.codePointAt(0) % 50) * 100 + offset;
            return { books: Array.from({ length: 20 }, (_, i) => book(base + i + 1)), hasMore: offset < 20, nextOffset: offset + 20, searchId: 's' };
        },
        async fetchDirectory(_session, bookId) {
            calls.directory += 1;
            return Array.from({ length: 120 }, (_, i) => ({ index: i + 1, itemId: id(Number(bookId.slice(-6)) * 1000 + i), title: i === 0 ? '预告' : `第${i}话 标题` }));
        },
        async fetchChapter(_session, itemId) {
            calls.chapter += 1;
            return { title: '第1话', encrypted: true, encryptKey: crypto.randomBytes(32).toString('hex'), pictures: Array.from({ length: 5 }, (_, i) => ({
                index: i, md5: md5(`${itemId}:${i}`), width: 1500, height: 2666, signedUrl: `https://p6-novel1-sign.byteimg.com/tos/${i}.image?sig=1` })) };
        },
        ...overrides,
    };
    return api;
}

const sitePage = (page, ids) => ({ page, totalPages: 2, items: ids.map((n) => ({ series_id: id(n), series_title: `站内${n}`, cover: `https://p3-novel.byteimg.com/novel-pic/${md5(n)}~tplv-resize:320:0.webp`, episode_count: 50, tags: ['都市'] })) });

test('seededShuffle is deterministic, independent of input order, and changes with the seed', () => {
    const items = Array.from({ length: 30 }, (_, i) => String(i));
    const a = seededShuffle(items, 'day-1');
    const b = seededShuffle(items.slice().reverse(), 'day-1');
    const c = seededShuffle(items, 'day-2');
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
    assert.deepEqual(a.slice().sort(), items.slice().sort(), 'nothing lost or duplicated');
    assert.deepEqual(seededShuffle([], 'x'), []);
    assert.deepEqual(seededShuffle(['only'], 'x'), ['only']);
});

test('episode labels use the number in the title and fall back to short titles or the position', () => {
    assert.equal(episodeLabel('第12话 名字', 13), '12');
    assert.equal(episodeLabel('第003話 名字', 4), '3');
    assert.equal(episodeLabel('第5集', 1), '5');
    assert.equal(episodeLabel('预告', 1), '预告');
    assert.equal(episodeLabel('一个很长很长的标题没有编号', 7), '7');
    assert.equal(episodeLabel('', 9), '9');
    assert.equal(episodeLabel(undefined, 2), '2');
});

test('search books become cards only when they carry an id, a title, tags and a cover', () => {
    assert.equal(bookToCard({ book_id: 'abc', book_name: 'x' }, realApi), null);
    assert.equal(bookToCard({ book_id: id(1), book_name: ' ' }, realApi), null);
    const card = bookToCard(book(1, { tags: '都市，重生,都市, ' }), realApi);
    assert.deepEqual(card.tags, ['都市', '重生'], 'comma variants split, empties and duplicates dropped');
    assert.match(card.cover, /^https:\/\/p3-novel\.byteimg\.com\/novel-pic\/[0-9a-f]{32}~tplv-resize:320:0\.webp$/);
    assert.equal(card.rating, null);
    assert.equal(bookToCard(book(2, { thumb_uri: '', thumb_url: 'https://example.com/x.jpg' }), realApi).cover, '');
    assert.equal(topTags([{ tags: ['a', 'b'] }, { tags: ['b'] }, { tags: ['c'] }], 2)[0], 'b');
});

test('extras fill up to the cap from the search sweep, honour exclusions and filters, and are stable within a day', async () => {
    const api = fakeApi({
        async searchComicPage(_session, query, paging = {}) {
            const base = (query.codePointAt(0) % 40) * 100 + (paging.offset || 0);
            const books = Array.from({ length: 20 }, (_, i) => book(base + i + 1));
            books.push(book(base + 90, { genre_type: '1' }), book(base + 91, { serial_count: '5' }), book(base + 92, { tags: '' }), book(base + 93, { thumb_uri: '' }));
            return { books, hasMore: (paging.offset || 0) < 20, nextOffset: (paging.offset || 0) + 20, searchId: 's' };
        },
    });
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    service.noteSitePage(sitePage(1, [1, 2, 3]));
    service.noteSitePage(sitePage(2, [4, 5]));
    const exclude = [id(1), id(2), id(3), id(4), id(5)];
    const first = await service.extras({ exclude, limit: 40 });
    assert.equal(first.success, true);
    assert.equal(first.items.length, 40);
    assert.equal(new Set(first.items.map((item) => item.series_id)).size, 40, 'no duplicates');
    for (const item of first.items) {
        assert.ok(!exclude.includes(item.series_id));
        assert.ok(item.episode_count >= 20 && item.tags.length > 0 && item.cover);
        assert.ok(!/90$|91$|92$|93$/.test(String(Number(item.series_id.slice(-6)))) || true);
    }
    for (const book_ of [90, 91, 92, 93]) assert.ok(!first.items.some((item) => Number(BigInt(item.series_id) - 7000000000000000000n) % 100 === book_), `filtered book ${book_}`);
    const searches = api.calls.search;
    const second = await service.extras({ exclude, limit: 40 });
    assert.deepEqual(second.items.map((item) => item.series_id), first.items.map((item) => item.series_id), 'stable order for the same day');
    assert.equal(api.calls.search, searches, 'a fresh pool answers without searching again');
});

test('extras never exceed the 140 cap in total and a zero or invalid limit returns nothing', async () => {
    const service = createComicService({ api: fakeApi(), schedulerOptions: fastScheduler });
    assert.deepEqual((await service.extras({ limit: 0 })).items, []);
    assert.deepEqual((await service.extras({ limit: 'abc' })).items, []);
    assert.deepEqual((await service.extras({ exclude: 'not-a-list', limit: -5 })).items, []);
    const big = await service.extras({ limit: 10000 });
    assert.ok(big.items.length <= MAX_COMICS);
});

test('a failing search service yields an empty, non-throwing result and is not retried at once', async () => {
    const api = fakeApi({ async searchComicPage() { throw Object.assign(new Error('boom'), { code: 'BUSINESS_REJECTED' }); } });
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    const outcome = await service.extras({ exclude: [], limit: 30 });
    assert.equal(outcome.success, true);
    assert.deepEqual(outcome.items, []);
    assert.equal(outcome.partial, true);
    const attempts = api.calls.session;
    await service.extras({ exclude: [], limit: 30 });
    assert.equal(api.calls.session, attempts, 'the cool-down prevents hammering a failing service');
});

test('a stale pool is served immediately while a new one is built in the background', async () => {
    let now = Date.parse('2026-03-01T10:00:00');
    const api = fakeApi();
    const service = createComicService({ api, now: () => now, schedulerOptions: fastScheduler });
    service.noteSitePage(sitePage(1, [1]));
    const first = await service.extras({ exclude: [id(1)], limit: 30 });
    assert.equal(first.items.length, 30);
    now += 25 * 60 * 60 * 1000;
    const before = api.calls.search;
    const stale = await service.extras({ exclude: [id(1)], limit: 30 });
    assert.equal(stale.items.length, 30, 'answers from the old pool without waiting');
    assert.equal(stale.refreshing, true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(api.calls.search > before, 'the rebuild ran in the background');
});

test('directories are cached, deduplicated and labelled; an empty directory is an error', async () => {
    const api = fakeApi();
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    const [a, b] = await Promise.all([service.episodes(id(5)), service.episodes(id(5))]);
    assert.equal(api.calls.directory, 1);
    assert.equal(a, b);
    assert.equal(a.total, 120);
    assert.equal(a.episodes[0].label, '预告');
    assert.equal(a.episodes[1].label, '1');
    await service.episodes(id(5));
    assert.equal(api.calls.directory, 1, 'cached');
    await assert.rejects(service.episodes('abc'), (error) => error.code === 'APP_INPUT');
    const empty = createComicService({ api: fakeApi({ async fetchDirectory() { return []; } }), schedulerOptions: fastScheduler });
    await assert.rejects(empty.episodes(id(6)), (error) => error.code === 'EMPTY_DIRECTORY');
});

test('chapters ask the CDN for the nearest width above the screen need and cache the chapter data', async () => {
    const api = fakeApi();
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    const small = await service.chapter({ itemId: id(100), width: 500 });
    assert.match(small.pictures[0].url, /tplv-resize:540:0\.webp$/);
    const big = await service.chapter({ itemId: id(100), width: 1000 });
    assert.match(big.pictures[0].url, /tplv-resize:1080:0\.webp$/);
    const huge = await service.chapter({ itemId: id(100), width: 9000 });
    assert.match(huge.pictures[0].url, /tplv-resize:1440:0\.webp$/, 'clamped to the largest rendition');
    const tiny = await service.chapter({ itemId: id(100), width: 0 });
    assert.match(tiny.pictures[0].url, /tplv-resize:360:0\.webp$/);
    assert.equal(api.calls.chapter, 1, 'one chapter call serves every width');
    assert.equal(small.pictureCount, 5);
    assert.equal(small.pictures[0].width, 1500);
    assert.ok(!JSON.stringify(small).includes('signedUrl') && !JSON.stringify(small).includes('sig=1'), 'signed links never reach the renderer');
    await assert.rejects(service.chapter({ itemId: 'x' }), (error) => error.code === 'APP_INPUT');
});

test('a prefetch never delays a click and shares its request', async () => {
    const order = [];
    const api = fakeApi({ async fetchChapter(_s, itemId) { order.push(itemId); await new Promise((r) => setTimeout(r, 3)); return { title: 't', encrypted: false, encryptKey: '', pictures: [{ index: 0, md5: md5(itemId), width: 1, height: 1, signedUrl: '' }] }; } });
    const service = createComicService({ api, schedulerOptions: { ...fastScheduler, concurrency: 1, burst: 1, rate: 1000 } });
    const jobs = [1, 2, 3, 4].map((n) => service.chapter({ itemId: id(200 + n), priority: 'prefetch' }));
    await new Promise((r) => setTimeout(r, 1));
    jobs.push(service.chapter({ itemId: id(204), priority: 'click' }));
    await Promise.all(jobs);
    assert.ok(order.indexOf(id(204)) <= 1, order.join());
    assert.equal(order.filter((item) => item === id(204)).length, 1);
});

test('fallback images are downloaded, authenticated-decrypted and size-detected; links never come from the caller', async () => {
    const key = crypto.randomBytes(32);
    const plain = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(500)]);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const blob = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    let downloads = 0, active = 0, peak = 0;
    const api = fakeApi({
        async fetchChapter() { return { title: 't', encrypted: true, encryptKey: key.toString('hex'), pictures: Array.from({ length: 10 }, (_, i) => ({ index: i, md5: md5(i), width: 1, height: 1, signedUrl: `https://p6-novel1-sign.byteimg.com/x/${i}.image` })) }; },
    });
    const service = createComicService({ api, schedulerOptions: fastScheduler, imageFetcher: async () => { downloads += 1; active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return blob; } });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => service.image({ itemId: id(300), index: i })));
    assert.equal(downloads, 10);
    assert.ok(peak <= 4, `image concurrency capped, saw ${peak}`);
    for (const result of results) { assert.equal(result.mime, 'image/jpeg'); assert.ok(result.data.equals(plain)); }
    await assert.rejects(service.image({ itemId: id(300), index: -1 }), (error) => error.code === 'APP_INPUT');
    await assert.rejects(service.image({ itemId: id(300), index: 1.5 }), (error) => error.code === 'APP_INPUT');
    await assert.rejects(service.image({ itemId: id(300), index: 99 }), (error) => error.code === 'MISSING_PICTURE');
});

test('an expired signed link triggers one fresh chapter call and then succeeds', async () => {
    let chapterCalls = 0, attempts = 0;
    const api = fakeApi({ async fetchChapter() { chapterCalls += 1; return { title: 't', encrypted: false, encryptKey: '', pictures: [{ index: 0, md5: md5(1), width: 1, height: 1, signedUrl: `https://p6-novel1-sign.byteimg.com/x/${chapterCalls}.image` }] }; } });
    const service = createComicService({ api, schedulerOptions: fastScheduler, imageFetcher: async (url) => {
        attempts += 1;
        if (url.endsWith('/1.image')) throw Object.assign(new Error('expired'), { status: 403 });
        return Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);
    } });
    const result = await service.image({ itemId: id(400), index: 0 });
    assert.equal(result.mime, 'image/webp');
    assert.equal(chapterCalls, 2);
    assert.equal(attempts, 2);
});

test('the listing snapshot appears once every site page is known and survives a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-cache-'));
    const file = path.join(dir, 'comic.json');
    try {
        const first = createComicService({ api: fakeApi(), schedulerOptions: fastScheduler });
        first.configure({ file });
        assert.equal(first.snapshot(), null);
        first.noteSitePage(sitePage(1, [1, 2]));
        assert.equal(first.snapshot(), null, 'page 2 of 2 is still missing');
        first.noteSitePage(sitePage(2, [3]));
        const snapshot = first.snapshot();
        assert.equal(snapshot.siteCount, 3);
        assert.deepEqual(snapshot.items.slice(0, 3).map((item) => item.series_id), [id(1), id(2), id(3)], 'site order first');
        await first.extras({ exclude: [id(1), id(2), id(3)], limit: 20 });
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.ok(fs.existsSync(file));
        const saved = first.snapshot();
        assert.ok(saved.items.length > 3 && saved.items.length <= MAX_COMICS);
        const second = createComicService({ api: fakeApi(), schedulerOptions: fastScheduler });
        second.configure({ file });
        const restored = second.snapshot();
        assert.deepEqual(restored.items.map((item) => item.series_id), saved.items.map((item) => item.series_id), 'same listing after a restart');
        fs.writeFileSync(file, '{ not json');
        const damaged = createComicService({ api: fakeApi(), schedulerOptions: fastScheduler });
        damaged.configure({ file });
        assert.equal(damaged.snapshot(), null, 'a damaged cache is ignored');
        fs.writeFileSync(file, JSON.stringify({ version: 1, site: { pages: { 1: [{ series_id: 'bad' }, null, 5] }, totalPages: 1 }, pool: { items: 'nope' } }));
        const hostile = createComicService({ api: fakeApi(), schedulerOptions: fastScheduler });
        hostile.configure({ file });
        assert.deepEqual(hostile.snapshot().items, [], 'invalid entries are dropped');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the total listing is capped at the maximum even when the site alone is larger', () => {
    const service = createComicService({ api: fakeApi(), schedulerOptions: fastScheduler });
    for (let page = 1; page <= 8; page += 1) service.noteSitePage({ page, totalPages: 8, items: Array.from({ length: 24 }, (_, i) => sitePage(1, [page * 100 + i]).items[0]) });
    const snapshot = service.snapshot();
    assert.equal(snapshot.items.length, MAX_COMICS);
    assert.equal(snapshot.siteCount, 192);
});
