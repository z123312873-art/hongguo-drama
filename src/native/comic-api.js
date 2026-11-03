// SPDX-License-Identifier: GPL-3.0-only
// Reading-API client for picture comics: anonymous device, chapter content, directory, search, and the
// decryption of the few images the public CDN does not serve in plain form.
// Everything here is stateless; sessions and scheduling live in comic.js and comic-scheduler.js.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { signedMetadataRequest, requestJson } = require('./app-source');
const { registerDevice, READER_PROFILE } = require('./playback-device');
const { comicCover } = require('./cover-url');

// Public constant of the content-key exchange (the app ships the same bytes). Not a user credential.
const KEY_EXCHANGE = Buffer.from('ac25c67ddd8f38c1b37a2348828e222e', 'hex');
const READER_VERSION = '74332';
const CALL_TIMEOUT_MS = 12000;
const MAX_CHAPTER_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_HOSTS = ['byteimg.com', 'fqnovelpic.com'];
const ID = /^\d{6,30}$/;
const MD5 = /^[0-9a-f]{32}$/i;
// Widths the image CDN is asked for. A small set keeps its cache effective; any value in between would work.
const IMAGE_WIDTHS = Object.freeze([360, 540, 720, 900, 1080, 1440]);

function le64(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
}

function exchangePayload(deviceId) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-128-cbc', KEY_EXCHANGE, iv);
    return Buffer.concat([iv, cipher.update(Buffer.concat([le64(deviceId), le64(0)])), cipher.final()]).toString('base64');
}

function exchangeKey(encoded) {
    const raw = Buffer.from(String(encoded || ''), 'base64');
    if (raw.length < 32) throw Object.assign(new Error('漫画服务返回的密钥无效'), { code: 'INVALID_RESPONSE' });
    const decipher = crypto.createDecipheriv('aes-128-cbc', KEY_EXCHANGE, raw.subarray(0, 16));
    return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]);
}

// Ways to reach the reading service. The first is used until the service refuses a request; each later one
// changes what the service can see (edge host, registration host, the region the device claims, a forwarded
// client address) and is tried one at a time. Nothing here depends on a title.
const ROUTES = Object.freeze([
    { id: 'default', host: 'api5-normal-sinfonlineb.fqnovel.com' },
    { id: 'domestic-lf', host: 'api5-normal-lf.fqnovel.com', region: 'cn-zj', registerHosts: ['log.snssdk.com'] },
    { id: 'domestic-hl', host: 'api5-normal-hl.fqnovel.com', region: 'cn-sc', registerHosts: ['log3-applog.fqnovel.com'] },
    { id: 'edge-a-forwarded', host: 'api5-normal-sinfonlinea.fqnovel.com', region: 'cn-zj', forwarded: true },
    { id: 'api3-forwarded', host: 'api3-normal-sinfonlinea.fqnovel.com', region: 'cn-yn', forwarded: true, registerHosts: ['log.snssdk.com'] },
].map((route) => Object.freeze(route)));

