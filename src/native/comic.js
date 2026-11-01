// SPDX-License-Identifier: GPL-3.0-only
// Picture-comic data layer: catalog snapshot, extra titles, episode directories, chapters and fallback images.
//
// Nothing here is tied to a particular title. The site catalog supplies the first entries in its own order,
// a search sweep (seeded by the site's own tags) fills the rest up to MAX_COMICS, and every network call
// goes through one scheduler so a burst of clicks can never exceed what a single device may do.
const fs = require('node:fs');
const path = require('node:path');
const realApi = require('./comic-api');
const { ApiScheduler, PRIORITY } = require('./comic-scheduler');

const MAX_COMICS = 140;
const MIN_EPISODES = 20;
const POOL_TTL_MS = 24 * 60 * 60 * 1000;
const DIRECTORY_TTL_MS = 30 * 60 * 1000;
const CHAPTER_TTL_MS = 20 * 60 * 1000;
const POOL_RETRY_MS = 30 * 60 * 1000;
// A build that added titles is continued soon; one that added nothing waits POOL_RETRY_MS.
const POOL_CONTINUE_MS = 60 * 1000;
// The first listing waits this long for a first batch of extras, then answers and lets the caller poll.
const FIRST_BATCH_WAIT_MS = 8000;
const POOL_BUILD_BUDGET_MS = 60 * 1000;
const SEARCH_PAGES_PER_KEYWORD = 2;
const IMAGE_CONCURRENCY = 4;
// Used only when the site catalog yields too few tags to search with.
const FALLBACK_KEYWORDS = ['都市', '重生', '穿越', '古风', '玄幻', '逆袭', '恋爱', '悬疑', '系统', '总裁', '萌宝', '搞笑'];
const ID = /^\d{6,30}$/;

function lru(limit) {
    const map = new Map();
    return {
        get(key) {
            const hit = map.get(key);
            if (!hit) return undefined;
            if (hit.expires <= Date.now()) { map.delete(key); return undefined; }
            map.delete(key); map.set(key, hit);
            return hit.value;
        },
        set(key, value, ttl) {
            map.delete(key);
            map.set(key, { value, expires: Date.now() + ttl });
            while (map.size > limit) map.delete(map.keys().next().value);
        },
        delete(key) { map.delete(key); },
        clear() { map.clear(); },
        get size() { return map.size; },
    };
}

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
}

// Same input, same order; a new day gives a new order. The input order never matters.
function seededShuffle(items, seedText, keyOf = (item) => String(item)) {
    const list = items.slice().sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    const random = mulberry32(hashString(seedText));
    for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

function dayKey(at) {
    const date = new Date(at);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function cleanTags(value) {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、]/) : [];
    const seen = new Set();
    const tags = [];
    for (const raw of list) {
        const tag = typeof raw === 'string' ? raw.trim() : '';
        if (!tag || tag.length > 12 || seen.has(tag)) continue;
        seen.add(tag);
        tags.push(tag);
        if (tags.length >= 8) break;
    }
    return tags;
}

// "第12话 标题" -> 12; anything else keeps a short title, or its position.
function episodeLabel(title, index) {
    const numbered = String(title || '').match(/^第\s*(\d{1,5})\s*[话話集章回]/);
    if (numbered) return String(Number(numbered[1]));
    const text = String(title || '').trim();
    return text && text.length <= 4 ? text : String(index);
}

function bookToCard(book, api) {
    const id = String(book?.book_id ?? '');
    const title = typeof book?.book_name === 'string' ? book.book_name.trim() : '';
    if (!ID.test(id) || !title) return null;
    const serial = Number(book.serial_count) || 0;
    const tags = cleanTags(book.tags);
    const score = Number(book.score);
    return {
        series_id: id, series_title: title, cover: api.coverUrl(book.thumb_uri || book.thumb_url), episode_count: serial, tags,
        rating: null, introduction: typeof book.abstract === 'string' ? book.abstract.replace(/\s+/g, ' ').trim().slice(0, 280) : '',
        completion_status: 'unknown', source_kind: 'search', score: Number.isFinite(score) && score > 0 && score <= 10 ? score : null,
    };
}

function eligible(card, exclude) {
    return Boolean(card) && card.episode_count >= MIN_EPISODES && card.tags.length > 0 && Boolean(card.cover) && !exclude.has(card.series_id);
}

