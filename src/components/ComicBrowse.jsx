import { sourceTagCounts, sourceMatchesTags, chooseSourceTag } from '../comicTags.mjs';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Film, RefreshCw, X, Play, Check } from './icons';
import CoverImage from './CoverImage';
import ComicReader from './ComicReader';
import useDialogKeyboard from './useDialogKeyboard';
import { loadComicCatalog } from '../comicCatalog.mjs';
import { clampPage, comicPageSize, episodeGroups, groupIndexOf, pageCount, pagerNumbers, readerImageWidth, skeletonCount } from '../comicLayout.mjs';
import { firstPictureUrls } from '../comicPreload.mjs';
import { markRead, readProgress } from '../comicProgress.mjs';
import './ComicBrowse.css';

const CATALOG_TTL_MS = 10 * 60 * 1000;
const RESIZE_DELAY_MS = 250;
const HOVER_PREFETCH_MS = 160;
const HINT_LIMIT = 12;
let catalogMemory = null;

function storage() {
  try { return window.localStorage; } catch (_) { return null; }
}

function readPage(reservedRows) {
  try {
    const sidebar = document.querySelector?.('.sidebar');
    const sidebarWidth = sidebar && getComputedStyle(sidebar).display !== 'none' ? sidebar.getBoundingClientRect().width : 0;
    return comicPageSize({ width: window.innerWidth, height: window.innerHeight, reservedRows, sidebarWidth });
  } catch (_) { return { columns: 0, pageSize: 0 }; }
}

// A group is named after the episode numbers it holds, which can skip a number the source never published.
function groupName(episodes, group) {
  const first = episodes[group.start - 1]?.label;
  const last = episodes[group.end - 1]?.label;
  return /^\d+$/.test(first || '') && /^\d+$/.test(last || '') ? `${first}-${last}` : `${group.start}-${group.end}`;
}

const EMPTY = { items: [], siteCount: 0, expectedTotal: 0, pending: true, stale: false, notice: '', detail: '' };

