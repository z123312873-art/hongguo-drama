import React, { useEffect, useMemo, useRef, useState } from 'react';
import DanmakuLine from './DanmakuLine';
import { foreignDanmaku, syncDanmakuLayer, clearDanmakuLayer, currentTimeline, subscribeTimeline } from './danmakuSpace.mjs';
import { DEFAULT_DANMAKU_SETTINGS, normalizeDanmakuSettings, createCommentFeed, commentIsBlocked, commentFetchBlocked, commentFailureAction, acceptCommentPage, advanceDanmaku, danmakuSeed, resizeDanmaku, commentFillCount } from './danmakuModel.mjs';
import { measureDanmakuText } from './danmakuEmoji.mjs';
import './CommentDanmaku.css';

const STORAGE_KEY = 'hongguo:comment-danmaku:v1';
const EMPTY = [];
const readPreferences = () => {
  try { const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY)); return { enabled: value?.enabled === true, ...normalizeDanmakuSettings(value) }; }
  catch { return { enabled: false, ...DEFAULT_DANMAKU_SETTINGS }; }
};

function useDanmakuPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  const [saveError, setSaveError] = useState('');
  const update = patch => {
    const next = { enabled: preferences.enabled, ...preferences, ...patch };
    const validated = { enabled: next.enabled === true, ...normalizeDanmakuSettings(next) };
    setPreferences(validated);
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(validated)); setSaveError(''); }
    catch { setSaveError('设置已生效，但本机保存失败'); }
  };
  const settings = useMemo(() => normalizeDanmakuSettings(preferences), [preferences]);
  return {
    enabled: preferences.enabled === true, settings, saveError, update,
    toggle: () => update({ enabled: !preferences.enabled }),
    reset: () => update(DEFAULT_DANMAKU_SETTINGS),
  };
}

export function useCommentDanmaku({ seriesId, episodeId, active }) {
  const preferences = useDanmakuPreferences();
  const [visible, setVisible] = useState(() => !document.hidden);
  const [, refresh] = useState(0);
  const [, bumpTimeline] = useState(0);
  useEffect(() => subscribeTimeline(() => bumpTimeline(value => value + 1)), []);
  const timeline = currentTimeline(seriesId, episodeId);
  const feed = useMemo(() => createCommentFeed(seriesId, episodeId), [seriesId, episodeId]);
  const currentFeed = useRef(feed);
  currentFeed.current = feed;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const supported = /^\d{6,30}$/.test(String(seriesId || '')) && /^\d{6,30}$/.test(String(episodeId || ''));
  const quota = timeline.ready ? commentFillCount(timeline.count) : 0;
  const enabled = preferences.enabled && supported;
  const running = enabled && active && visible && quota > 0;

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    const live = currentTimeline(feed.seriesId, feed.episodeId);
    const liveQuota = live.ready ? commentFillCount(live.count) : 0;
    if (!enabled || !active || !visible || liveQuota < 1) return undefined;
    const fetchNext = async () => {
      if (commentFetchBlocked(feed, Date.now(), document.hidden)) return;
      feed.loading = true;
      feed.lastRequest = Date.now();
      refresh(value => value + 1);
      try {
        const data = await window.electronAPI?.getEpisodeComments?.({ seriesId: feed.seriesId, episodeId: feed.episodeId, cursor: feed.cursor, limit: liveQuota });
        if (currentFeed.current !== feed) return;
        acceptCommentPage(feed, data, preferencesRef.current.settings, Date.now());
      } catch {
        if (currentFeed.current === feed) commentFailureAction(feed, null, Date.now());
      } finally {
        feed.loading = false;
        if (currentFeed.current === feed) refresh(value => value + 1);
      }
    };
    fetchNext();
    const timer = window.setInterval(fetchNext, 1500);
    return () => window.clearInterval(timer);
  }, [running, feed, quota, enabled, active, visible]);

  const { settings, saveError, toggle, update, reset } = preferences;
  const status = !supported ? '仅红果来源的当前集支持评论弹幕' : !preferences.enabled ? '开启后展示本集公开评论' : !active ? '播放本集后显示评论弹幕'
    : !visible ? '' : quota < 1 && timeline.ready ? '' : feed.error || (feed.loading ? '正在加载本集后续评论…' : feed.notice) || (!feed.loaded ? '正在加载本集评论…'
      : feed.comments.length ? `已读取本集 ${feed.comments.length} 条评论${feed.hasMore ? '，播放时继续加载' : '，当前可用评论已读取'}` : '本集暂无可显示的公开评论');
  return { enabled, supported, running, settings, feed, comments: feed.comments, status, saveError, error: feed.error, quota,
    loading: running && feed.loading, toggle, update, reset, retry: () => {
      feed.error = ''; feed.emptyPages = 0; feed.attempts = 0; feed.emptyTries = 0; feed.nextTryAt = 0;
      if (!feed.comments.length) feed.hasMore = true;
      refresh(value => value + 1);
    } };
}