function topTags(cards, count) {
    const frequency = new Map();
    for (const card of cards) for (const tag of card.tags || []) frequency.set(tag, (frequency.get(tag) || 0) + 1);
    return [...frequency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, count).map(([tag]) => tag);
}

function createComicService({ api = realApi, now = Date.now, schedulerOptions = {}, imageFetcher } = {}) {
    let cacheFile = '';
    let persistTimer = null;
    const state = { site: { pages: {}, totalPages: 0, savedAt: 0 }, pool: { items: [], builtAt: 0 } };
    const directories = lru(60);
    const chapters = lru(24);
    const directoryPending = new Map();
    let poolBuild = null;
    let lastBuildAt = 0;
    let lastBuildGain = 0;
    let lastPoolError = null;
    let imageActive = 0;
    const imageWaiters = [];

    const scheduler = new ApiScheduler({
        createSession: () => api.createSession(),
        call: (session, task) => {
            if (task.type === 'chapter') return api.fetchChapter(session, task.itemId);
            if (task.type === 'directory') return api.fetchDirectory(session, task.bookId);
            if (task.type === 'search') return api.searchComicPage(session, task.query, task.paging);
            throw new Error('unknown task');
        },
        now, concurrency: 3, ...schedulerOptions,
    });

    function loadCache() {
        if (!cacheFile) return;
        try {
            const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (data?.version !== 1) return;
            const pages = {};
            for (const [key, list] of Object.entries(data.site?.pages || {})) {
                const number = Number(key);
                if (Number.isInteger(number) && number >= 1 && number <= 20 && Array.isArray(list)) pages[number] = list.filter(validCard);
            }
            state.site = { pages, totalPages: Number(data.site?.totalPages) || 0, savedAt: Number(data.site?.savedAt) || 0 };
            if (Array.isArray(data.pool?.items)) state.pool = { items: data.pool.items.filter(validCard), builtAt: Number(data.pool.builtAt) || 0 };
        } catch (_) { /* a missing or damaged cache only costs one network round trip */ }
    }

    function validCard(card) {
        return card && typeof card === 'object' && ID.test(String(card.series_id)) && typeof card.series_title === 'string'
            && typeof card.cover === 'string' && Array.isArray(card.tags);
    }

    function persist() {
        if (!cacheFile || persistTimer) return;
        persistTimer = setTimeout(() => {
            persistTimer = null;
            try {
                fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
                const temporary = `${cacheFile}.${process.pid}.tmp`;
                fs.writeFileSync(temporary, JSON.stringify({ version: 1, site: state.site, pool: state.pool }));
                fs.renameSync(temporary, cacheFile);
            } catch (_) { /* the cache is an optimisation only */ }
        }, 500);
        persistTimer.unref?.();
    }

    function configure({ file } = {}) {
        cacheFile = file || '';
        loadCache();
    }

    function noteSitePage({ page, totalPages, items }) {
        const number = Number(page);
        if (!Number.isInteger(number) || number < 1 || !Array.isArray(items)) return;
        state.site.pages[number] = items.filter(validCard);
        if (Number(totalPages) > 0) {
            state.site.totalPages = Number(totalPages);
            for (const key of Object.keys(state.site.pages)) if (Number(key) > state.site.totalPages) delete state.site.pages[key];
        }
        state.site.savedAt = now();
        persist();
    }

    function siteItems() {
        const out = [];
        const seen = new Set();
        for (const number of Object.keys(state.site.pages).map(Number).sort((a, b) => a - b)) {
            for (const card of state.site.pages[number]) {
                if (seen.has(card.series_id)) continue;
                seen.add(card.series_id);
                out.push(card);
            }
        }
        return out;
    }

    function selectExtras(exclude, limit, at) {
        const blocked = new Set(exclude);
        const pool = state.pool.items.filter((card) => eligible(card, blocked));
        return seededShuffle(pool, `comic-extras:${dayKey(at)}`, (card) => card.series_id).slice(0, Math.max(0, limit));
    }

    // The last complete listing, shown at once while the network refreshes it.
    function snapshot() {
        const pages = Object.keys(state.site.pages).length;
        if (!pages || !state.site.totalPages || pages < state.site.totalPages) return null;
        const site = siteItems();
        const extras = selectExtras(site.map((card) => card.series_id), MAX_COMICS - site.length, now());
        return { items: [...site, ...extras].slice(0, MAX_COMICS), siteCount: site.length, savedAt: state.site.savedAt };
    }

    async function buildPool(site, blocked, needed, onFound = () => {}) {
        const exclude = new Set([...site.map((card) => card.series_id), ...blocked]);
        const found = new Map();
        const keywords = [...topTags(site, 10), ...FALLBACK_KEYWORDS].filter((word, index, all) => all.indexOf(word) === index);
        const order = seededShuffle(keywords, `comic-keywords:${dayKey(now())}`);
        const target = needed + 30;
        const deadline = now() + POOL_BUILD_BUDGET_MS;
        let cursor = 0;
        let failures = 0;
        let lastError = null;
        const sweep = async () => {
            while (cursor < order.length && found.size < target && now() < deadline && failures < 3) {
                const query = order[cursor++];
                let paging = {};
                for (let page = 0; page < SEARCH_PAGES_PER_KEYWORD && found.size < target && now() < deadline; page += 1) {
                    let result;
                    try { result = await scheduler.run(`search:${query}:${paging.offset || 0}`, PRIORITY.background, { type: 'search', query, paging }); }
                    catch (error) { failures += 1; lastError = error; break; }
                    const fresh = [];
                    for (const book of result.books) {
                        const card = bookToCard(book, api);
                        if (card && String(book.genre_type) === '110' && eligible(card, exclude) && !found.has(card.series_id)) { found.set(card.series_id, card); fresh.push(card); }
                    }
                    if (fresh.length) onFound(fresh);
                    if (!result.hasMore) break;
                    paging = { offset: result.nextOffset, searchId: result.searchId };
                }
            }
        };
        await Promise.all([sweep(), sweep(), sweep()]);
        return { items: [...found.values()], failed: failures >= 3, error: lastError };
    }

    // Extra titles never block the listing: a stale pool is served while a new one is built.
    async function extras({ exclude = [], limit = MAX_COMICS, waitMs = FIRST_BATCH_WAIT_MS } = {}) {
        const blocked = (Array.isArray(exclude) ? exclude : []).map(String).filter((id) => ID.test(id)).slice(0, 400);
        const cap = Math.max(0, Math.min(MAX_COMICS, Number.parseInt(limit, 10) || 0));
        if (!cap) return { success: true, items: [], partial: false, refreshing: false, diagnostic: '' };
        const at = now();
        const fresh = state.pool.builtAt && at - state.pool.builtAt < POOL_TTL_MS;
        const enough = selectExtras(blocked, cap, at).length >= cap;
        // A pool that stays short is not rebuilt on every call. One that is still growing is continued,
        // and an empty one is retried sooner than a pool that simply has nothing more to give.
        const cooldown = !state.pool.items.length ? 60 * 1000 : lastBuildGain > 0 ? POOL_CONTINUE_MS : POOL_RETRY_MS;
        if ((!fresh || !enough) && !poolBuild && at - lastBuildAt > cooldown) {
            lastBuildAt = at;
            const before = state.pool.items.length;
            // Titles join the pool as each search page arrives, so a caller that polls sees it grow.
            const merge = (cards) => {
                const merged = new Map(state.pool.items.map((card) => [card.series_id, card]));
                for (const card of cards) merged.set(card.series_id, card);
                state.pool = { items: [...merged.values()].slice(0, 400), builtAt: now() };
                persist();
            };
            poolBuild = buildPool(siteItems(), blocked, cap, merge).then((built) => {
                lastPoolError = built.items.length ? null : built.error;
                lastBuildGain = state.pool.items.length - before;
            }).catch((error) => { lastPoolError = error; lastBuildGain = 0; }).finally(() => { lastBuildAt = now(); poolBuild = null; });
        }
        // Nothing to show yet: wait a little for a first batch, then answer and let the caller ask again.
        if (poolBuild && !state.pool.items.length) {
            const running = poolBuild;
            let timer;
            await Promise.race([running, new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Number(waitMs) || 0)); })]);
            clearTimeout(timer);
        }
        const items = selectExtras(blocked, cap, now());
        const refreshing = Boolean(poolBuild);
        return { success: true, items, partial: items.length < cap, refreshing, diagnostic: items.length < cap && !refreshing ? String(lastPoolError?.message || '') : '' };
    }

    async function episodes(seriesId, { priority = PRIORITY.click } = {}) {
        const id = String(seriesId || '');
        if (!ID.test(id)) throw Object.assign(new Error('漫画编号无效'), { code: 'APP_INPUT' });
        const cached = directories.get(id);
        if (cached) return cached;
        if (directoryPending.has(id)) return directoryPending.get(id);
        const task = (async () => {
            const list = await scheduler.run(`directory:${id}`, priority, { type: 'directory', bookId: id });
            if (!list.length) throw Object.assign(new Error('这部漫画暂时没有分集'), { code: 'EMPTY_DIRECTORY' });
            const value = { seriesId: id, total: list.length, episodes: list.map((entry) => ({ ...entry, label: episodeLabel(entry.title, entry.index) })) };
            directories.set(id, value, DIRECTORY_TTL_MS);
            return value;
        })().finally(() => directoryPending.delete(id));
        directoryPending.set(id, task);
        return task;
    }

    async function loadChapter(itemId, priority, refresh) {
        if (!ID.test(String(itemId))) throw Object.assign(new Error('分集编号无效'), { code: 'APP_INPUT' });
        if (refresh) chapters.delete(itemId);
        const cached = chapters.get(itemId);
        if (cached) return cached;
        const chapter = await scheduler.run(`chapter:${itemId}`, priority, { type: 'chapter', itemId });
        chapters.set(itemId, chapter, CHAPTER_TTL_MS);
        return chapter;
    }

    async function chapter({ itemId, width = 720, priority = 'click' } = {}) {
        const rank = priority === 'prefetch' ? PRIORITY.prefetch : priority === 'background' ? PRIORITY.background : PRIORITY.click;
        const value = await loadChapter(String(itemId), rank, false);
        return {
            itemId: String(itemId), title: value.title, pictureCount: value.pictures.length,
            pictures: value.pictures.map((item) => ({ index: item.index, width: item.width, height: item.height, url: api.pictureUrl(item.md5, width) })),
        };
    }

    function withImageSlot(task) {
        return new Promise((resolve, reject) => {
            const start = () => {
                imageActive += 1;
                Promise.resolve().then(task).then(resolve, reject).finally(() => {
                    imageActive -= 1;
                    const next = imageWaiters.shift();
                    if (next) next();
                });
            };
            if (imageActive < IMAGE_CONCURRENCY) start(); else imageWaiters.push(start);
        });
    }

    // The public CDN answers 404 for some pictures. The signed copy is encrypted; decrypt it here.
    async function image({ itemId, index }) {
        const position = Number(index);
        if (!Number.isInteger(position) || position < 0 || position > 2000) throw Object.assign(new Error('图片序号无效'), { code: 'APP_INPUT' });
        const attempt = async (refresh) => {
            const value = await loadChapter(String(itemId), PRIORITY.click, refresh);
            const picture = value.pictures[position];
            if (!picture?.signedUrl) throw Object.assign(new Error('这张图片暂时无法取得'), { code: 'MISSING_PICTURE' });
            const raw = await withImageSlot(() => api.downloadImage(picture.signedUrl, { fetcher: imageFetcher }));
            return value.encrypted ? api.decryptImage(raw, value.encryptKey) : raw;
        };
        let data;
        try { data = await attempt(false); }
        // A signed link expires; one fresh chapter call gets new ones.
        catch (error) { if (error?.status === 403 || error?.code === 'INVALID_RESPONSE') data = await attempt(true); else throw error; }
        const mime = data[0] === 0x89 ? 'image/png' : data[0] === 0x52 ? 'image/webp' : 'image/jpeg';
        return { mime, data };
    }

    function stats() {
        return { ...scheduler.snapshot(), directories: directories.size, chapters: chapters.size, pool: state.pool.items.length };
    }

    // Leaving a chapter withdraws the look-ahead for it; the catalog sweep keeps running.
    function cancelPrefetch() {
        return scheduler.cancel((key, job) => job.priority === PRIORITY.prefetch);
    }

    return { configure, noteSitePage, snapshot, extras, episodes, chapter, image, stats, cancelPrefetch, scheduler,
        _state: state };
}

let shared;
function service() {
    if (!shared) shared = createComicService();
    return shared;
}

module.exports = {
    createComicService, service, seededShuffle, episodeLabel, bookToCard, topTags, dayKey, MAX_COMICS, MIN_EPISODES,
};
