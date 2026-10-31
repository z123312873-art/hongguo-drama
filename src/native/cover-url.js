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

module.exports = { compatibleCover };