export default function CommentDanmaku({ videoRef, source, available, danmaku }) {
  const layerRef = useRef(null);
  const nodes = useRef(new Map());
  const [items, setItems] = useState([]);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const { running, settings, comments, feed } = danmaku;

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const state = feed.animation;
    state.items = state.items.filter(item => !commentIsBlocked(item.content, settings));
    let nextY = 12;
    for (const item of [...state.items].sort((a, b) => a.y - b.y)) {
      item.width = measureDanmakuText(item.text, settings.fontSize);
      item.y = Math.max(item.y, nextY);
      nextY = item.y + settings.fontSize + 12;
    }
    setItems([...state.items]);
    const layer = layerRef.current;
    const video = videoRef.current;
    if (!running || !available || !layer || !video) return;
    let frame = 0;
    let previous = 0;
    let width = layer.clientWidth;
    let height = layer.clientHeight;
    const controls = layer.parentElement?.querySelector('.player-controls-bar');
    const options = () => ({ width, height, settings, reducedMotion, bottomInset: Math.max(76, (controls?.clientHeight || 0) + 8), seed: danmakuSeed(feed.seriesId, feed.episodeId), obstacles: foreignDanmaku('comments'), duration: Number.isFinite(video.duration) ? video.duration : 0 });
    const reset = () => {
      state.items = [];
      state.replayQueue = [];
      state.cooldown = 0;
      previous = 0;
      setItems([...state.items]);
    };
    const paint = () => state.items.forEach(item => {
      const node = nodes.current.get(item.id);
      if (node) node.style.transform = `translate3d(${Math.round(item.x)}px, ${Math.round(item.y)}px, 0)`;
    });
    const canAdvance = () => !video.paused && !video.ended && !document.hidden;
    const tick = now => {
      frame = 0;
      if (!canAdvance()) { previous = 0; return; }
      const delta = previous ? Math.min((now - previous) / 1000, 0.1) * video.playbackRate : 0.001;
      previous = now;
      if (advanceDanmaku(state, comments, delta, options())) setItems([...state.items]);
      syncDanmakuLayer('comments', state.items);
      paint();
      frame = requestAnimationFrame(tick);
    };
    const start = () => { if (!frame && canAdvance()) { previous = 0; frame = requestAnimationFrame(tick); } };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
    const emptied = () => { stop(); };
    const resize = () => {
      const nextWidth = layer.clientWidth;
      const nextHeight = layer.clientHeight;
      if (nextWidth === width && nextHeight === height) return;
      if (!resizeDanmaku(state, options(), { ...options(), width: nextWidth, height: nextHeight })) return;
      width = nextWidth; height = nextHeight;
      setItems([...state.items]); paint(); start();
    };
    // Settings keep current trajectories and consumption; only new arrivals use the new lanes.
    start();
    const observer = new ResizeObserver(resize);
    observer.observe(layer);
    const events = { playing: start, play: start, seeked: start, canplay: start, pause: stop, ended: stop, waiting: start, seeking: start, emptied };
    Object.entries(events).forEach(([name, handler]) => video.addEventListener(name, handler));
    return () => { clearDanmakuLayer('comments'); stop(); observer.disconnect(); Object.entries(events).forEach(([name, handler]) => video.removeEventListener(name, handler)); };
  }, [running, available, comments, settings, reducedMotion, source, videoRef, feed]);

  if (!running) return null;
  return <div ref={layerRef} className={`comment-danmaku ${reducedMotion ? 'comment-danmaku-static' : ''}`}>
    <div aria-hidden="true" style={{ opacity: settings.opacity / 100, fontSize: settings.fontSize }}>
      {(comments.length ? items : EMPTY).map(item => <span className="comment-danmaku-item" key={item.id} ref={node => { if (node) nodes.current.set(item.id, node); else nodes.current.delete(item.id); }}
        style={{ transform: `translate3d(${Math.round(item.x)}px, ${Math.round(item.y)}px, 0)` }}><DanmakuLine text={item.text} /></span>)}
    </div>
  </div>;
}

