





const fs = require('node:fs');
const path = require('node:path');
const realApi = require('./comic-api');
const { ApiScheduler, PRIORITY } = require('./comic-scheduler');

const MAX_COMICS = 300;
const MIN_EPISODES = 20;
const POOL_TTL_MS = 24 * 60 * 60 * 1000;
const DIRECTORY_TTL_MS = 30 * 60 * 1000;
const CHAPTER_TTL_MS = 20 * 60 * 1000;
const DEAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const POOL_RETRY_MS = 30 * 60 * 1000;

const POOL_CONTINUE_MS = 60 * 1000;

const FIRST_BATCH_WAIT_MS = 8000;
const POOL_BUILD_BUDGET_MS = 90 * 1000;
const POOL_LIMIT = 700;
const SERVED_LIMIT = 600;
const SEARCH_PAGES_PER_KEYWORD = 2;
const IMAGE_CONCURRENCY = 6;
const CATEGORY_PAGES = 5;
const MAX_CATEGORIES = 12;
const DETAIL_SAMPLE = 20;
const DIRECTORY_SAMPLE = 4;

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


function seededShuffle(items, seedText, keyOf = (item) => String(item)) {
    const list = items.slice().sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    const random = mulberry32(hashString(seedText));
    for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}


function seededRank(items, seedText, keyOf = (item) => String(item)) {
    return items.map((item) => ({ item, key: keyOf(item), rank: hashString(`${seedText}:${keyOf(item)}`) }))
        .sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key)).map((entry) => entry.item);
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

    const tags = [book.tags, book.pure_category_tags, book.category].map(cleanTags).find((list) => list.length) || [];
    const score = Number(book.score);
    return {
        series_id: id, series_title: title, cover: [book.thumb_uri, book.thumb_url, book.detail_page_thumb_url].map((value) => api.coverUrl(value)).find(Boolean) || '', episode_count: serial, tags,
        rating: null, introduction: typeof book.abstract === 'string' ? book.abstract.replace(/\s+/g, ' ').trim().slice(0, 280) : '',
        completion_status: 'unknown', source_kind: 'search', score: Number.isFinite(score) && score > 0 && score <= 10 ? score : null,
    };
}


function rejection(card, exclude) {
    if (!card) return 'invalid';
    if (exclude.has(card.series_id)) return 'known';
    if (card.episode_count < MIN_EPISODES) return 'short';
    if (!card.tags.length) return 'tags';
    if (!card.cover) return 'cover';
    return '';
}

function eligible(card, exclude) {
    return rejection(card, exclude) === '';
}

function topTags(cards, count) {
    const frequency = new Map();
    for (const card of cards) for (const tag of card.tags || []) frequency.set(tag, (frequency.get(tag) || 0) + 1);
    return [...frequency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, count).map(([tag]) => tag);
}

