// Ordered image URLs to try for one poster. The first is what the source returned; the second is the
// plain rendition of the same CDN image, used when the first one fails to load or decode.
const CDN_HOST = /(^|\.)(fqnovelpic\.com|byteimg\.com)$/i;
const PLAIN_RENDITION = 'https://p3-novel.byteimg.com';

export function coverCandidates(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^https?:\/\//i.test(raw)) return [];
  const list = [raw];
  try {
    const url = new URL(raw);
    const marker = url.pathname.indexOf('~');
    if (CDN_HOST.test(url.hostname) && url.pathname.startsWith('/novel-pic/') && marker > '/novel-pic/'.length) {
      const plain = `${PLAIN_RENDITION}${url.pathname.slice(0, marker)}~tplv-shrink:640:0.image`;
      if (plain !== raw) list.push(plain);
    }
  } catch (_) { /* keep the original only */ }
  return list;
}
