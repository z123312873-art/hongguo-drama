// SPDX-License-Identifier: GPL-3.0-only
// Data-layer checks against a fake reading API. No title, id or count below is specific to a real comic.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const realApi = require('./comic-api');
const { createComicService, withNetworkHint, seededShuffle, episodeLabel, bookToCard, topTags, MAX_COMICS, IMAGE_CONCURRENCY, seededRank } = require('./comic');

const fastScheduler = { rate: 500, burst: 20, concurrency: 3, backoff: [2, 4, 8, 16], rotationCooldownMs: 5, rejectionPauseMs: 5 };
const id = (n) => String(7000000000000000000n + BigInt(n));
const md5 = (n) => crypto.createHash('md5').update(String(n)).digest('hex');

function book(n, extra = {}) {
    return { book_id: id(n), book_name: `漫画${n}`, tags: '都市,重生', serial_count: '40', genre_type: '110', thumb_uri: `novel-pic/${md5(n)}`, score: '9.1', abstract: '简介', ...extra };
}

function fakeApi(overrides = {}) {
    const calls = { details: 0, category: 0, search: 0, directory: 0, chapter: 0, download: 0, session: 0 };
    const api = {
        ...realApi, calls,
        async createSession() { calls.session += 1; return { n: calls.session }; },
        async searchComicPage(_session, query, paging = {}) {
            calls.search += 1;
            const offset = paging.offset || 0;
            const base = (query.codePointAt(0) % 50) * 100 + offset;
            return { books: Array.from({ length: 20 }, (_, i) => book(base + i + 1)), hasMore: offset < 20, nextOffset: offset + 20, searchId: 's' };
        },
        async fetchBookDetails() { calls.details += 1; return []; },
        async fetchBookInfo() { calls.bookinfo = (calls.bookinfo || 0) + 1; return null; },
        async fetchCategoryPage() { calls.category += 1; return { books: [], hasMore: false, nextOffset: 0 }; },
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

test('category pages fill the pool when the keyword search returns nothing at all', async () => {
    let category = 0;
    const api = fakeApi({
        async searchComicPage() { return { books: [], hasMore: false, nextOffset: 0, searchId: '' }; },
        async fetchBookDetails(_session, ids) {
            return ids.map((bookId, index) => ({ book_id: bookId, genre_type: '110', category_schema: JSON.stringify([{ category_id: 100 + (index % 3), name: 'c' }, { category_id: 100 }]) }));
        },
        async fetchCategoryPage(_session, categoryId, offset = 0) {
            category += 1;
            const base = (categoryId - 100) * 1000 + offset;
            return { books: Array.from({ length: 10 }, (_, i) => book(base + i + 1)), hasMore: offset < 40, nextOffset: offset + 10 };
        },
    });
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    service.noteSitePage(sitePage(1, [1, 2, 3, 4]));
    const outcome = await settled(service, { exclude: [id(1), id(2), id(3), id(4)], limit: 60, waitMs: 5000 });
    assert.equal(outcome.items.length, 60);
    assert.equal(new Set(outcome.items.map((item) => item.series_id)).size, 60);
    assert.ok(category >= 6, 'several category pages were read');
});

test('with every source empty the reply explains what was tried', async () => {
    const api = fakeApi({ async searchComicPage() { return { books: [], hasMore: false, nextOffset: 0, searchId: '' }; } });
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    service.noteSitePage(sitePage(1, [1, 2]));
    const outcome = await settled(service, { exclude: [], limit: 30, waitMs: 5000 });
    assert.deepEqual(outcome.items, []);
    assert.match(outcome.diagnostic, /分类 0 个\/0 页，搜索 \d+ 页，收到 0 部，没有可用漫画/);
});

test('a failing category source does not stop the keyword search from filling the pool', async () => {
    const api = fakeApi({
        async fetchBookDetails() { throw Object.assign(new Error('x'), { code: 'BUSINESS_REJECTED' }); },
    });
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    service.noteSitePage(sitePage(1, [1, 2]));
    const outcome = await settled(service, { exclude: [], limit: 30, waitMs: 5000 });
    assert.equal(outcome.items.length, 30);
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
    assert.ok(peak <= IMAGE_CONCURRENCY && peak > 1, `image concurrency capped at ${IMAGE_CONCURRENCY}, saw ${peak}`);
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
    const pages = Math.ceil(MAX_COMICS / 24) + 2;
    for (let page = 1; page <= pages; page += 1) service.noteSitePage({ page, totalPages: pages, items: Array.from({ length: 24 }, (_, i) => sitePage(1, [page * 100 + i]).items[0]) });
    const snapshot = service.snapshot();
    assert.equal(snapshot.items.length, MAX_COMICS);
    assert.equal(snapshot.siteCount, pages * 24);
});

test('a slow first build answers at once with what it has, keeps growing, and a later call sees the rest', async () => {
    const gate = { release: null };
    const hold = new Promise((resolve) => { gate.release = resolve; });
    let searches = 0;
    const api = fakeApi({
        async searchComicPage(_session, query, paging = {}) {
            searches += 1;
            if (searches > 2) await hold;
            const base = (query.codePointAt(0) % 40) * 100 + (paging.offset || 0);
            return { books: Array.from({ length: 20 }, (_, i) => book(base + i + 1)), hasMore: (paging.offset || 0) < 20, nextOffset: (paging.offset || 0) + 20, searchId: 's' };
        },
    });
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    service.noteSitePage(sitePage(1, [1]));
    const first = await service.extras({ exclude: [id(1)], limit: 100, waitMs: 60 });
    assert.equal(first.success, true);
    assert.equal(first.refreshing, true, 'the build is still running');
    assert.equal(first.partial, true);
    assert.ok(first.items.length > 0 && first.items.length < 100, `first batch ${first.items.length}`);
    gate.release();
    let later = first;
    for (let round = 0; round < 40 && later.items.length < 100; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        later = await service.extras({ exclude: [id(1)], limit: 100, waitMs: 0 });
    }
    assert.equal(later.items.length, 100);
    assert.equal(later.partial, false);
});

test('when nothing can be fetched the reply says why, with the stage and code but no service text', async () => {
    const api = fakeApi({ async searchComicPage() { throw Object.assign(new Error('漫画服务暂时无法提供该内容（搜索，代码 101021）'), { code: 'BUSINESS_REJECTED', apiCode: 101021 }); } });
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    const outcome = await service.extras({ exclude: [], limit: 30, waitMs: 5000 });
    assert.deepEqual(outcome.items, []);
    assert.equal(outcome.refreshing, false);
    assert.match(outcome.diagnostic, /搜索，代码 101021/);
});

async function settled(service, args) {
    let outcome = await service.extras(args);
    for (let guard = 0; outcome.refreshing && guard < 400; guard += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        outcome = await service.extras(args);
    }
    return outcome;
}

test('a pool that is still growing is continued after a minute; one that stopped growing waits much longer', async () => {
    let now = Date.parse('2026-03-01T10:00:00');
    let available = 10;
    let searches = 0;
    const api = fakeApi({
        async searchComicPage(_session, query, paging = {}) {
            searches += 1;
            const base = (query.codePointAt(0) % 40) * 100;
            return { books: Array.from({ length: available }, (_, i) => book(base + i + 1)), hasMore: false, nextOffset: 0, searchId: 's' };
        },
    });
    const service = createComicService({ api, now: () => now, schedulerOptions: fastScheduler });
    service.noteSitePage(sitePage(1, [1]));
    const first = await settled(service, { exclude: [id(1)], limit: 130, waitMs: 5000 });
    assert.ok(first.items.length > 0 && first.items.length < 130);
    const searchesAfterFirst = searches;
    now += 61 * 1000;
    available = 20;
    await settled(service, { exclude: [id(1)], limit: 130, waitMs: 5000 });
    assert.ok(searches > searchesAfterFirst, 'a pool that grew is continued after about a minute');
    const second = searches;
    available = 0;
    now += 61 * 1000;
    await settled(service, { exclude: [id(1)], limit: 130, waitMs: 5000 });
    now += 61 * 1000;
    const third = searches;
    await settled(service, { exclude: [id(1)], limit: 130, waitMs: 5000 });
    assert.equal(searches, third, 'no growth: not retried again within the long window');
    assert.ok(second <= third);
});

test('episodes load through the real client even when the service refuses the key exchange, and a refused device is replaced', async () => {
    const identity = { device_id: '7500000000000000001', iid: '7500000000000000002', cdid: 'c' };
    let registrations = 0;
    let refuseDirectory = 1;
    const transport = async (url) => {
        if (url.includes('registerkey')) return { code: 101021 };
        if (url.includes('directory')) {
            if (refuseDirectory > 0) { refuseDirectory -= 1; return { code: 101021 }; }
            return { code: 0, data: { item_data_list: Array.from({ length: 30 }, (_, i) => ({ item_id: id(9000 + i), title: `第${i + 1}话` })) } };
        }
        return { code: 0 };
    };
    const api = { ...realApi, createSession: () => { registrations += 1; return realApi.createSession({ register: async () => identity, transport }); } };
    const service = createComicService({ api, schedulerOptions: { ...fastScheduler, rejectionPauseMs: 5 } });
    const outcome = await service.episodes(id(5));
    assert.equal(outcome.total, 30);
    assert.equal(outcome.episodes[0].label, '1');
    assert.equal(registrations, 1, 'one early refusal is retried on the same device');
});

test('a service that refuses every directory request ends with the stage and the code in the message', async () => {
    const identity = { device_id: '7500000000000000001', iid: '7500000000000000002', cdid: 'c' };
    const transport = async () => ({ code: 101021 });
    const api = { ...realApi, createSession: () => realApi.createSession({ register: async () => identity, transport }) };
    const service = createComicService({ api, schedulerOptions: { ...fastScheduler, rejectionPauseMs: 5 } });
    await assert.rejects(service.episodes(id(5)), (error) => error.code === 'BUSINESS_REJECTED' && /分集目录，代码 101021/.test(error.message));
});

function gatedTransport(accept, seen = []) {
    return async (url, options = {}) => {
        const host = new URL(url).host;
        seen.push({ host, headers: options.headers || {} });
        if (url.includes('registerkey')) return { code: 101021 };
        if (!url.includes('directory')) return { code: 0 };
        if (!accept(host, options.headers || {})) return { code: 101104 };
        return { code: 0, data: { item_data_list: Array.from({ length: 30 }, (_, i) => ({ item_id: id(9000 + i), title: `第${i + 1}话` })) } };
    };
}

test('a service that answers one client with 101104 is reached through another route, and the working route is remembered', async () => {
    const identity = { device_id: '7500000000000000001', iid: '7500000000000000002', cdid: 'c' };
    const wanted = realApi.ROUTES[2];
    const seen = [];
    let registrations = 0;
    const api = { ...realApi, createSession: (options) => { registrations += 1; return realApi.createSession({ ...options, register: async () => identity, transport: gatedTransport((host) => host === wanted.host, seen) }); } };
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'comic-route-')), 'cache.json');
    try {
        const service = createComicService({ api, schedulerOptions: { ...fastScheduler, rotationCooldownMs: 1 } });
        service.configure({ file });
        const outcome = await service.episodes(id(5));
        assert.equal(outcome.total, 30);
        assert.deepEqual([...new Set(seen.filter((entry) => !entry.host.includes('log')).map((entry) => entry.host))], [realApi.ROUTES[0].host, realApi.ROUTES[1].host, wanted.host]);
        const before = registrations;
        await service.episodes(id(6));
        assert.equal(registrations, before, 'the next title uses the same device on the same route');
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).route, wanted.id);
        const reopened = createComicService({ api, schedulerOptions: fastScheduler });
        reopened.configure({ file });
        seen.length = 0;
        await reopened.episodes(id(7));
        assert.equal(seen.find((entry) => !entry.host.includes('log')).host, wanted.host, 'a restart starts on the remembered route');
    } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('when every route is refused the code is reported after a bounded number of devices', async () => {
    const identity = { device_id: '7500000000000000001', iid: '7500000000000000002', cdid: 'c' };
    let registrations = 0;
    const api = { ...realApi, createSession: (options) => { registrations += 1; return realApi.createSession({ ...options, register: async () => identity, transport: gatedTransport(() => false) }); } };
    const service = createComicService({ api, schedulerOptions: { ...fastScheduler, rotationCooldownMs: 1 } });
    await assert.rejects(service.episodes(id(5)), (error) => error.code === 'BUSINESS_REJECTED' && error.apiCode === 101104);
    assert.ok(registrations <= 5, `registered ${registrations} devices`);
});

