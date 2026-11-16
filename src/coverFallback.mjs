const CDN_HOST = /(^|\.)(fqnovelpic\.com|byteimg\.com)$/i;
const PLAIN_RENDITION = 'https://p3-novel.byteimg.com';
const OSS_HOST = /(^|\.)(zqkanshu\.com|aliyuncs\.com|kkyd\.cn)$/i;
const MIRROR_HOSTS = Object.freeze(['seoali.zqkanshu.com', 'kyyresali.kkyd.cn']);
const MIRROR_PATH = /^\/cppartner\/[\w./-]+\.(?:jpe?g|png|webp)$/i;
const MIRROR_PROCESS = 'image/resize,w_320/quality,q_80';

function mirrorCandidates(url) {
  const host = url.hostname.toLowerCase();
  if (!MIRROR_HOSTS.includes(host) || !MIRROR_PATH.test(url.pathname) || url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const stamp = /^\d{1,20}$/.test(url.searchParams.get('t') || '') ? url.searchParams.get('t') : '';
  const process = url.searchParams.get('x-oss-process') || MIRROR_PROCESS;
  const build = (name, withProcess) => {
    const query = [stamp ? `t=${stamp}` : '', withProcess ? `x-oss-process=${process}` : ''].filter(Boolean).join('&');
    return `https://${name}${url.pathname}${query ? `?${query}` : ''}`;
  };
  const others = MIRROR_HOSTS.filter(name => name !== host);
  return [build(host, true), ...others.map(name => build(name, true)), build(host, false)];
}

export function coverCandidates(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^https?:\/\//i.test(raw)) return [];
  const list = [raw];
  const add = (candidate) => { if (candidate && !list.includes(candidate)) list.push(candidate); };
  try {
    const url = new URL(raw);
    const marker = url.pathname.indexOf('~');
    if (CDN_HOST.test(url.hostname) && url.pathname.startsWith('/novel-pic/') && marker > '/novel-pic/'.length) {
      add(`${PLAIN_RENDITION}${url.pathname.slice(0, marker)}~tplv-shrink:640:0.image`);
    }
    const mirrored = mirrorCandidates(url);
    if (mirrored) return [...new Set([...mirrored.slice(0, -1), raw, mirrored.at(-1)])];
    if (OSS_HOST.test(url.hostname) && url.searchParams.has('x-oss-process')) {
      url.searchParams.delete('x-oss-process');
      add(url.href.replace(/\?$/, ''));
    }
  } catch (_) { return list; }
  return list;
}
