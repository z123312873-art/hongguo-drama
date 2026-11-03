import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, X, ChevronRight } from './icons';
import useDialogKeyboard from './useDialogKeyboard';
import { desiredImageWidth, nextImageWidth, readerColumnWidth } from '../comicLayout.mjs';
import { neighbours } from '../comicProgress.mjs';
import { createDirectHealth, firstPictureUrls, inWindow, preloadWindow, reachedEnd } from '../comicPreload.mjs';
import './ComicReader.css';

const NEAR_MARGIN = '2400px 0px';
const PREFETCH_DELAY_MS = 800;
const WARM_LIMIT = 6;
const RESIZE_DELAY_MS = 250;

function readViewport() {
  const width = window.innerWidth || 0;
  return { column: readerColumnWidth(width), ratio: window.devicePixelRatio || 1 };
}

function ComicPage({ picture, itemId, root, position, total, load, onNear, health }) {
  const holder = useRef(null);
  const [src, setSrc] = useState('');
  const [state, setState] = useState('idle');
  const stage = useRef(0);
  const blobUrl = useRef('');
  const wantedUrl = useRef(picture.url);
  wantedUrl.current = picture.url;

  useEffect(() => {
    const node = holder.current;
    if (!node || typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) onNear(picture.index, entry.isIntersecting);
    }, { root: root || null, rootMargin: NEAR_MARGIN });
    observer.observe(node);
    return () => { observer.disconnect(); onNear(picture.index, false); };
  }, [root, onNear, picture.index]);

  useEffect(() => () => { if (blobUrl.current) URL.revokeObjectURL(blobUrl.current); }, []);

  const decryptedCopy = useCallback(async () => {
    setState('loading');
    try {
      const reply = await window.electronAPI.comicImage({ itemId, index: picture.index });
      if (!reply?.success || !reply.data) throw new Error(reply?.error || '图片暂时无法取得');
      const blob = new Blob([reply.data], { type: reply.mime || 'image/jpeg' });
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      blobUrl.current = URL.createObjectURL(blob);
      stage.current = 1;
      setSrc(blobUrl.current);
    } catch (_) {
      stage.current = 2;
      setState('failed');
    }
  }, [itemId, picture.index]);

  useEffect(() => {
    if (!load || src || state !== 'idle') return;
    stage.current = 0;
    if (health.skipDirect()) { decryptedCopy(); return; }
    setState('loading');
    setSrc(wantedUrl.current);
  }, [load, src, state, health, decryptedCopy]);

  const onError = () => {
    if (stage.current === 0) { health.noteFailed(); decryptedCopy(); }
    else { stage.current = 2; setState('failed'); }
  };

  const onLoad = () => {
    if (stage.current === 0) health.noteLoaded();
    setState('loaded');
  };

  const retry = () => {
    stage.current = 0;
    setSrc('');
    setState('idle');
    decryptedCopy();
  };

  const ratio = picture.width > 0 && picture.height > 0 ? `${picture.width} / ${picture.height}` : undefined;
  return (
    <div ref={holder} className={`comic-page comic-page-${state}`} style={ratio ? { aspectRatio: ratio } : { minHeight: 280 }} data-position={position}>
      {src && state !== 'failed' && (
        <img src={src} alt={`第 ${position} / ${total} 张`} decoding="async" draggable={false} fetchPriority={picture.index < 2 ? 'high' : undefined}
          onLoad={onLoad} onError={onError} />
      )}
      {state === 'failed' && (
        <div className="comic-page-failed" role="alert">
          <p>第 {position} 张没有载入</p>
          <button type="button" className="btn btn-outline btn-sm" onClick={retry}><RefreshCw size={14} />重试</button>
        </div>
      )}
      {state !== 'loaded' && state !== 'failed' && <span className="comic-page-wait" aria-hidden="true" />}
    </div>
  );
}