// A public address in a mainland carrier block, different on every device. Only sent by the routes marked `forwarded`.
const FORWARD_PREFIXES = Object.freeze([[36, 100], [58, 60], [111, 30], [114, 80], [117, 130], [120, 36], [123, 112], [183, 14], [221, 130], [223, 104]]);
function forwardedAddress() {
    const [first, second] = FORWARD_PREFIXES[crypto.randomInt(FORWARD_PREFIXES.length)];
    return `${first}.${second + crypto.randomInt(8)}.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;
}

function routeHeaders(route, identity) {
    if (!route?.region && !route?.forwarded) return {};
    const headers = {};
    if (route.region) {
        headers['x-tt-store-region'] = route.region;
        headers['x-tt-store-region-src'] = 'did';
        headers.Cookie = `store-region=${route.region}; store-region-src=did; install_id=${identity.iid}`;
    }
    if (route.forwarded) {
        const address = identity.forwardedFor || (identity.forwardedFor = forwardedAddress());
        headers['X-Forwarded-For'] = address;
        headers['X-Real-IP'] = address;
    }
    return headers;
}

async function call(session, apiPath, values, payload, method = 'GET', stage = '') {
    const route = session.route || ROUTES[0];
    const signed = signedMetadataRequest(apiPath, values, payload, { profile: 'reader', identity: session.identity, host: route.host });
    const timeout = CALL_TIMEOUT_MS;
    const response = await (session.transport || requestJson)(signed.url, { method, headers: { ...signed.headers, ...routeHeaders(route, session.identity) }, data: signed.body || undefined },
        Date.now() + timeout, AbortSignal.timeout(timeout));
    const code = Number(response?.code ?? response?.Code ?? 0);
    if (code !== 0) {
        throw Object.assign(new Error(`漫画服务暂时无法提供该内容（${stage ? `${stage}，` : ''}代码 ${code}）`), { code: 'BUSINESS_REJECTED', apiCode: code, stage });
    }
    return response;
}

// One registered anonymous device. The content key is only needed to read a chapter, so it is fetched on
// first use: the directory and the search work with the device alone and must not depend on the key step.
async function createSession({ register = registerDevice, transport = requestJson, route = ROUTES[0] } = {}) {
    const identity = await register(transport, READER_PROFILE, route.registerHosts ? { hosts: route.registerHosts } : undefined);
    return { identity: { ...identity }, route, key: null, keyver: 0, keyPending: null, createdAt: Date.now(), transport };
}

async function ensureKey(session) {
    if (session.key) return session.key;
    if (!session.keyPending) {
        session.keyPending = (async () => {
            const response = await call(session, '/reading/crypt/registerkey', {}, { content: exchangePayload(session.identity.device_id), keyver: 1 }, 'POST', '密钥交换');
            session.key = exchangeKey(response.data?.key);
            session.keyver = Number(response.data?.keyver) || 0;
            return session.key;
        })().finally(() => { session.keyPending = null; });
    }
    return session.keyPending;
}

function decodeChapter(response, key) {
    const data = response?.data;
    if (typeof data?.content !== 'string' || !data.content) throw Object.assign(new Error('漫画服务返回了空章节'), { code: 'INVALID_RESPONSE' });
    const raw = Buffer.from(data.content, 'base64');
    if (raw.length < 32) throw Object.assign(new Error('漫画章节数据不完整'), { code: 'INVALID_RESPONSE' });
    let text;
    try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, raw.subarray(0, 16));
        text = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]);
        if (data.compress_status === 1) text = zlib.gunzipSync(text, { maxOutputLength: MAX_CHAPTER_BYTES });
    } catch (_) { throw Object.assign(new Error('漫画章节解密失败'), { code: 'INVALID_RESPONSE' }); }
    let parsed;
    try { parsed = JSON.parse(text.toString('utf8')); } catch (_) { throw Object.assign(new Error('漫画章节格式无效'), { code: 'INVALID_RESPONSE' }); }
    return parseChapter(parsed, data.title);
}

function positiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number < 100000 ? Math.round(number) : 0;
}

function trustedImageUrl(value) {
    let url;
    try { url = new URL(String(value)); } catch (_) { return ''; }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return '';
    return IMAGE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : '';
}

function parseChapter(json, title = '') {
    const list = Array.isArray(json?.picInfos) ? json.picInfos : [];
    const encryptKey = typeof json?.encrypt_key === 'string' && /^(?:[0-9a-f]{2}){32}$/i.test(json.encrypt_key) ? json.encrypt_key.toLowerCase() : '';
    const pictures = [];
    for (const item of list) {
        const md5 = typeof item?.md5 === 'string' && MD5.test(item.md5) ? item.md5.toLowerCase() : '';
        if (!md5) continue;
        pictures.push({
            index: pictures.length, md5, width: positiveInteger(item.width), height: positiveInteger(item.height),
            signedUrl: trustedImageUrl(item.picUrl),
        });
    }
    if (!pictures.length) throw Object.assign(new Error('这一集暂时没有可读的图片'), { code: 'EMPTY_CHAPTER' });
    return { title: typeof title === 'string' ? title.slice(0, 120) : '', encrypted: json?.encrypt !== false && Boolean(encryptKey), encryptKey, pictures };
}

async function fetchChapter(session, itemId) {
    if (!ID.test(String(itemId))) throw Object.assign(new Error('分集编号无效'), { code: 'APP_INPUT' });
    const key = await ensureKey(session);
    const response = await call(session, '/reading/reader/full/v/', { item_id: String(itemId), key_register_ts: '0' }, undefined, 'GET', '章节');
    return decodeChapter(response, key);
}

async function fetchDirectory(session, bookId) {
    if (!ID.test(String(bookId))) throw Object.assign(new Error('漫画编号无效'), { code: 'APP_INPUT' });
    const response = await call(session, '/reading/bookapi/directory/all_items/v/', {
        book_id: String(bookId), book_type: '0', version_code: READER_VERSION, update_version_code: READER_VERSION,
        need_version: 'true', item_data_list_md5: '', book_info_md5: '',
    }, undefined, 'GET', '分集目录');
    const rows = Array.isArray(response.data?.item_data_list) ? response.data.item_data_list : [];
    const seen = new Set();
    const episodes = [];
    for (const row of rows) {
        const id = String(row?.item_id ?? '');
        if (!ID.test(id) || seen.has(id)) continue;
        seen.add(id);
        episodes.push({ index: episodes.length + 1, itemId: id, title: typeof row.title === 'string' ? row.title.trim().slice(0, 80) : '' });
    }
    return episodes;
}
// A search needs the id of a general search first; the comic tab then pages with it.
async function searchComicPage(session, query, { offset = 0, searchId = '', passback = '' } = {}) {
    const base = { query: String(query).slice(0, 40), count: '20', bookshelf_search_plan: '4', use_correct: 'true', user_is_login: '0' };
    let id = searchId;
    if (!id) {
        const first = await call(session, '/reading/bookapi/search/tab/v', { ...base, tab_type: '1', offset: '0' }, undefined, 'GET', '搜索');
        const tab = (first.search_tabs || []).find((item) => Number(item?.tab_type) === 8);
        if (!tab?.search_id) return { books: [], hasMore: false, nextOffset: 0, searchId: '' };
        id = tab.search_id;
        passback = tab.passback || '';
    }
    const response = await call(session, '/reading/bookapi/search/tab/v', {
        ...base, tab_type: '8', offset: String(offset), search_id: id, ...(passback ? { passback } : {}),
    }, undefined, 'GET', '搜索');
    const tab = (response.search_tabs || []).find((item) => Number(item?.tab_type) === 8);
    const books = [];
    for (const cell of tab?.data || []) {
        const book = (cell?.book_data || [])[0];
        if (book) books.push(book);
    }
    return { books, hasMore: Boolean(tab?.has_more), nextOffset: Number(tab?.next_offset) || 0, searchId: tab?.search_id || id };
}

// Comics carry this genre type everywhere in the reading service (search, category pages, details).
const COMIC_GENRE = '110';
const DETAIL_BATCH = 20;

function categoriesOf(book) {
    let rows;
    try { rows = JSON.parse(typeof book?.category_schema === 'string' ? book.category_schema : '[]'); } catch (_) { return []; }
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = Number(row?.category_id);
        if (Number.isSafeInteger(id) && id > 0 && !out.some((entry) => entry.id === id)) out.push({ id, name: typeof row?.name === 'string' ? row.name.slice(0, 20) : '' });
    }
    return out;
}

// The directory call of any title also carries the title's own record. It answers wherever the directory does,
// so it can stand in for the details call when that one comes back empty.
async function fetchBookInfo(session, bookId) {
    if (!ID.test(String(bookId))) throw Object.assign(new Error('漫画编号无效'), { code: 'APP_INPUT' });
    const response = await call(session, '/reading/bookapi/directory/all_items/v/', {
        book_id: String(bookId), book_type: '0', version_code: READER_VERSION, update_version_code: READER_VERSION,
        need_version: 'true', item_data_list_md5: '', book_info_md5: '',
    }, undefined, 'GET', '分集目录');
    const info = response.data?.book_info;
    return info && typeof info === 'object' ? info : null;
}

// Details of known titles. Their categories are how the category pages (below) are found.
async function fetchBookDetails(session, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => ID.test(id)))].slice(0, DETAIL_BATCH);
    if (!list.length) return [];
    const response = await call(session, '/reading/bookapi/multi-detail/v/', { book_id: list.join(',') }, undefined, 'GET', '详情');
    return Array.isArray(response.data) ? response.data.filter((book) => book && typeof book === 'object') : [];
}

// One page of a comic category: ten titles and where the next page starts.
async function fetchCategoryPage(session, categoryId, offset = 0) {
    if (!Number.isSafeInteger(Number(categoryId)) || Number(categoryId) <= 0) throw Object.assign(new Error('分类编号无效'), { code: 'APP_INPUT' });
    const response = await call(session, '/reading/bookapi/new_category/landing/v', {
        category_id: String(categoryId), genre_type: COMIC_GENRE, gender: '2', offset: String(Math.max(0, Number(offset) || 0)),
    }, undefined, 'GET', '分类');
    const data = response.data || {};
    const books = Array.isArray(data.book_info) ? data.book_info.filter((book) => book && typeof book === 'object') : [];
    return { books, hasMore: data.has_more === true && books.length > 0, nextOffset: Number(data.offset) || 0 };
}

function pictureUrl(md5, width) {
    if (!MD5.test(String(md5))) throw new Error('图片编号无效');
    const wanted = Math.max(1, Math.floor(Number(width) || 0));
    const pick = IMAGE_WIDTHS.find((candidate) => candidate >= wanted) || IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1];
    return `https://p3-novel.byteimg.com/novel-pic/${String(md5).toLowerCase()}~tplv-resize:${pick}:0.webp`;
}