export function DanmakuSettings({ danmaku, onClose, panelRef, maxHeight }) {
  const { settings, update } = danmaku;
  return <div className="danmaku-settings" ref={panelRef} role="dialog" aria-label="弹幕设置" data-player-menu style={{ maxHeight }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="danmaku-settings-heading"><strong>{danmaku.sourceKind === 'both' ? '时间轴弹幕和本集评论' : danmaku.sourceKind === 'comments' ? '本集评论' : '时间轴弹幕'}</strong><button type="button" aria-label="关闭弹幕设置" onClick={onClose}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button></div>
    <p>{danmaku.sourceKind === 'both' ? '时间轴弹幕仍按视频时间出现。本集评论只补到这一集大约 25 条，出场间隔和速度都会变动；同一行改成和时间轴一样的速度，避免互相盖住。表情代码会显示成 emoji。' : danmaku.sourceKind === 'comments' ? '这一集时间轴不足，已用本集评论补上。评论分散飞过，速度会变动，不会在开播时排成一列。表情代码会显示成 emoji。' : danmaku.error ? '时间轴弹幕没有载入，可重试。时间轴不足约 25 条时，本集评论会补上，不会把读取失败说成本集没有弹幕。' : '正在读取时间轴弹幕。读完后若不足约 25 条，再补本集评论；时间轴更多时一集最多播放 35 条。'}</p>
    <label>不透明度 <output>{settings.opacity}%</output><input autoFocus aria-label="弹幕不透明度" type="range" min="20" max="100" step="5" value={settings.opacity} onChange={event => update({ opacity: Number(event.target.value) })} /></label>
    <label>字号 <output>{settings.fontSize}px</output><input aria-label="弹幕字号" type="range" min="16" max="32" step="2" value={settings.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })} /></label>
    <label>滚动速度 <output>{settings.speed}×</output><input aria-label="弹幕滚动速度" type="range" min="0.5" max="2" step="0.25" value={settings.speed} onChange={event => update({ speed: Number(event.target.value) })} /></label>
    <label>显示区域<select aria-label="弹幕显示区域" value={settings.area} onChange={event => update({ area: event.target.value })}><option value="quarter">四分之一屏</option><option value="half">半屏</option><option value="full">全屏</option></select></label>
    <label>弹幕密度<select aria-label="弹幕密度" value={settings.density} onChange={event => update({ density: event.target.value })}><option value="sparse">稀疏</option><option value="normal">适中</option><option value="dense">密集</option></select></label>
    <label className="danmaku-filter-toggle">内置敏感词过滤<input aria-label="内置敏感词过滤" type="checkbox" checked={settings.sensitiveFilter} onChange={event => update({ sensitiveFilter: event.target.checked })} /></label>
    <label>自定义屏蔽词<textarea aria-label="自定义屏蔽词" rows="3" maxLength="10000" value={settings.blockedWords} placeholder="每行一个词，也可用逗号分隔" onChange={event => update({ blockedWords: event.target.value })} /></label>
    <p>内置词含常见涉政及辱骂词；自定义词始终生效。命中后整条隐藏，仅保存在本机。词库无法覆盖所有表达或变体。</p>
    <p>默认在上半屏显示。跟随播放暂停与倍速；系统开启减少动态效果时，改为静态轮换。</p>
    <p role="status">{danmaku.saveError || danmaku.status}</p>
    <div className="danmaku-settings-actions">{danmaku.error && <button type="button" onClick={danmaku.retry}>重试加载</button>}<button type="button" onClick={danmaku.reset}>恢复默认</button></div>
  </div>;
}
