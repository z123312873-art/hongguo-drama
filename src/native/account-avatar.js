'use strict';






const MAX_URL = 2048;
const MAX_BYTES = 512 * 1024;
const MAX_CANDIDATES = 8;
const AVATAR_TIMEOUT_MS = 8000;
const IMAGE_CDN = /(^|\.)(byteimg\.com|fqnovelpic\.com|byteacctimg\.com|pstatp\.com|bytecdn\.cn|douyinpic\.com)$/i;
const NOVEL_CDN = /(^|\.)(byteimg\.com|fqnovelpic\.com)$/i;
const PLAIN_NOVEL_HOST = 'https://p3-novel.byteimg.com';
const DRAWABLE = /^data:image\/(?:jpeg|png|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_DATA_URI = Math.ceil(MAX_BYTES / 3) * 4 + 32;

function urlStrings(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => urlStrings(item, depth + 1));
  if (typeof value === 'object') {
    return [value.url, value.uri, ...(Array.isArray(value.url_list) ? value.url_list : [])]
      .flatMap(item => urlStrings(item, depth + 1));
  }
  return [];
}

function cleanUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > MAX_URL) return null;
  let url;
  try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'http:' && IMAGE_CDN.test(url.hostname)) url.protocol = 'https:';
  if (url.protocol !== 'https:') return null;

  if (url.pathname.includes('mosaic-legacy')) return null;
  return url;
}


function avatarCandidates(...values) {
  const out = [];
  const push = (value) => { if (value && !out.includes(value) && value.length <= MAX_URL) out.push(value); };
  for (const raw of values.flatMap(value => urlStrings(value))) {
    const url = cleanUrl(raw);
    if (!url) continue;
    push(url.toString());
    if (!IMAGE_CDN.test(url.hostname)) continue;
    const marker = url.pathname.indexOf('~');
    const base = marker > 1 ? url.pathname.slice(0, marker) : url.pathname;
    if (!/^\/[^/]+\/.+/.test(base)) continue;

    if (!/-sign\./i.test(url.hostname)) push(`${url.origin}${base}~tplv-shrink:240:0.jpeg`);
    if (NOVEL_CDN.test(url.hostname)) push(`${PLAIN_NOVEL_HOST}${base.replace(/^\/large\//, '/')}~tplv-shrink:240:0.jpeg`);
  }
  return out.slice(0, MAX_CANDIDATES);
}

function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (/^GIF8[79]a/.test(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return '';
}

function avatarDataUri(value) {
  return typeof value === 'string' && value.length <= MAX_DATA_URI && DRAWABLE.test(value) ? value : '';
}

async function defaultGet(url) {
  const axios = require('axios');
  const response = await axios({
    ...require('./direct-connect').directAxiosOptions(),
    url, method: 'GET', timeout: AVATAR_TIMEOUT_MS, maxRedirects: 3, responseType: 'arraybuffer',
    headers: { Accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif;q=0.9,*/*;q=0.1' },
    validateStatus: () => true, maxContentLength: MAX_BYTES,
  });
  return { status: response.status, body: Buffer.from(response.data || []) };
}


async function fetchAvatar(candidates, get = defaultGet) {
  for (const url of Array.isArray(candidates) ? candidates.slice(0, MAX_CANDIDATES) : []) {
    let response;
    try { response = await get(url); } catch { continue; }
    const body = Buffer.isBuffer(response?.body) ? response.body : null;
    if (response?.status !== 200 || !body || !body.length || body.length > MAX_BYTES) continue;
    const mime = sniffImage(body);
    if (!mime) continue;
    return { data: `data:${mime};base64,${body.toString('base64')}`, url };
  }
  return null;
}

module.exports = { avatarCandidates, sniffImage, avatarDataUri, fetchAvatar, MAX_BYTES, MAX_URL };
