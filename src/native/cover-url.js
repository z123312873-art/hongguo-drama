

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




function comicCover(value, width = 320) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/(?:^|\/)(novel-pic|novel-images)\/([0-9a-f]{32})(?:~|$)/i)
    || (/^[0-9a-f]{32}$/i.test(raw) ? [null, 'novel-pic', raw] : null);
  if (!match) return '';
  return `${COMPATIBLE_CDN}/${match[1].toLowerCase()}/${match[2].toLowerCase()}~tplv-resize:${Math.max(1, Math.floor(Number(width) || 320))}:0.webp`;
}

module.exports = { compatibleCover, comicCover };
