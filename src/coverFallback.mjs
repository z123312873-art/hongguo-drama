

const CDN_HOST = /(^|\.)(fqnovelpic\.com|byteimg\.com)$/i;
const PLAIN_RENDITION = 'https://p3-novel.byteimg.com';
const OSS_HOST = /(^|\.)(zqkanshu\.com|aliyuncs\.com)$/i;

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
    if (OSS_HOST.test(url.hostname) && url.searchParams.has('x-oss-process')) {
      url.searchParams.delete('x-oss-process');
      const original = url.href.replace(/\?$/, '');
      if (original !== raw) list.push(original);
    }
  } catch (_) {                              }
  return list;
}
