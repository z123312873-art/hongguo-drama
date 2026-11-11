import { COMIC_MAX } from './comicLayout.mjs';

const PAGE_CONCURRENCY = 3;
const MAX_SITE_PAGES = 12;
const EXTRAS_POLL_MS = 3000;
const EXTRAS_POLL_ROUNDS = 25;
const PAGES_NOTICE = '部分页面暂时没载入，可点「刷新片单」重试。';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function uniqueCards(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const card of Array.isArray(list) ? list : []) {
      const id = String(card?.series_id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(card);
    }
  }
  return out;
}







export async function loadComicCatalog({ api, onProgress, isCurrent = () => true, forceRefresh = false } = {}) {
  const emit = (state) => { if (isCurrent()) onProgress?.(state); };
  let shown = [];
  let snapshotShown = false;
  if (!forceRefresh) {
    try {
      const reply = await api.comicSnapshot?.();
      const items = reply?.success ? uniqueCards([reply.snapshot?.items]).slice(0, COMIC_MAX) : [];
      if (!isCurrent()) return { cancelled: true };
      if (items.length) {
        shown = items;
        snapshotShown = true;
        emit({ items, siteCount: reply.snapshot.siteCount || items.length, expectedTotal: items.length, pending: true, stale: true, notice: '' });
      }
    } catch (_) {                                         }
  }

  const firstReply = await api.browseList({ source: 'hongguo', category: 'comic', page: 1, forceRefresh });
  if (!isCurrent()) return { cancelled: true };
  if (!firstReply?.success || !Array.isArray(firstReply.results) || !firstReply.results.length) {
    const message = firstReply?.error || '漫画片单暂时没有取到，请稍后重试。';
    if (snapshotShown) {
      emit({ items: shown, siteCount: shown.length, expectedTotal: shown.length, pending: false, stale: true, notice: `${message}（显示上次的片单）` });
      return { items: shown, stale: true };
    }
    throw Object.assign(new Error(message), { sourceUrl: firstReply?.sourceUrl });
  }
  const totalPages = Math.min(MAX_SITE_PAGES, Math.max(1, Number(firstReply.totalPages) || 1));
  const pages = new Map([[1, firstReply.results]]);
  const prefix = () => {
    const lists = [];
    for (let n = 1; pages.has(n); n += 1) lists.push(pages.get(n));
    return uniqueCards(lists).slice(0, COMIC_MAX);
  };
  const siteTotal = Number(firstReply.total) || firstReply.results.length * totalPages;
  const publish = (pending, extra = {}) => {
    const items = prefix();

    if (snapshotShown && pending) return;
    shown = items;
    emit({ items, siteCount: items.length, expectedTotal: Math.min(COMIC_MAX, Math.max(items.length, siteTotal)), pending, stale: false, notice: '', ...extra });
  };
  publish(true);

  let failedPages = 0;
  let nextPage = 2;
  const worker = async () => {
    while (nextPage <= totalPages) {
      const number = nextPage++;
      try {
        const reply = await api.browseList({ source: 'hongguo', category: 'comic', page: number, forceRefresh });
        if (!isCurrent()) return;
        if (reply?.success && Array.isArray(reply.results)) { pages.set(number, reply.results); publish(true); }
        else failedPages += 1;
      } catch (_) { failedPages += 1; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, Math.max(0, totalPages - 1)) }, worker));
  if (!isCurrent()) return { cancelled: true };

  const site = prefix();
  const complete = failedPages === 0 && pages.size === totalPages;
  shown = site;
  snapshotShown = false;
  const room = COMIC_MAX - site.length;
  if (room <= 0) {
    emit({ items: site, siteCount: site.length, expectedTotal: site.length, pending: false, stale: false, notice: '' });
    return { items: site };
  }
  emit({ items: site, siteCount: site.length, expectedTotal: COMIC_MAX, pending: true, stale: false,
    notice: complete ? '' : PAGES_NOTICE });

  let extras = [];
  let extrasFailed = false;
  let diagnostic = '';
  let refreshing = false;
  const askExtras = async () => {
    try {
      const reply = await api.comicExtras?.({ exclude: site.map((card) => card.series_id), limit: room });
      if (!isCurrent()) return false;
      if (reply?.success && Array.isArray(reply.items)) {
        extras = reply.items;
        extrasFailed = false;
        refreshing = reply.refreshing === true && reply.items.length < room;
        diagnostic = typeof reply.diagnostic === 'string' ? reply.diagnostic : '';
      } else { extrasFailed = true; refreshing = false; }
    } catch (_) { extrasFailed = true; refreshing = false; }
    return true;
  };
  if (!await askExtras()) return { cancelled: true };

  for (let round = 0; refreshing && round < EXTRAS_POLL_ROUNDS; round += 1) {
    emit({ items: uniqueCards([site, extras]).slice(0, COMIC_MAX), siteCount: site.length, expectedTotal: COMIC_MAX, pending: true, stale: false,
      notice: complete ? '' : PAGES_NOTICE });
    await (api.wait || wait)(EXTRAS_POLL_MS);
    if (!isCurrent()) return { cancelled: true };
    if (!await askExtras()) return { cancelled: true };
  }
  const items = uniqueCards([site, extras]).slice(0, COMIC_MAX);
  const short = items.length < Math.min(COMIC_MAX, site.length + room);
  let notice = '';
  if (!complete) notice = PAGES_NOTICE;
  else if (extrasFailed || (short && extras.length === 0)) notice = '补充漫画暂时没取到，先显示站内片单，稍后点「刷新片单」可再试。';
  else if (short) notice = '补充漫画还没取满，稍后点「刷新片单」可继续补齐。';
  emit({ items, siteCount: site.length, expectedTotal: items.length, pending: false, stale: false, notice, detail: notice ? diagnostic : '' });
  return { items };
}
