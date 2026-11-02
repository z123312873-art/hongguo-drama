// Loading a poster list that spans several source pages.
//
// Each page gets its own time limit and one more try, so one slow page cannot hold the others back, and the pages
// that did arrive are shown in their order as they come, instead of all at once when the slowest one is done.
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

/**
 * Asks `load()` for one page. A reply that failed (or never came) is asked for once more; an answer that says
 * "no more results" is final. Resolves to the last reply, never rejects. `isCurrent()` stops the retries early.
 */
export async function loadPage(load, { timeoutMs = PAGE_TIMEOUT_MS, attempts = PAGE_ATTEMPTS, isCurrent = () => true } = {}) {
  let reply = TIMEOUT_REPLY;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try { reply = await withLimit(Promise.resolve(load()), timeoutMs); } catch (error) { reply = { success: false, error: error?.message || TIMEOUT_REPLY.error }; }
    if (reply?.success === true || !isCurrent()) return reply || TIMEOUT_REPLY;
  }
  return reply || TIMEOUT_REPLY;
}

// The first page followed by every later page that arrived in order. The run stops at the first page that is
// missing, failed, or empty, so what is shown never has a hole in it.
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