export default function ComicBrowse({ active = true, reservedRows = 0, reloadToken = 0 }) {
  const [catalog, setCatalog] = useState(() => catalogMemory?.state || EMPTY);
  const [error, setError] = useState('');
  const [chips, setChips] = useState([]);
  const [page, setPage] = useState(1);
  const [layout, setLayout] = useState(() => readPage(reservedRows));
  const [detail, setDetail] = useState(null);
  const [reading, setReading] = useState('');
  const catalogRef = useRef(catalog);
  const ticket = useRef(0);
  const detailTicket = useRef(0);
  const seenReload = useRef(reloadToken);
  const [progress, setProgress] = useState({ read: new Set(), last: '' });
  const detailRef = useRef(null);
  const hoverTimer = useRef(null);
  const asked = useRef(new Set());
  const firstImages = useRef([]);
  catalogRef.current = catalog;
  detailRef.current = detail;

  const load = useCallback(async (forceRefresh = false) => {
    const mine = ++ticket.current;
    setError('');
    const hadItems = catalogRef.current.items.length > 0;
    try {
      const result = await loadComicCatalog({
        api: window.electronAPI,
        forceRefresh,
        isCurrent: () => mine === ticket.current,
        onProgress: (state) => {
          // A refresh never makes a list on screen shorter or flickers back to a first page.
          if (hadItems && state.pending && state.items.length < catalogRef.current.items.length) return;
          setCatalog(state);
          if (!state.pending && state.items.length) catalogMemory = { state, at: Date.now() };
        },
      });
      if (mine !== ticket.current || result?.cancelled) return;
    } catch (e) {
      if (mine !== ticket.current) return;
      if (!hadItems) setCatalog({ ...EMPTY, pending: false });
      setError(e?.message || '漫画片单暂时没有取到，请稍后重试。');
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const fresh = catalogMemory && Date.now() - catalogMemory.at < CATALOG_TTL_MS;
    const forced = seenReload.current !== reloadToken;
    seenReload.current = reloadToken;
    if (fresh && !forced) return undefined;
    load(forced);
    return undefined;
  }, [active, reloadToken, load]);

  useEffect(() => () => { ticket.current += 1; detailTicket.current += 1; clearTimeout(hoverTimer.current); for (const image of firstImages.current) image.src = ''; }, []);

  useEffect(() => {
    let timer;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setLayout(readPage(reservedRows)), RESIZE_DELAY_MS);
    };
    setLayout(readPage(reservedRows));
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, [reservedRows]);

  const filtered = useMemo(() => catalog.items.filter(card => sourceMatchesTags(card, chips)), [catalog.items, chips]);
  const counts = useMemo(() => sourceTagCounts(catalog.items), [catalog.items]);
  useEffect(() => { setChips(previous => previous.every(label => counts.has(label)) ? previous : []); }, [counts]);
  const size = layout.pageSize || 24;
  // The pager counts only the posters that are here, so it never shows pages that have nothing on them yet.
  // Empty cells fill the end of the last page while more titles are on their way.
  const knownTotal = filtered.length;
  const currentPage = clampPage(page, knownTotal, size);
  const visible = filtered.slice((currentPage - 1) * size, currentPage * size);
  const pages = pageCount(knownTotal, size);
  const waiting = skeletonCount({
    loaded: filtered.length, page: currentPage, pageSize: size, expectedTotal: catalog.expectedTotal,
    pending: catalog.pending && !chips.length,
  });
  const chipList = [...counts.keys()].map(label => ({ label }));

  const chooseChip = (label) => { setChips(chooseSourceTag(chips, label, counts)); setPage(1); };
  const goto = (next) => {
    const target = clampPage(next, knownTotal, size);
    if (target === currentPage) return;
    setPage(target);
    document.querySelector('.main-content:not([hidden])')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Pointing at an episode asks for its list of pictures and warms its first picture, so the click that follows
  // finds both ready. Only a few episodes are asked for, and only after the pointer rests on one.
  const hint = useCallback((itemId) => {
    clearTimeout(hoverTimer.current);
    if (asked.current.has(itemId) || asked.current.size >= HINT_LIMIT) return;
    hoverTimer.current = setTimeout(async () => {
      asked.current.add(itemId);
      try {
        const ratio = window.devicePixelRatio || 1;
        const reply = await window.electronAPI?.comicChapter?.({ itemId, width: readerImageWidth(window.innerWidth, ratio), priority: 'prefetch' });
        const [url] = reply?.success ? firstPictureUrls(reply, 1) : [];
        if (url && typeof Image === 'function') {
          const image = new Image();
          image.src = url;
          firstImages.current.push(image);
        }
      } catch (_) { /* a missed hint is harmless */ }
    }, HOVER_PREFETCH_MS);
  }, []);
  const unhint = useCallback(() => clearTimeout(hoverTimer.current), []);
  const forgetHints = useCallback(() => {
    clearTimeout(hoverTimer.current);
    asked.current = new Set();
    for (const image of firstImages.current) image.src = '';
    firstImages.current = [];
  }, []);

  const closeDetail = useCallback(() => {
    detailTicket.current += 1;
    forgetHints();
    window.electronAPI?.comicCancelPrefetch?.();
    setDetail(null);
    setReading('');
  }, []);
  const dropCard = useCallback((seriesId) => {
    setCatalog((value) => {
      const items = value.items.filter((entry) => entry.series_id !== seriesId);
      if (items.length === value.items.length) return value;
      const next = { ...value, items, expectedTotal: Math.max(items.length, value.expectedTotal - 1) };
      if (catalogMemory && !value.pending) catalogMemory = { state: next, at: catalogMemory.at };
      return next;
    });
  }, []);
  const openComic = async (card) => {
    const mine = ++detailTicket.current;
    forgetHints();
    setReading('');
    setProgress(readProgress(storage(), card.series_id));
    setDetail({ card, loading: true, error: '', episodes: [], group: 0 });
    try {
      const reply = await window.electronAPI.comicEpisodes(card.series_id);
      if (mine !== detailTicket.current) return;
      if (!reply?.success) {
        // A title the source lists without any episodes is parked by the service; take its poster off the page too.
        if (reply?.code === 'EMPTY_DIRECTORY') dropCard(card.series_id);
        throw new Error(reply?.error || '分集暂时没取到');
      }
      const known = readProgress(storage(), card.series_id);
      const groups = episodeGroups(reply.total);
      const lastAt = known.last ? reply.episodes.findIndex(entry => entry.itemId === known.last) : -1;
      setDetail({ card, loading: false, error: '', episodes: reply.episodes, group: lastAt >= 0 ? groupIndexOf(lastAt + 1, groups) : 0 });
    } catch (e) {
      if (mine === detailTicket.current) setDetail({ card, loading: false, error: e?.message || '分集暂时没取到', episodes: [], group: 0 });
    }
  };

  const openEpisode = useCallback((itemId) => {
    if (detailRef.current) markRead(storage(), detailRef.current.card.series_id, itemId);
    setProgress((value) => ({ read: new Set([...value.read, itemId]), last: itemId }));
    setReading(itemId);
  }, []);

  const leaveReader = useCallback(() => {
    window.electronAPI?.comicCancelPrefetch?.();
    setReading('');
  }, []);

  useDialogKeyboard(active && Boolean(detail) && !reading, closeDetail, '.comic-drawer');

  const groups = detail ? episodeGroups(detail.episodes.length) : [];
  const group = groups[Math.min(detail?.group || 0, Math.max(0, groups.length - 1))];
  const groupEpisodes = detail && group ? detail.episodes.slice(group.start - 1, group.end) : [];
  const resume = detail?.episodes.find(entry => entry.itemId === progress.last);

  return (
    <div className="comic-browse">
      <div className="comic-toolbar">
        <div className="browse-genres" role="group" aria-label="漫画标签筛选，可左右滑动，每次選擇一個">
          <button type="button" className={`genre-chip ${chips.length === 0 ? 'active' : ''}`} aria-pressed={chips.length === 0} onClick={() => chooseChip('全部')}>全部</button>
          {chipList.map(chip => (
            <button type="button" key={chip.label} className={`genre-chip ${chips.includes(chip.label) ? 'active' : ''}`} aria-pressed={chips.includes(chip.label)} onClick={() => chooseChip(chip.label)}>{chip.label}</button>
          ))}
        </div>
        <span className="comic-count" role="status">
          {catalog.items.length > 0 ? `共 ${catalog.expectedTotal > catalog.items.length && catalog.pending ? `${catalog.items.length}/${catalog.expectedTotal}` : catalog.items.length} 部` : ''}
          {catalog.pending && catalog.items.length > 0 ? ' · 正在补齐' : ''}
        </span>
      </div>

      {catalog.notice && <div className="alert browse-update-error comic-notice" role="status" title={catalog.detail || undefined}><span>{catalog.notice}</span></div>}
      {error && <div className={catalog.items.length ? 'alert alert-error browse-update-error' : 'browse-error-state'} role="alert">
        {!catalog.items.length && <Film size={36} />}
        {!catalog.items.length && <h3>暂时没能加载漫画</h3>}
        <p>{error}</p>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => load(true)}><RefreshCw size={15} />重新加载</button>
      </div>}

      {chips.length > 0 && !catalog.pending && filtered.length === 0 && (
        <div className="browse-filter-empty" role="status"><p>没有同时带有所选标签的漫画。</p><button type="button" className="btn btn-outline" onClick={() => chooseChip('全部')}>显示全部</button></div>
      )}

      {catalog.items.length === 0 && catalog.pending && !error ? (
        <div className="browse-loading-state" role="status" aria-label="正在加载漫画">
          <div className="poster-skeletons" aria-hidden="true">{Array.from({ length: size }, (_, i) => <div className="poster-skeleton" key={i}><div /><span /><span /></div>)}</div>
        </div>
      ) : (
        <div className="browse-grid comic-grid">
          {visible.map(card => (
            <button type="button" key={card.series_id} className="browse-card" onClick={() => openComic(card)} title={card.series_title}>
              <div className="browse-cover">
                <CoverImage src={card.cover} alt={card.series_title} />
                {card.episode_count > 0 && <span className="browse-ep-badge">{card.episode_count} 话</span>}
                <div className="browse-hover"><span className="browse-hover-play"><Play size={16} /> 选集阅读</span></div>
              </div>
              <div className="browse-card-title">{card.series_title}</div>
              {card.tags?.length > 0 && <div className="browse-card-tags">{card.tags.slice(0, 3).map(tag => <span key={tag} className="browse-tag">{tag}</span>)}</div>}
            </button>
          ))}
          {Array.from({ length: waiting }, (_, i) => <div className="poster-skeleton" key={`wait-${i}`} aria-hidden="true"><div /><span /><span /></div>)}
        </div>
      )}

      {pages > 1 && (
        <div className="browse-pager" role="navigation" aria-label="漫画分页">
          <button type="button" className="pager-item" aria-label="上一页" disabled={currentPage <= 1} onClick={() => goto(currentPage - 1)}>‹</button>
          {pagerNumbers(currentPage, pages).map((n, i, all) => (
            <React.Fragment key={n}>
              {i > 0 && n - all[i - 1] > 1 && <span className="pager-gap">…</span>}
              <button type="button" className={`pager-item ${n === currentPage ? 'active' : ''}`} aria-current={n === currentPage ? 'page' : undefined} onClick={() => goto(n)}>{n}</button>
            </React.Fragment>
          ))}
          <button type="button" className="pager-item" aria-label="下一页" disabled={currentPage >= pages} onClick={() => goto(currentPage + 1)}>›</button>
        </div>
      )}

      {detail && (
        <div className="browse-drawer-mask" onClick={closeDetail}>
          <div className="browse-drawer comic-drawer" role="dialog" aria-modal="true" aria-label="漫画选集" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="browse-drawer-head">
              <div className="browse-drawer-title"><Film size={18} /><span>{`《${detail.card.series_title}》`}</span></div>
              <button type="button" className="icon-btn" onClick={closeDetail} title="关闭" aria-label="关闭"><X size={16} /></button>
            </div>
            <div className="browse-drawer-body">
              <div className="browse-drawer-info">
                {detail.card.cover && <div className="comic-drawer-cover"><CoverImage src={detail.card.cover} alt="" /></div>}
                <div className="browse-drawer-meta">
                  <div className="browse-drawer-count">{detail.loading ? '正在读取分集…' : detail.error ? '' : `共 ${detail.episodes.length} 话`}</div>
                  {detail.card.tags?.length > 0 && <div className="browse-drawer-sub">{detail.card.tags.slice(0, 6).join(' · ')}</div>}
                  <div className="browse-drawer-sub">点选一话才会读取图片，不会一次抓取全部内容。</div>
                  {resume && <button type="button" className="btn btn-primary btn-sm comic-resume" onClick={() => openEpisode(resume.itemId)}><Play size={14} />继续阅读 · {/^\d+$/.test(resume.label) ? `第 ${resume.label} 话` : resume.label}</button>}
                </div>
              </div>
              {detail.loading && <div className="browse-loading" role="status"><RefreshCw size={18} className="spin" /><span>正在拉取分集…</span></div>}
              {detail.error && <div className="browse-error-state" role="alert"><p>{detail.error}</p><button type="button" className="btn btn-primary btn-sm" onClick={() => openComic(detail.card)}><RefreshCw size={15} />重试</button></div>}
              {groups.length > 1 && (
                <div className="comic-groups" role="tablist" aria-label="分集区间">
                  {groups.map((item, index) => (
                    <button type="button" role="tab" key={item.start} aria-selected={index === (detail.group || 0)} className={`btn-chip ${index === (detail.group || 0) ? 'active' : ''}`}
                      onClick={() => setDetail(value => ({ ...value, group: index }))}>{groupName(detail.episodes, item)}</button>
                  ))}
                </div>
              )}
              <div className="browse-eps comic-eps">
                {groupEpisodes.map(entry => (
                  <button type="button" key={entry.itemId} className={`ep-chip ${progress.read.has(entry.itemId) ? 'ep-completed' : ''} ${entry.itemId === progress.last ? 'ep-picked' : ''}`}
                    title={entry.title || `第 ${entry.label} 话`} onClick={() => openEpisode(entry.itemId)}
                    onMouseEnter={() => hint(entry.itemId)} onFocus={() => hint(entry.itemId)} onMouseLeave={unhint} onBlur={unhint}>
                    <span className="ep-num">{entry.label}</span>
                    {progress.read.has(entry.itemId) && <Check size={11} className="ep-badge" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {detail && reading && (
        <ComicReader seriesTitle={detail.card.series_title} episodes={detail.episodes} itemId={reading} onClose={leaveReader} onSelect={openEpisode} />
      )}
    </div>
  );
}
