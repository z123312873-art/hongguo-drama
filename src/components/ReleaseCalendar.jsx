import React, { useEffect, useMemo, useState } from 'react';
import { publicDateKey, readLocalLibrary, removeLocalSeries, saveLocalSeries, subscribeLocalLibrary } from '../localLibrary';
import './ReleaseCalendar.css';

export default function ReleaseCalendar({ onPlay, opening = '', active = true }) {
  const [library, setLibrary] = useState(readLocalLibrary);
  const [chosenMonth, setChosenMonth] = useState('');
  const [catalogCovers, setCatalogCovers] = useState(() => new Map());
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
  const months = [...new Set(favorites.filter(item => item.date).map(item => item.date.slice(0, 7)))].sort().reverse();
  const month = months.includes(chosenMonth) ? chosenMonth : months[0] || '';
  const monthItems = favorites.filter(item => item.date.startsWith(`${month}-`)).sort((a, b) => b.favorited_at - a.favorited_at || a.title.localeCompare(b.title, 'zh-CN'));
  const days = [...new Set(monthItems.map(item => item.date))];
  const undated = favorites.filter(item => !item.date).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  const row = item => <li key={item.id} className="release-row">
    <div className="release-poster" aria-hidden="true"><span>暂无海报</span>{item.cover && <img key={item.cover} src={item.cover} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none'; }} />}</div>
    <div className="release-title"><strong>{item.title}</strong><span>{item.date ? `收藏于 ${item.date}` : '收藏日期未记录'}</span></div>
    <div className="release-row-actions">
      <button type="button" className="btn btn-sm btn-outline" aria-label={`取消收藏《${item.title}》`} aria-pressed={true} onClick={() => setLibrary(saveLocalSeries({ id: item.id, title: item.title, favorite: false }))}>取消收藏</button>
      <button type="button" className="btn btn-sm btn-outline" aria-label={`移除《${item.title}》`} title="仅移除本机收藏记录，不删除视频文件" onClick={() => setLibrary(removeLocalSeries(item.id))}>移除</button>
      <button type="button" className="btn btn-sm" disabled={!onPlay || !!opening || !active} aria-label={`播放《${item.title}》`} onClick={() => onPlay?.({ seriesId: item.id, title: item.title })}>{opening === item.id ? '打开中…' : '播放'}</button>
    </div>
  </li>;

  return <section className="release-calendar">
    <header><h2>收藏清单</h2><p className="page-description">只列出在海报上点过爱心的剧。日期是按下爱心的当天。</p></header>
    {library.error && <div className="release-error" role="alert"><p>{library.error}</p><button type="button" className="btn btn-sm" onClick={() => setLibrary(readLocalLibrary())}>重新读取</button></div>}
    <div className="release-toolbar">
      <p className="release-coverage">收藏 {favorites.length} 部</p>
      {months.length > 0 && <label className="release-month">月份<select value={month} onChange={event => setChosenMonth(event.target.value)}>{months.map(value => <option key={value} value={value}>{value.slice(0, 4)} 年 {Number(value.slice(5))} 月</option>)}</select></label>}
    </div>
    {!library.error && !favorites.length && <div className="release-empty"><h3>还没有收藏</h3><p>在「发现短剧」的海报右下角点爱心，这部剧就会出现在这里。</p></div>}
    {days.map(day => <section className="release-day" key={day} aria-label={`${day} 收藏`}><h3><span>{Number(day.slice(8))}</span><small>{Number(day.slice(5, 7))} 月</small></h3><ul>{monthItems.filter(item => item.date === day).map(row)}</ul></section>)}
    {undated.length > 0 && <section className="release-undated"><h3>收藏日期未记录 <span>{undated.length} 部</span></h3><p>这些是更早收藏的剧，当时没有记下点爱心的日期。</p><ul>{undated.map(row)}</ul></section>}
  </section>;
}