function createComicService({ api = realApi, now = Date.now, schedulerOptions = {}, imageFetcher, seed = [] } = {}) {
    let cacheFile = '';
    let persistTimer = null;


    const state = { site: { pages: {}, totalPages: 0, savedAt: 0 }, pool: { items: [], builtAt: 0 }, served: { day: '', ids: [] } };

    let sessionDay = '';

    const dead = new Set();
    const deadAt = new Map();

    const seedCards = (Array.isArray(seed) ? seed : []).filter((card) => validCard(card) && eligible(card, new Set()))
        .map((card) => ({ ...card, source_kind: 'seed' }));
    const directories = lru(60);
    const chapters = lru(24);
    const directoryPending = new Map();
    let poolBuild = null;
    let lastBuildAt = 0;
    let lastBuildGain = 0;
    let lastPoolError = null;
    let lastPoolNote = '';
    let imageActive = 0;
    const imageWaiters = [];



    const routes = Array.isArray(api.ROUTES) && api.ROUTES.length ? api.ROUTES : [undefined];
    let routeIndex = 0;
    let savedRoute = routes[0]?.id;

    function noteRouteWorked(session) {
        const index = routes.indexOf(session?.route);
        if (index < 0) return;
        routeIndex = index;
        if (routes[index]?.id !== savedRoute) { savedRoute = routes[index]?.id; persist(); }
    }

    function dispatch(session, task) {
        if (task.type === 'chapter') return api.fetchChapter(session, task.itemId);
        if (task.type === 'directory') return api.fetchDirectory(session, task.bookId);
        if (task.type === 'search') return api.searchComicPage(session, task.query, task.paging);
        if (task.type === 'category') return api.fetchCategoryPage(session, task.categoryId, task.offset);
        if (task.type === 'details') return api.fetchBookDetails(session, task.ids);
        if (task.type === 'bookinfo') return api.fetchBookInfo(session, task.id);
        throw new Error('unknown task');
    }

    const scheduler = new ApiScheduler({
        createSession: ({ reason } = {}) => {
            if (reason === 'rejected' || reason === 'empty') routeIndex = (routeIndex + 1) % routes.length;
            return api.createSession(routes[routeIndex] ? { route: routes[routeIndex] } : undefined);
        },
        call: async (session, task) => {
            const result = await dispatch(session, task);
            noteRouteWorked(session);
            return result;
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
            const saved = routes.findIndex((route) => route && route.id === data.route);
            if (saved >= 0) { routeIndex = saved; savedRoute = routes[saved].id; }
            for (const [id, at] of Array.isArray(data.dead) ? data.dead : []) {
                if (ID.test(String(id)) && now() - Number(at) < DEAD_TTL_MS) { dead.add(String(id)); deadAt.set(String(id), Number(at)); }
            }
            if (Array.isArray(data.pool?.items)) state.pool = { items: data.pool.items.filter(validCard), builtAt: Number(data.pool.builtAt) || 0 };
            if (typeof data.served?.day === 'string' && Array.isArray(data.served.ids)) {
                state.served = { day: data.served.day, ids: data.served.ids.map(String).filter((id) => ID.test(id)).slice(0, SERVED_LIMIT) };
            }
        } catch (_) {                                                                    }
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
                fs.writeFileSync(temporary, JSON.stringify({ version: 1, site: state.site, pool: state.pool, served: state.served, route: routes[routeIndex]?.id, dead: [...deadAt.entries()].slice(-200) }));
                fs.renameSync(temporary, cacheFile);
            } catch (_) {                                         }
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





    function selectExtras(exclude, limit, at, { record = true } = {}) {
        const want = Math.max(0, limit);
        const day = sessionDay || (sessionDay = dayKey(at));
        if (state.served.day !== day) state.served = { day, ids: [] };
        const blocked = new Set([...exclude, ...dead]);
        const known = new Map();
        for (const card of seedCards) known.set(card.series_id, card);
        for (const card of state.pool.items) known.set(card.series_id, card);

        const kept = [];
        const keptIds = new Set();
        const stillServed = [];
        for (const id of state.served.ids) {
            const card = known.get(id);
            if (!card || dead.has(id) || !eligible(card, new Set())) continue;
            stillServed.push(id);
            if (kept.length < want && !blocked.has(id) && !keptIds.has(id)) { kept.push(card); keptIds.add(id); }
        }
        const added = [];
        const take = (cards) => {
            for (const card of cards) {
                if (kept.length >= want) break;
                kept.push(card);
                keptIds.add(card.series_id);
                added.push(card.series_id);
            }
        };
        const open = () => new Set([...blocked, ...keptIds]);
        take(seededRank(state.pool.items.filter((card) => eligible(card, open())), `comic-extras:${day}`, (card) => card.series_id));
        if (kept.length < want && seedCards.length) {
            take(seededRank(seedCards.filter((card) => eligible(card, open())), `comic-seed:${day}`, (card) => card.series_id));
        }
        const ids = [...stillServed, ...added].slice(0, SERVED_LIMIT);
        const changed = ids.length !== state.served.ids.length || ids.some((id, index) => id !== state.served.ids[index]);
        if (record) {
            state.served = { day, ids };
            if (changed) persist();
        }
        return kept;
    }

    function selectLive(exclude, limit, at) {
        const blocked = new Set([...exclude, ...dead]);
        const pool = state.pool.items.filter((card) => eligible(card, blocked));
        return pool.slice(0, Math.max(0, limit));
    }


    function snapshot() {
        const pages = Object.keys(state.site.pages).length;
        if (!pages || !state.site.totalPages || pages < state.site.totalPages) return null;
        const site = siteItems();
        const extras = selectExtras(site.map((card) => card.series_id), MAX_COMICS - site.length, now());
        return { items: [...site, ...extras].slice(0, MAX_COMICS), siteCount: site.length, savedAt: state.site.savedAt };
    }



    async function buildPool(site, blocked, needed, onFound = () => {}, { budgetMs = POOL_BUILD_BUDGET_MS, headroom = 30 } = {}) {
        const exclude = new Set([...site.map((card) => card.series_id), ...blocked]);
        const found = new Map();
        const target = needed + headroom;
        const deadline = now() + budgetMs;
        const stats = { categoryPages: 0, searchPages: 0, seen: 0, categories: 0 };
        let failures = 0;
        let lastError = null;
        const open = () => found.size < target && now() < deadline && failures < 3;
        const run = async (key, task) => {
            try { return await scheduler.run(key, PRIORITY.background, task); } catch (error) { failures += 1; lastError = error; return null; }
        };
        const rejected = { invalid: 0, offGenre: 0, known: 0, short: 0, tags: 0, cover: 0 };
        const take = (books) => {
            const fresh = [];
            for (const book of Array.isArray(books) ? books : []) {
                stats.seen += 1;
                const card = bookToCard(book, api);

                const genre = book?.genre_type === undefined || book?.genre_type === null || book?.genre_type === '' ? api.COMIC_GENRE : String(book.genre_type);
                const reason = genre !== api.COMIC_GENRE ? 'offGenre' : rejection(card, exclude) || (found.has(card.series_id) ? 'known' : '');
                if (reason) { rejected[reason] += 1; continue; }
                found.set(card.series_id, card);
                fresh.push(card);
            }
            if (fresh.length) { onFound(fresh); learn(fresh); }
        };

        const order = [];
        const queued = new Set();
        const learn = (cards) => {
            for (const tag of topTags(cards, 6)) if (!queued.has(tag)) { queued.add(tag); order.push(tag); }
        };

        const categories = await discoverCategories(site, run);
        stats.categories = categories.length;
        let nextCategory = 0;
        const categoryWorker = async () => {
            while (nextCategory < categories.length && open()) {
                const id = categories[nextCategory++];
                let offset = 0;
                for (let page = 0; page < CATEGORY_PAGES && open(); page += 1) {
                    const result = await run(`category:${id}:${offset}`, { type: 'category', categoryId: id, offset });
                    if (!result) break;
                    stats.categoryPages += 1;
                    take(result.books);
                    if (!result.hasMore || !(result.nextOffset > offset)) break;
                    offset = result.nextOffset;
                }
            }
        };
        await Promise.all([categoryWorker(), categoryWorker(), categoryWorker()]);

        if (open()) {
            const keywords = [...topTags(site, 10), ...FALLBACK_KEYWORDS].filter((word, index, all) => all.indexOf(word) === index);
            for (const word of seededShuffle(keywords, `comic-keywords:${dayKey(now())}`)) if (!queued.has(word)) { queued.add(word); order.push(word); }
            let cursor = 0;
            const sweep = async () => {
                while (cursor < order.length && open()) {
                    const query = order[cursor++];
                    let paging = {};
                    for (let page = 0; page < SEARCH_PAGES_PER_KEYWORD && open(); page += 1) {
                        const result = await run(`search:${query}:${paging.offset || 0}`, { type: 'search', query, paging });
                        if (!result) break;
                        stats.searchPages += 1;
                        take(result.books);
                        if (!result.hasMore) break;
                        paging = { offset: result.nextOffset, searchId: result.searchId };
                    }
                }
            };
            await Promise.all([sweep(), sweep(), sweep()]);
        }
        const why = Object.entries(rejected).filter(([, count]) => count > 0).map(([reason, count]) => `${reason} ${count}`).join('，');
        const note = found.size || lastError ? '' : `分类 ${stats.categories} 个/${stats.categoryPages} 页，搜索 ${stats.searchPages} 页，收到 ${stats.seen} 部${why ? `（${why}）` : ''}，没有可用漫画`;
        return { items: [...found.values()], failed: failures >= 3, error: lastError, note };
    }



    async function discoverCategories(site, run) {
        const known = site.map((card) => card.series_id);
        if (!known.length) return [];
        const step = Math.max(1, Math.floor(known.length / DETAIL_SAMPLE));
        const sample = known.filter((_, index) => index % step === 0).slice(0, DETAIL_SAMPLE);
        const frequency = new Map();
        const count = (book) => {
            if (!book || (book.genre_type !== undefined && book.genre_type !== '' && String(book.genre_type) !== api.COMIC_GENRE)) return;
            for (const category of api.categoriesOf(book)) frequency.set(category.id, (frequency.get(category.id) || 0) + 1);
        };
        const books = await run(`details:${sample[0]}:${sample.length}`, { type: 'details', ids: sample });
        for (const book of Array.isArray(books) ? books : []) count(book);
        if (!frequency.size && typeof api.fetchBookInfo === 'function') {
            const spread = Math.max(1, Math.floor(sample.length / DIRECTORY_SAMPLE));
            const picks = sample.filter((_, index) => index % spread === 0).slice(0, DIRECTORY_SAMPLE);
            const records = await Promise.all(picks.map((id) => run(`bookinfo:${id}`, { type: 'bookinfo', id })));
            for (const book of records) count(book);
        }
        return [...frequency.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_CATEGORIES).map(([id]) => id);
    }


    async function extras({ exclude = [], limit = MAX_COMICS, waitMs = FIRST_BATCH_WAIT_MS } = {}) {
        const blocked = (Array.isArray(exclude) ? exclude : []).map(String).filter((id) => ID.test(id)).slice(0, POOL_LIMIT);
        const cap = Math.max(0, Math.min(MAX_COMICS, Number.parseInt(limit, 10) || 0));
        if (!cap) return { success: true, items: [], partial: false, refreshing: false, diagnostic: '' };
        const at = now();
        const fresh = state.pool.builtAt && at - state.pool.builtAt < POOL_TTL_MS;
        const enough = selectLive(blocked, cap, at).length >= cap;


        const cooldown = !state.pool.items.length ? 60 * 1000 : lastBuildGain > 0 ? POOL_CONTINUE_MS : POOL_RETRY_MS;
        if ((!fresh || !enough) && !poolBuild && at - lastBuildAt > cooldown) {
            lastBuildAt = at;
            const before = state.pool.items.length;

            const merge = (cards) => {
                const merged = new Map(state.pool.items.map((card) => [card.series_id, card]));
                for (const card of cards) merged.set(card.series_id, card);
                state.pool = { items: [...merged.values()].slice(0, POOL_LIMIT), builtAt: now() };
                persist();
            };
            poolBuild = buildPool(siteItems(), blocked, cap, merge).then((built) => {
                lastPoolError = built.items.length ? null : built.error;
                lastPoolNote = built.items.length ? '' : String(built.note || '');
                lastBuildGain = state.pool.items.length - before;
            }).catch((error) => { lastPoolError = error; lastBuildGain = 0; }).finally(() => { lastBuildAt = now(); poolBuild = null; });
        }

        if (poolBuild && selectExtras(blocked, cap, now(), { record: false }).length < cap) {
            const running = poolBuild;
            let timer;
            await Promise.race([running, new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Number(waitMs) || 0)); })]);
            clearTimeout(timer);
        }
        const items = selectExtras(blocked, cap, now());
        const refreshing = Boolean(poolBuild);
        return { success: true, items, partial: items.length < cap, refreshing, diagnostic: items.length < cap && !refreshing ? String(lastPoolError?.message || lastPoolNote || '') : '' };
    }

    async function episodes(seriesId, { priority = PRIORITY.click } = {}) {
        const id = String(seriesId || '');
        if (!ID.test(id)) throw Object.assign(new Error('漫画编号无效'), { code: 'APP_INPUT' });
        const cached = directories.get(id);
        if (cached) return cached;
        if (directoryPending.has(id)) return directoryPending.get(id);
        const task = (async () => {
            const list = await scheduler.run(`directory:${id}`, priority, { type: 'directory', bookId: id });
            if (!list.length) {
                if (!dead.has(id)) { dead.add(id); deadAt.set(id, now()); persist(); }
                throw Object.assign(new Error('这部漫画暂时没有分集'), { code: 'EMPTY_DIRECTORY' });
            }
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

        catch (error) { if (error?.status === 403 || error?.code === 'INVALID_RESPONSE') data = await attempt(true); else throw error; }
        const mime = data[0] === 0x89 ? 'image/png' : data[0] === 0x52 ? 'image/webp' : 'image/jpeg';
        return { mime, data };
    }

    function stats() {
        return { ...scheduler.snapshot(), directories: directories.size, chapters: chapters.size, pool: state.pool.items.length };
    }


    function cancelPrefetch() {
        return scheduler.cancel((key, job) => job.priority === PRIORITY.prefetch);
    }


    function collect({ needed = MAX_COMICS, budgetMs = 5 * 60 * 1000 } = {}) {
        return buildPool([], [], needed, () => {}, { budgetMs, headroom: 0 });
    }

    return { configure, noteSitePage, snapshot, extras, collect, episodes, chapter, image, stats, cancelPrefetch, scheduler,
        _state: state };
}

function loadSeed() {
    try {
        const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'comic-seed.json'), 'utf8'));
        return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
}

let shared;
function service() {
    if (!shared) shared = createComicService({ seed: loadSeed() });
    return shared;
}



function withNetworkHint(error, proxyEnabled) {
    const message = String(error?.message || '');
    if (error?.code !== 'BUSINESS_REJECTED' || message.includes('代理')) return message;
    return `${message}。可能是目前的網路位置無法使用漫畫服務，${proxyEnabled ? '請在設定中改用其他地區的代理後重試' : '請在設定中啟用其他地區的代理後重試'}。`;
}

module.exports = { withNetworkHint,
    createComicService, service, loadSeed, seededShuffle, episodeLabel, bookToCard, topTags, dayKey, MAX_COMICS, MIN_EPISODES, IMAGE_CONCURRENCY, seededRank,
};
