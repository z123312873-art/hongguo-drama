



const PAGE_TIMEOUT_MS = 12_000;
const PAGE_ATTEMPTS = 2;
const TIMEOUT_REPLY = Object.freeze({ success: false, error: '目录加载超时，请重试' });

function withLimit(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT_REPLY), ms); }),
  ]).finally(() => clearTimeout(timer));
}





export async function loadPage(load, { timeoutMs = PAGE_TIMEOUT_MS, attempts = PAGE_ATTEMPTS, isCurrent = () => true } = {}) {
  let reply = TIMEOUT_REPLY;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try { reply = await withLimit(Promise.resolve(load()), timeoutMs); } catch (error) { reply = { success: false, error: error?.message || TIMEOUT_REPLY.error }; }
    if (reply?.success === true || !isCurrent()) return reply || TIMEOUT_REPLY;
  }
  return reply || TIMEOUT_REPLY;
}



export function joinPages(first, replies, firstHasMore = false) {
  const results = [];
  const seen = new Set();
  let hasMore = firstHasMore === true;
  const add = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item?.series_id || seen.has(item.series_id)) continue;
      seen.add(item.series_id);
      results.push(item);
    }
  };
  add(first);
  let complete = true;
  for (const reply of Array.isArray(replies) ? replies : []) {
    if (!reply?.success || !Array.isArray(reply.results) || !reply.results.length) { hasMore = false; complete = false; break; }
    hasMore = reply.hasMore === true;
    add(reply.results);
  }
  return { results, hasMore, complete };
}