test('only the later routes pin a region or forward an address, and each device keeps one address', async () => {
    const identity = { device_id: '7500000000000000001', iid: '7500000000000000002', cdid: 'c' };
    const plain = realApi.routeHeaders(realApi.ROUTES[0], identity);
    assert.deepEqual(plain, {});
    const forwarded = realApi.ROUTES.find((route) => route.forwarded);
    const device = { ...identity };
    const first = realApi.routeHeaders(forwarded, device);
    const second = realApi.routeHeaders(forwarded, device);
    assert.match(first['X-Forwarded-For'], /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.equal(first['X-Forwarded-For'], second['X-Forwarded-For']);
    assert.match(first.Cookie, new RegExp(`install_id=${identity.iid}`));
    assert.match(first['x-tt-store-region'], /^cn-[a-z]{2}$/);
    assert.ok(realApi.ROUTES.every((route) => /^[a-z0-9.-]+\.fqnovel\.com$/.test(route.host) && (route.registerHosts || []).every((host) => /(^|\.)(fqnovel|snssdk)\.com$/.test(host))));
});

test('the network hint is added only to a refusal, once, and follows the proxy setting', () => {
    const refusal = Object.assign(new Error('漫画服务暂时无法提供该内容（分集目录，代码 101104）'), { code: 'BUSINESS_REJECTED' });
    assert.match(withNetworkHint(refusal, false), /代码 101104）。.*啟用其他地區的代理/);
    assert.match(withNetworkHint(refusal, true), /改用其他地區的代理/);
    assert.equal(withNetworkHint(Object.assign(new Error('漫画服务连接失败'), { code: 'ERR_NETWORK' }), false), '漫画服务连接失败');
    const hinted = withNetworkHint(refusal, false);
    assert.equal(withNetworkHint(Object.assign(new Error(hinted), { code: 'BUSINESS_REJECTED' }), false), hinted);
});

test('a title is read from whichever field names its tags and cover, and a missing genre is accepted from a comic listing', async () => {
    const fromCategory = bookToCard({ book_id: id(1), book_name: '甲', tags: '', pure_category_tags: '热血,都市', serial_count: '30', thumb_uri: '', thumb_url: `https://x.fqnovelpic.com/novel-images/${md5(1)}~tplv-a.heic?s=1` }, realApi);
    assert.deepEqual(fromCategory.tags, ['热血', '都市']);
    assert.match(fromCategory.cover, new RegExp(`/novel-images/${md5(1)}~tplv-resize:320:0\\.webp$`));
    assert.deepEqual(bookToCard({ book_id: id(2), book_name: '乙', category: '悬疑', serial_count: '30', thumb_uri: `novel-pic/${md5(2)}` }, realApi).tags, ['悬疑']);

    const api = fakeApi({
        async searchComicPage(_session, query, paging = {}) {
            const base = (query.codePointAt(0) % 40) * 100 + (paging.offset || 0);
            const books = Array.from({ length: 12 }, (_, i) => book(base + i + 1, i % 2 ? { genre_type: undefined } : {}));
            books.push(book(base + 90, { genre_type: '1' }));
            return { books, hasMore: false, nextOffset: 0, searchId: 's' };
        },
    });
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    const outcome = await settled(service, { exclude: [], limit: 30, waitMs: 5000 });
    assert.equal(outcome.items.length, 30);
    assert.ok(outcome.items.every((item) => Number(BigInt(item.series_id) - 7000000000000000000n) % 100 !== 90), 'a listing record of another genre is still turned away');
});

test('categories are found through the directory records when the details call returns nothing', async () => {
    const pages = [];
    const api = fakeApi({
        async searchComicPage() { return { books: [], hasMore: false, nextOffset: 0, searchId: '' }; },
        async fetchBookInfo(_session, bookId) {
            return { book_id: bookId, genre_type: '110', category_schema: JSON.stringify([{ category_id: 300 + (Number(bookId.slice(-3)) % 2), name: 'c' }]) };
        },
        async fetchCategoryPage(_session, categoryId, offset = 0) {
            pages.push(categoryId);
            const base = (categoryId - 300) * 1000 + offset;
            return { books: Array.from({ length: 10 }, (_, i) => book(base + i + 1)), hasMore: offset < 30, nextOffset: offset + 10 };
        },
    });
    const service = createComicService({ api, schedulerOptions: fastScheduler });
    service.noteSitePage(sitePage(1, [11, 12, 13, 14]));
    const outcome = await settled(service, { exclude: [id(11), id(12), id(13), id(14)], limit: 40, waitMs: 5000 });
    assert.equal(outcome.items.length, 40);
    assert.ok(new Set(pages).size >= 1, 'category pages were read');
});

function seedBooks(from, count) {
    return Array.from({ length: count }, (_, i) => {
        const card = bookToCard(book(from + i), realApi);
        return { series_id: card.series_id, series_title: card.series_title, cover: card.cover, episode_count: card.episode_count, tags: card.tags, introduction: '', rating: null, completion_status: 'unknown', score: card.score };
    });
}

test('when no live listing returns anything, the shipped titles fill the list up to the cap without waiting', async () => {
    const api = fakeApi({ async searchComicPage() { return { books: [], hasMore: false, nextOffset: 0, searchId: '' }; } });
    const service = createComicService({ api, schedulerOptions: fastScheduler, seed: seedBooks(5000, MAX_COMICS + 100) });
    service.noteSitePage(sitePage(1, [5000, 5001, 1, 2]));
    const exclude = [id(5000), id(5001), id(1), id(2)];
    const started = Date.now();
    const first = await service.extras({ exclude, limit: 66, waitMs: 5000 });
    assert.ok(Date.now() - started < 1000, 'answers at once');
    assert.equal(first.items.length, 66);
    assert.equal(new Set(first.items.map((item) => item.series_id)).size, 66);
    assert.ok(first.items.every((item) => !exclude.includes(item.series_id)), 'titles already on the site are not repeated');
    assert.equal(first.diagnostic, '');
    const second = await service.extras({ exclude, limit: 66 });
    assert.deepEqual(second.items.map((item) => item.series_id), first.items.map((item) => item.series_id), 'stable within a day');
    const capped = await service.extras({ exclude: [], limit: 10000 });
    assert.equal(capped.items.length, MAX_COMICS);
});

test('live titles come before the shipped ones, and a shipped title with no episodes is dropped from then on', async () => {
    const api = fakeApi({
        async fetchDirectory(_session, bookId) { return bookId === id(5003) ? [] : [{ index: 1, itemId: id(9), title: '第1话' }]; },
    });
    const service = createComicService({ api, schedulerOptions: fastScheduler, seed: seedBooks(5000, 10) });
    const outcome = await settled(service, { exclude: [], limit: 30, waitMs: 5000 });
    assert.equal(outcome.items.length, 30);
    const live = outcome.items.filter((item) => item.source_kind !== 'seed');
    assert.equal(live.length, 30, 'enough live titles: the shipped ones are not needed');

    const quiet = createComicService({ api: fakeApi({ async searchComicPage() { return { books: [], hasMore: false, nextOffset: 0, searchId: '' }; }, async fetchDirectory(_session, bookId) { return bookId === id(5003) ? [] : [{ index: 1, itemId: id(9), title: '第1话' }]; } }), schedulerOptions: fastScheduler, seed: seedBooks(5000, 10) });
    assert.ok((await quiet.extras({ limit: 10 })).items.some((item) => item.series_id === id(5003)));
    await assert.rejects(quiet.episodes(id(5003)), (error) => error.code === 'EMPTY_DIRECTORY');
    const after = await quiet.extras({ limit: 10 });
    assert.ok(!after.items.some((item) => item.series_id === id(5003)));
    assert.equal(after.items.length, 9);
});

test('the shipped list is valid, unique, and large enough to fill the cap on its own', () => {
    const { loadSeed } = require('./comic');
    const list = loadSeed();
    assert.ok(list.length >= MAX_COMICS + 100, `${list.length} shipped titles`);
    const ids = new Set();
    for (const card of list) {
        assert.match(card.series_id, /^\d{6,30}$/);
        assert.ok(!ids.has(card.series_id), 'unique');
        ids.add(card.series_id);
        assert.ok(card.series_title && card.episode_count >= 20 && card.tags.length > 0);
        assert.match(card.cover, /^https:\/\/p3-novel\.byteimg\.com\/novel-(pic|images)\/[0-9a-f]{32}~tplv-resize:320:0\.webp$/);
    }
});

const ids = (outcome) => outcome.items.map((item) => item.series_id);

test('extra titles keep their order while the pool grows and across refreshes', async () => {
    let breadth = 3;
    const api = fakeApi({
        async searchComicPage(_session, query, paging = {}) {
            const offset = paging.offset || 0;
            const base = (query.codePointAt(0) % 20) * 100 + offset;
            return { books: Array.from({ length: breadth }, (_, i) => book(base + i + 1)), hasMore: offset < 20, nextOffset: offset + 20, searchId: 's' };
        },
    });
    let now = Date.parse('2026-03-01T10:00:00');
    const service = createComicService({ api, now: () => now, schedulerOptions: fastScheduler });
    service.noteSitePage(sitePage(1, [1]));
    const exclude = [id(1)];
    const first = await settled(service, { exclude, limit: 12, waitMs: 5000 });
    assert.ok(first.items.length >= 6, `first ${first.items.length}`);
    breadth = 20;
    now += 2 * 60 * 60 * 1000;
    for (let round = 0; round < 5; round += 1) {
        now += POOL_RETRY_FOR_TEST;
        const next = await settled(service, { exclude, limit: 40, waitMs: 5000 });
        assert.deepEqual(ids(next).slice(0, ids(first).length), ids(first), `round ${round}: titles already shown keep their place`);
        assert.equal(new Set(ids(next)).size, ids(next).length);
    }
    assert.ok(service._state.pool.items.length > first.items.length, 'the pool did grow');
});

const POOL_RETRY_FOR_TEST = 31 * 60 * 1000;

test('a refresh never swaps shipped titles for live ones that arrive later, and the order survives a restart on the same day', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-served-'));
    const file = path.join(dir, 'cache.json');
    try {
        const now = () => Date.parse('2026-03-01T10:00:00');
        let live = false;
        const api = fakeApi({ async searchComicPage(_session, query, paging = {}) {
            if (!live) return { books: [], hasMore: false, nextOffset: 0, searchId: '' };
            return { books: Array.from({ length: 20 }, (_, i) => book(9000 + (query.codePointAt(0) % 30) * 100 + (paging.offset || 0) + i)), hasMore: false, nextOffset: 0, searchId: 's' };
        } });
        const service = createComicService({ api, now, schedulerOptions: fastScheduler, seed: seedBooks(5000, 80) });
        service.configure({ file });
        service.noteSitePage(sitePage(1, [1]));
        const exclude = [id(1)];
        const first = await settled(service, { exclude, limit: 50, waitMs: 5000 });
        assert.equal(first.items.length, 50);
        live = true;
        const again = await settled(service, { exclude, limit: 50, waitMs: 5000 });
        assert.deepEqual(ids(again), ids(first), 'nothing on screen is replaced');
        const wider = await settled(service, { exclude, limit: 60, waitMs: 5000 });
        assert.deepEqual(ids(wider).slice(0, 50), ids(first));
        await new Promise((resolve) => setTimeout(resolve, 700));

        const restarted = createComicService({ api: fakeApi(), now, schedulerOptions: fastScheduler, seed: seedBooks(5000, 80) });
        restarted.configure({ file });
        const back = await restarted.extras({ exclude, limit: 60, waitMs: 0 });
        assert.deepEqual(ids(back), ids(wider), 'same list after a restart');

        const tomorrow = createComicService({ api: fakeApi(), now: () => Date.parse('2026-03-02T10:00:00'), schedulerOptions: fastScheduler, seed: seedBooks(5000, 80) });
        tomorrow.configure({ file });
        const rotated = await tomorrow.extras({ exclude, limit: 60, waitMs: 0 });
        assert.notDeepEqual(ids(rotated), ids(wider), 'a new day gives a new order');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the day does not turn over while the app stays open; a title that cannot be read is the only one that leaves', async () => {
    let now = Date.parse('2026-03-01T23:50:00');
    let victim = '';
    const api = fakeApi({
        async searchComicPage() { return { books: [], hasMore: false, nextOffset: 0, searchId: '' }; },
        async fetchDirectory(_session, bookId) { return bookId === victim ? [] : [{ index: 1, itemId: id(9), title: '第1话' }]; },
    });
    const service = createComicService({ api, now: () => now, schedulerOptions: fastScheduler, seed: seedBooks(5000, 60) });
    service.noteSitePage(sitePage(1, [1]));
    const exclude = [id(1)];
    const before = await service.extras({ exclude, limit: 20, waitMs: 0 });
    assert.equal(before.items.length, 20);
    now = Date.parse('2026-03-02T00:20:00');
    const after = await service.extras({ exclude, limit: 20, waitMs: 0 });
    assert.deepEqual(ids(after), ids(before), 'midnight does not reshuffle an open session');

    victim = ids(before)[4];
    await assert.rejects(service.episodes(victim), (error) => error.code === 'EMPTY_DIRECTORY');
    const gone = await service.extras({ exclude, limit: 20, waitMs: 0 });
    assert.equal(gone.items.length, 20, 'the gap is filled');
    assert.deepEqual(ids(gone).slice(0, 19), ids(before).filter((value) => value !== victim), 'the others keep their order');
    assert.ok(!ids(gone).includes(victim));
});

test('seededRank keeps the relative order of the rest when a title is added or removed', () => {
    const items = Array.from({ length: 200 }, (_, i) => String(1000 + i));
    const full = seededRank(items, 'day-1');
    assert.deepEqual(seededRank(items.slice().reverse(), 'day-1'), full);
    const without = seededRank(items.filter((value) => value !== full[7]), 'day-1');
    assert.deepEqual(without, full.filter((value) => value !== full[7]));
    assert.notDeepEqual(seededRank(items, 'day-2'), full);
    assert.deepEqual(seededRank([], 'x'), []);
});
