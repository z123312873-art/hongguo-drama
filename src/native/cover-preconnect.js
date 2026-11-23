const remembered = new Map();
const LIMIT = 6;
const MIRROR_ORIGIN = {
  'https://seoali.zqkanshu.com': 'https://kyyresali.kkyd.cn',
  'https://kyyresali.kkyd.cn': 'https://seoali.zqkanshu.com',
};

function originOf(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : '';
  } catch (_) { return ''; }
}

function preconnect(origins, sessionLike) {
  let target = sessionLike;
  if (!target) {
    try { target = require('electron').session?.defaultSession; } catch (_) { target = null; }
  }
  if (!target || typeof target.preconnect !== 'function') return 0;
  let opened = 0;
  for (const origin of origins) {
    try { target.preconnect({ url: origin, numSockets: 6 }); opened += 1; } catch (_) {}
  }
  return opened;
}

function warm(sessionLike) {
  return preconnect([...remembered.keys()], sessionLike);
}

function remember(listed, sessionLike) {
  const items = Array.isArray(listed?.results) ? listed.results : [];
  const fresh = [];
  for (const item of items.slice(0, 24)) {
    const origin = originOf(item?.cover);
    if (!origin) continue;
    if (!remembered.has(origin)) fresh.push(origin);
    remembered.delete(origin);
    remembered.set(origin, Date.now());
    const mirror = MIRROR_ORIGIN[origin];
    if (mirror && !remembered.has(mirror)) {
      fresh.push(mirror);
      remembered.set(mirror, Date.now());
    }
  }
  while (remembered.size > LIMIT) remembered.delete(remembered.keys().next().value);
  return preconnect(fresh, sessionLike);
}

function forget() { remembered.clear(); }

module.exports = { warm, remember, forget, originOf };
