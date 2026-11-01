// Poster URLs differ per Hongguo endpoint. The App API serves HEIC variants that Chromium cannot decode;
// the same image id is also published as a plain JPEG-compatible rendition on the public CDN.
const CDN_HOST = /(^|\.)(fqnovelpic\.com|byteimg\.com)$/i;
const COMPATIBLE_CDN = 'https://p3-novel.byteimg.com';
const UNDECODABLE = /\.(?:heic|heif)$/i;

function compatibleCover(value) {
  const raw = String(value ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  let url;
  try { url = new URL(raw); } catch (_) { return ''; }
  if (!UNDECODABLE.test(url.pathname)) return raw;
  const marker = url.pathname.indexOf('~');
  if (!CDN_HOST.test(url.hostname) || !url.pathname.startsWith('/novel-pic/') || marker <= '/novel-pic/'.length) return '';
  return `${COMPATIBLE_CDN}${url.pathname.slice(0, marker)}~tplv-shrink:640:0.image`;
}

// Comic posters are served as small WebP renditions: about a fifth of the bytes of the site's own cover size.
// Accepts the site's full URL, the search API's "novel-pic/<md5>" path, or a bare md5.
function comicCover(value, width = 320) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/(?:^|\/)novel-pic\/([0-9a-f]{32})(?:~|$)/i) || (/^[0-9a-f]{32}$/i.test(raw) ? [null, raw] : null);
  if (!match) return '';
  return `${COMPATIBLE_CDN}/novel-pic/${match[1].toLowerCase()}~tplv-resize:${Math.max(1, Math.floor(Number(width) || 320))}:0.webp`;
}

module.exports = { compatibleCover, comicCover };