const coverUrl = comicCover;

function decryptImage(buffer, encryptKeyHex) {
    if (!Buffer.isBuffer(buffer) || buffer.length <= 28) throw Object.assign(new Error('图片数据不完整'), { code: 'INVALID_RESPONSE' });
    const key = Buffer.from(String(encryptKeyHex), 'hex');
    if (key.length !== 32) throw Object.assign(new Error('图片密钥无效'), { code: 'INVALID_RESPONSE' });
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
        decipher.setAuthTag(buffer.subarray(buffer.length - 16));
        return Buffer.concat([decipher.update(buffer.subarray(12, buffer.length - 16)), decipher.final()]);
    } catch (_) { throw Object.assign(new Error('图片解密失败'), { code: 'INVALID_RESPONSE' }); }
}

// Signed picture URLs live on a few CDN hosts only; the caller never supplies the URL.
async function downloadImage(url, { fetcher, timeoutMs = 5000, attempts = 2 } = {}) {
    const checked = trustedImageUrl(url);
    if (!checked) throw Object.assign(new Error('图片地址不受信任'), { code: 'SECURITY_BLOCKED' });
    const get = fetcher || (async (target, timeout) => {
        const axios = require('axios');
        const response = await axios({
            ...require('./direct-connect').directAxiosOptions(), url: target, method: 'GET', responseType: 'arraybuffer',
            timeout, maxRedirects: 0, maxContentLength: MAX_IMAGE_BYTES, validateStatus: () => true,
        });
        if (response.status !== 200) throw Object.assign(new Error(`图片请求失败（HTTP ${response.status}）`), { code: 'ERR_HTTP', status: response.status });
        return Buffer.from(response.data);
    });
    let last;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try { return await get(checked, timeoutMs); }
        catch (error) {
            last = error;
            // A refusal is final; only timeouts and resets deserve a second try.
            if (error?.status && error.status < 500) break;
        }
    }
    throw last;
}

module.exports = {
    createSession, fetchChapter, fetchDirectory, searchComicPage, pictureUrl, coverUrl, decryptImage, downloadImage,
    parseChapter, decodeChapter, exchangePayload, exchangeKey, trustedImageUrl, IMAGE_WIDTHS, READER_VERSION, ROUTES, routeHeaders,
    COMIC_GENRE, categoriesOf, fetchBookDetails, fetchBookInfo, fetchCategoryPage,
};
