import React, { useEffect, useMemo, useState } from 'react';
import { publicDateKey, readLocalLibrary, removeLocalSeries, saveLocalSeries, subscribeLocalLibrary } from '../localLibrary';
import { useFavoriteSyncStatus } from './useFavoriteSync';
import { favoriteView, isWaiting } from '../favoriteView.mjs';
import './ReleaseCalendar.css';

const WAITING_NOTICE = '您目前的预约收藏短剧，尚未上线，请耐心等候';

function onlineDateText(timestamp) {
  const shifted = new Date(Number(timestamp) + 8 * 60 * 60 * 1000);
  if (Number.isNaN(shifted.getTime())) return '';
  return `预计上线日期${shifted.getUTCMonth() + 1}月${shifted.getUTCDate()}日`;
}

export default function ReleaseCalendar({ onPlay, onUnavailable, opening = '', active = true }) {
  const [library, setLibrary] = useState(readLocalLibrary);
  const [chosenFilter, setChosenFilter] = useState('all');
  const [catalogCovers, setCatalogCovers] = useState(() => new Map());
  const [released, setReleased] = useState({});
  const sync = useFavoriteSyncStatus();
  useEffect(() => subscribeLocalLibrary(setLibrary), []);
  useEffect(() => {
    if (!library.items.some(item => item.favorite && !item.cover) || !window.electronAPI?.getSeriesList) return;
    let cancelled = false;
    window.electronAPI.getSeriesList().then(items => {
      if (!cancelled && Array.isArray(items)) setCatalogCovers(new Map(items.map(item => [String(item.series_id), item.cover || ''])));
    }).catch(() => {}); // Missing local metadata leaves the poster placeholder available.
    return () => { cancelled = true; };
  }, [library.items]);
  const favorites = useMemo(() => library.items.filter(item => item.favorite).map(item => ({
    ...item,
    cover: item.cover || catalogCovers.get(item.id) || '',
    date: publicDateKey(item.favorited_at),
  })), [library.items, catalogCovers]);
  useEffect(() => {
    if (!active || typeof window.electronAPI?.inspectRelease !== 'function') return undefined;
    const due = favorites.filter(item => Number(item.online_time) > 0 && Number(item.online_time) <= Date.now());
    if (!due.length) return undefined;
    let cancel = false;
    window.electronAPI.inspectRelease(due.map(item => ({ id: item.id, online_time: item.online_time }))).then(result => {
      if (cancel || !result?.success || !Array.isArray(result.results)) return;
      setReleased(current => {
        const next = { ...current };
        for (const row of result.results) {
          if (!row || row.skipped === true) continue;
          next[String(row.id)] = row.playable === true;
        }
        return next;
      });
    }).catch(() => {});
    return () => { cancel = true; };
  }, [active, favorites]);
  const inAccount = sync.mode === 'cloud' ? favorites.filter(item => item.cloud_user === sync.userId).length : 0;
  const view = favoriteView(favorites, { filter: chosenFilter, now: Date.now(), released });
  const row = item => {
    const onlineAt = Number(item.online_time);
    const waiting = isWaiting(item, Date.now(), released);
    return <li key={item.id} className="release-row">
      <div className="release-poster" aria-hidden="true"><span>暂无海报</span>{item.cover && <img key={item.cover} src={item.cover} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none'; }} />}</div>
      <div className="release-title"><strong>{item.title}</strong><span>{item.date ? `收藏于 ${item.date}` : '收藏日期未记录'}</span>{waiting && <em className="release-online">{onlineDateText(onlineAt)}</em>}</div>
      <div className="release-row-actions">
        <button type="button" className="btn btn-sm btn-outline" aria-label={`取消收藏《${item.title}》`} aria-pressed={true} onClick={() => setLibrary(saveLocalSeries({ id: item.id, title: item.title, favorite: false }))}>取消收藏</button>
        <button type="button" className="btn btn-sm btn-outline" aria-label={`移除《${item.title}》`} title={sync.mode === 'cloud' && item.cloud_user === sync.userId ? '同时从手机收藏移除，不删除视频文件' : '仅移除本机收藏记录，不删除视频文件'} onClick={() => setLibrary(removeLocalSeries(item.id))}>移除</button>
        <button type="button" className="btn btn-sm" disabled={!onPlay || !!opening || !active} aria-label={`播放《${item.title}》`} onClick={() => { if (waiting) { onUnavailable?.(WAITING_NOTICE); return; } onPlay?.({ seriesId: item.id, title: item.title }); }}>{opening === item.id ? '打开中…' : '播放'}</button>
      </div>
    </li>;
  };

  return <section className="release-calendar">
    <header><h2>收藏清单</h2><p className="page-description">只列出在海报上点过爱心的剧，最近收藏的在前。日期是按下爱心的当天。</p></header>
    <p className="page-description" role="status">{sync.mode === 'cloud' ? '已登录：可播放的收藏与手机收藏同一份；尚未上线的只留在这台电脑。' : '未同步：收藏只保存在这台电脑。'}</p>
    {sync.error && <p className="release-error" role="status">{sync.error}</p>}
    {sync.notice && <p className="page-description" role="status">{sync.notice}</p>}
    {library.error && <div className="release-error" role="alert"><p>{library.error}</p><button type="button" className="btn btn-sm" onClick={() => setLibrary(readLocalLibrary())}>重新读取</button></div>}
    <div className="release-toolbar">
      <p className="release-coverage">收藏 {favorites.length} 部{sync.mode === 'cloud' && favorites.length !== inAccount ? `（手机收藏 ${inAccount} 部，其余只在这台电脑）` : ''}</p>
    </div>
    {favorites.length > 0 && <div className="release-filter" role="group" aria-label="筛选收藏">{view.filters.map(option => <button key={option.id} type="button" aria-pressed={view.filter === option.id} onClick={() => setChosenFilter(option.id)}>{option.label} {option.count}</button>)}</div>}
    {!library.error && !favorites.length && <div className="release-empty"><h3>还没有收藏</h3><p>在「发现短剧」的海报右下角点爱心，这部剧就会出现在这里。</p></div>}
    {favorites.length > 0 && !view.rows.length && <p className="page-description" role="status">这个筛选下没有收藏。</p>}
    {view.rows.length > 0 && <ul className="release-list" aria-label="收藏清单，最近收藏的在前">{view.rows.map(row)}</ul>}
  </section>;
}