export default function ComicReader({ seriesTitle, episodes, itemId, onClose, onSelect }) {
  const [chapter, setChapter] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewport, setViewport] = useState(readViewport);
  const [scroller, setScroller] = useState(null);
  const request = useRef(0);
  const widthRef = useRef(0);
  const prefetchTimer = useRef(null);
  const nearPages = useRef(new Set());
  const health = useRef(null);
  const warmed = useRef(new Map());
  const [span, setSpan] = useState({ lo: 0, hi: -1 });
  const nav = neighbours(episodes, itemId);
  const current = episodes.find(entry => entry.itemId === itemId);
  if (!health.current) health.current = createDirectHealth();
  const total = chapter ? chapter.pictures.length : 0;
  const totalRef = useRef(0);
  totalRef.current = total;
  const observed = typeof IntersectionObserver === 'function';

  // Pages near the viewport, plus a few more after the last of them, are fetched ahead of the reader.
  const refreshSpan = useCallback((count) => {
    const next = preloadWindow({ near: nearPages.current, total: count });
    setSpan((value) => (value.lo === next.lo && value.hi === next.hi ? value : next));
  }, []);
  const noteNear = useCallback((index, isNear) => {
    if (isNear) nearPages.current.add(index); else nearPages.current.delete(index);
    refreshSpan(totalRef.current);
  }, [refreshSpan]);

  const load = useCallback(async (wanted) => {
    const ticket = ++request.current;
    setLoading(true);
    setError('');
    setChapter(null);
    clearTimeout(prefetchTimer.current);
    nearPages.current = new Set();
    totalRef.current = 0;
    setSpan({ lo: 0, hi: -1 });
    widthRef.current = nextImageWidth(0, desiredImageWidth(wanted.column, wanted.ratio));
    try {
      const reply = await window.electronAPI.comicChapter({ itemId, width: widthRef.current, priority: 'click' });
      if (ticket !== request.current) return;
      if (!reply?.success) throw new Error(reply?.error || '这一话暂时没取到');
      if (!Array.isArray(reply.pictures) || !reply.pictures.length) throw new Error('这一话没有图片');
      totalRef.current = reply.pictures.length;
      setChapter(reply);
      refreshSpan(reply.pictures.length);
    } catch (e) {
      if (ticket === request.current) setError(e?.message || '这一话暂时没取到，请稍后重试');
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [itemId, refreshSpan]);

  useEffect(() => {
    load(readViewport());
    scroller?.scrollTo?.({ top: 0 });
    return () => { request.current += 1; clearTimeout(prefetchTimer.current); };
    // The scroller node only changes the first time it mounts; resetting the scroll is for new episodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, load]);

  useEffect(() => () => {
    window.electronAPI?.comicCancelPrefetch?.();
    for (const image of warmed.current.values()) image.src = '';
    warmed.current.clear();
  }, []);

  // The next episode's list of pictures is asked for early. Its first pictures are fetched once the reader has
  // reached the end of this episode's pictures, so the two never compete for the same connections.
  const nextId = nav.next?.itemId || '';
  const nextChapter = useRef({ id: '', pictures: [] });
  useEffect(() => {
    nextChapter.current = { id: '', pictures: [] };
    if (!chapter || !nextId) return undefined;
    let live = true;
    prefetchTimer.current = setTimeout(async () => {
      try {
        const reply = await window.electronAPI?.comicChapter?.({ itemId: nextId, width: widthRef.current || 720, priority: 'prefetch' });
        if (live && reply?.success) nextChapter.current = { id: nextId, pictures: firstPictureUrls(reply) };
      } catch (_) { /* a missed prefetch only costs the wait on the next click */ }
    }, PREFETCH_DELAY_MS);
    return () => { live = false; clearTimeout(prefetchTimer.current); };
  }, [chapter, nextId]);

  const atEnd = chapter ? !observed || reachedEnd(span, total) : false;
  useEffect(() => {
    if (!atEnd || !nextId) return undefined;
    let timer;
    const warm = () => {
      if (nextChapter.current.id !== nextId) { timer = setTimeout(warm, 400); return; }
      for (const url of nextChapter.current.pictures) {
        if (warmed.current.has(url)) continue;
        if (warmed.current.size >= WARM_LIMIT) { const oldest = warmed.current.keys().next().value; warmed.current.get(oldest).src = ''; warmed.current.delete(oldest); }
        const image = new Image();
        image.decoding = 'async';
        image.src = url;
        warmed.current.set(url, image);
      }
    };
    warm();
    return () => clearTimeout(timer);
  }, [atEnd, nextId]);

  useEffect(() => {
    let timer;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const next = readViewport();
        setViewport(next);
        const wanted = desiredImageWidth(next.column, next.ratio);
        if (!chapter || wanted <= widthRef.current) return;
        const ticket = request.current;
        widthRef.current = nextImageWidth(widthRef.current, wanted);
        try {
          const reply = await window.electronAPI.comicChapter({ itemId, width: widthRef.current, priority: 'click' });
          if (ticket === request.current && reply?.success && Array.isArray(reply.pictures) && reply.pictures.length) setChapter(reply);
        } catch (_) { /* sharper renditions are optional */ }
      }, RESIZE_DELAY_MS);
    };
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, [chapter, itemId]);

  useDialogKeyboard(true, onClose, '.comic-reader');

  useEffect(() => {
    const onKey = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (/^(input|select|textarea)$/i.test(event.target?.tagName || '')) return;
      if (event.key === 'ArrowLeft' && nav.previous) { event.preventDefault(); onSelect(nav.previous.itemId); }
      else if (event.key === 'ArrowRight' && nav.next) { event.preventDefault(); onSelect(nav.next.itemId); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [nav.previous, nav.next, onSelect]);

  const label = current ? (/^\d+$/.test(current.label) ? `第 ${current.label} 话` : current.label) : '';
  const episodeTotal = episodes.length;
  return (
    <div className="comic-reader" role="dialog" aria-modal="true" aria-label={`${seriesTitle || '漫画'} ${label}`} tabIndex={-1}>
      <header className="comic-reader-bar">
        <button type="button" className="comic-reader-nav" disabled={!nav.previous} onClick={() => nav.previous && onSelect(nav.previous.itemId)} aria-label="上一话"><ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} />上一话</button>
        <div className="comic-reader-title">
          <strong>{seriesTitle}</strong>
          <span>{label}{nav.position > 0 && episodeTotal > 0 ? ` · ${nav.position}/${episodeTotal}` : ''}{chapter ? ` · ${chapter.pictureCount} 张` : ''}</span>
        </div>
        <button type="button" className="comic-reader-nav" disabled={!nav.next} onClick={() => nav.next && onSelect(nav.next.itemId)} aria-label="下一话">下一话<ChevronRight size={16} /></button>
        <button type="button" className="icon-btn comic-reader-close" onClick={onClose} aria-label="关闭阅读器" title="关闭 (Esc)"><X size={18} /></button>
      </header>
      <div className="comic-reader-scroll" ref={setScroller}>
        <div className="comic-reader-column" style={{ width: viewport.column || undefined }}>
          {loading && <div className="comic-reader-state" role="status"><RefreshCw size={20} className="spin" /><span>正在读取这一话…</span></div>}
          {!loading && error && (
            <div className="comic-reader-state" role="alert">
              <p>{error}</p>
              <button type="button" className="btn btn-primary" onClick={() => load(readViewport())}><RefreshCw size={15} />重试</button>
            </div>
          )}
          {chapter && chapter.pictures.map((picture) => (
            <ComicPage key={`${itemId}:${picture.index}`} picture={picture} itemId={itemId} root={scroller} position={picture.index + 1} total={chapter.pictureCount}
              load={!observed || inWindow(picture.index, span)} onNear={noteNear} health={health.current} />
          ))}
          {chapter && (
            <footer className="comic-reader-end">
              <p>{nav.next ? '这一话看完了' : '已经是最后一话'}</p>
              <div>
                {nav.previous && <button type="button" className="btn btn-outline" onClick={() => onSelect(nav.previous.itemId)}>上一话</button>}
                {nav.next && <button type="button" className="btn btn-primary" onClick={() => onSelect(nav.next.itemId)}>下一话</button>}
                <button type="button" className="btn btn-outline" onClick={onClose}>返回选集</button>
              </div>
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}
