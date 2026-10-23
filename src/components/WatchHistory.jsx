import React, { useEffect, useRef, useState } from 'react';
import { Play, RefreshCw, Clock, Trash2 } from './icons';
import './WatchHistory.css';

export default function WatchHistory({ active = true, onNavigate }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [pendingRemove, setPendingRemove] = useState('');
  const request = useRef(0);
  const openingRef = useRef(false);

  const load = async () => {
    const version = ++request.current;
    try {
      const result = await window.electronAPI.getWatchHistory();
      if (version !== request.current) return;
      if (!result?.success) throw new Error(result?.error || '观看记录加载失败');
      const next = result.results || [];
      setRows(next);
      setPendingRemove(current => next.some(item => item.series_id === current) ? current : '');
      setError('');
    } catch (failure) {
      if (version === request.current) setError(failure.message || '观看记录加载失败，请重试');
    } finally { if (version === request.current) setLoading(false); }
  };

  useEffect(() => {
    if (active) load();
    return () => { request.current++; };
  }, [active]);
  useEffect(() => window.electronAPI.onWatchHistoryUpdated?.(() => { if (active) load(); }), [active]);

  const checkUpdates = async () => {
    setChecking(true); setStatus(''); setError('');
    try {
      const result = await window.electronAPI.refreshWatchHistory();
      if (!result?.success) throw new Error(result?.error || '检查失败，请重试');
      await load();
      setStatus(`已检查 ${result.checked} 部${result.failed ? `，${result.failed} 部检查不完整，可稍后重试` : ''}${result.remaining ? `；还有 ${result.remaining} 部，点击继续检查` : ''}`);
    } catch (failure) { setError(failure.message || '检查失败，请重试'); }
    finally { setChecking(false); }
  };

  const removeRow = async (row) => {
    if (openingRef.current || checking) return;
    if (pendingRemove !== row.series_id) { setPendingRemove(row.series_id); return; }
    setPendingRemove('');
    setError('');
    try {
      const result = await window.electronAPI.deleteWatchHistory(row.series_id);
      if (!result?.success) throw new Error(result?.error || '移除失败，请重试');
      setRows(current => current.filter(item => item.series_id !== row.series_id));
    } catch (failure) { setError(failure.message || '移除失败，请重试'); }
  };

  const resume = async (row, sequel = null) => {
    if (openingRef.current) return;
    openingRef.current = true;
    setOpening(row.series_id); setError('');
    try {
      if (sequel) {
        const detail = await window.electronAPI.searchResolve(sequel.series_id);
        if (!detail?.success) throw new Error(detail?.error || '续作详情暂不可用');
        const episode = detail.data?.episodes?.find(item => !item.locked);
        if (!episode) throw new Error('续作暂时没有可播放的分集');
        const result = await window.electronAPI.playSeries({ seriesId: sequel.series_id, vidIndex: episode.vid_index });
        if (!result?.success) throw new Error(result?.error || '打开播放器失败');
      } else {
        const result = await window.electronAPI.playSeries({ seriesId: row.series_id, vidIndex: row.vid_index, resume: true });
        if (!result?.success) throw new Error(result?.error || '打开播放器失败');
      }
      const acknowledged = await window.electronAPI.acknowledgeWatchUpdates(row.series_id, { total: row.total, sequelIds: (row.sequels || []).map(item => item.series_id) });
      if (!acknowledged?.success) throw new Error(acknowledged?.error || '更新标记保存失败');
      setRows(current => current.map(item => item.series_id === row.series_id ? { ...item, hasUpdates: false, unreadEpisodes: 0 } : item));
    } catch (failure) { setError(failure.message || '打开失败，请重试'); }
    finally { setOpening(''); openingRef.current = false; }
  };

  return <section className="history-container" aria-labelledby="history-title">
    <div className="history-header">
      <div><h1 id="history-title">观看记录</h1><p>继续上次的故事。记录仅保存在这台电脑。</p></div>
      <button className="btn btn-outline" onClick={checkUpdates} disabled={checking || loading || !rows.length}>
        <RefreshCw size={15} className={checking ? 'spin' : ''} />{checking ? '正在检查更新…' : '检查更新'}
      </button>
    </div>
    <p className="history-hint">检查更新只包含这份列表里的剧。移除后不再检查该剧，已下载视频仍保留；再次播放会重新出现。运行期间也会自动检查列表中的新集。</p>
    {error && <div className="history-error" role="alert"><span>{error}</span><button className="btn btn-outline btn-sm" onClick={load}>重新加载</button></div>}
    {status && <p className="history-hint" role="status">{status}</p>}
    {loading ? <p role="status">正在读取观看记录…</p> : !rows.length ? <div className="history-empty">
      <Clock size={30} /><h2>还没有观看记录</h2><p>真正开始播放后，短剧和进度会出现在这里。</p>
      <button className="btn btn-primary" onClick={() => onNavigate?.('browse')}>去发现短剧</button>
    </div> : <ul className="history-list">{rows.map(row => <li className="history-row" key={row.series_id}>
      <div className="history-line">
      <button className="history-resume" onClick={() => resume(row)} disabled={!!opening} aria-label={`继续观看 ${row.series_title} 第${row.vid_index}集${row.hasUpdates ? `，有更新${row.unreadEpisodes ? `，新增${row.unreadEpisodes}集` : '，发现疑似续作'}` : ''}`}>
        {row.cover ? <img className="history-cover" src={row.cover} alt="" loading="lazy" /> : <span className="history-cover history-cover-empty"><Play size={20} /></span>}
        <span className="history-copy">
          <span className="history-name">{row.hasUpdates && <span className="history-dot" role="img" aria-label="有更新" />}{row.series_title}</span>
          <span className="history-progress">看到第 {row.vid_index} 集 / 共 {row.total} 集 · {Math.floor((row.currentTime || 0) / 60)}:{String(Math.floor((row.currentTime || 0) % 60)).padStart(2, '0')}</span>
          <span className="history-time">最近观看 {new Date(row.updatedAt).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })}</span>
          {row.unreadEpisodes > 0 && <span className="history-update">新增 {row.unreadEpisodes} 集</span>}
        </span>
        <span className="history-action"><Play size={15} />{opening === row.series_id ? '打开中…' : '继续观看'}</span>
      </button>
      <button type="button" className="btn btn-outline btn-sm history-remove" disabled={!!opening || checking}
        aria-label={pendingRemove === row.series_id ? `确认从观看记录移除 ${row.series_title}` : `从观看记录移除 ${row.series_title}`}
        title={pendingRemove === row.series_id ? '不删除已下载视频' : '从观看记录移除，不再检查这部剧'}
        onClick={() => removeRow(row)}><Trash2 size={14} />{pendingRemove === row.series_id ? '确认移除' : '移除'}</button>
      {pendingRemove === row.series_id && <button type="button" className="btn btn-outline btn-sm" onClick={() => setPendingRemove('')}>取消</button>}
      </div>
      {!!row.sequels?.length && <div className="history-sequels"><span>疑似续作</span>{row.sequels.map(sequel => <button key={sequel.series_id} className="btn btn-outline btn-sm" disabled={!!opening} onClick={() => resume(row, sequel)}>{sequel.series_title}</button>)}</div>}
      {row.lastCheckError && <p className="history-check-error">更新检查未完成：{row.lastCheckError}</p>}
    </li>)}</ul>}
  </section>;
}
