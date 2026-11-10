import React, { useEffect, useMemo, useRef, useState } from 'react';
import { publicDateKey, readLocalLibrary, removeLocalSeries, saveLocalSeries, subscribeLocalLibrary } from '../localLibrary';
import { useFavoriteSyncStatus, changeFavoriteFolder, refreshFavoriteFolders } from './useFavoriteSync';
import { favoriteView, isWaiting } from '../favoriteView.mjs';
import folderRules from '../native/folder-rules';
import { RefreshCw, Shield, Folder, FolderPlus, Plus, Trash2 } from './icons';
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
  const [chosenFolder, setChosenFolder] = useState('');
  const [catalogCovers, setCatalogCovers] = useState(() => new Map());
  const [released, setReleased] = useState({});
  const sync = useFavoriteSyncStatus();
  const [folderDialog, setFolderDialog] = useState(null);
  const [folderConfirm, setFolderConfirm] = useState(null);
  const [folderError, setFolderError] = useState('');
  const [folderPending, setFolderPending] = useState(false);
  const pendingFolder = useRef(false);
  const folderEpoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; folderEpoch.current++; }; }, []);
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
    if (!active || typeof window.electronAPI?.inspectRelease !== 'function' || !favorites.some(item => Number(item.online_time) > 0)) return undefined;
    let cancel = false, busy = false;
    const inspect = async () => {
      if (busy || cancel) return;
      const due = favorites.filter(item => Number(item.online_time) > 0 && Number(item.online_time) <= Date.now());
      if (!due.length) return;
      busy = true;
      try {
        const result = await window.electronAPI.inspectRelease(due.map(item => ({ id: item.id, online_time: item.online_time })));
        if (!cancel && result?.success && Array.isArray(result.results)) setReleased(previous => {
          const next = { ...previous };
          for (const row of result.results) if (row && row.skipped !== true && typeof row.playable === 'boolean') next[String(row.id)] = row.playable;
          return next;
        });
      } catch {} finally { busy = false; }
    };
    inspect();
    const timer = setInterval(inspect, 60000);
    return () => { cancel = true; clearInterval(timer); };
  }, [active, favorites]);
  const inAccount = sync.mode === 'cloud' ? favorites.filter(item => item.cloud_user === sync.userId).length : 0;
  const folders = Array.isArray(sync.folders) ? sync.folders : [];
  const folder = folders.find(item => item.id === chosenFolder);
  useEffect(() => { setChosenFolder(''); setFolderDialog(null); setFolderConfirm(null); setFolderError(''); folderEpoch.current++; }, [sync.userId]);
  useEffect(() => { if (!active) { setFolderDialog(null); setFolderConfirm(null); folderEpoch.current++; } }, [active]);
  useEffect(() => { if (chosenFolder && !folders.some(item => item.id === chosenFolder)) setChosenFolder(''); }, [chosenFolder, sync.folders]);
  const folderBusy = folderPending || sync.folderBusy;
  const folderOnline = window.navigator?.onLine !== false;
  const folderReady = active && sync.mode === 'cloud' && Boolean(sync.userId) && folderOnline && !sync.foldersStale && !sync.foldersError && !folderBusy;
  const editableFolder = folderReady && Boolean(folder?.revision);
  const eligible = favorites.filter(item => /^\d{6,25}$/.test(item.id) && item.cloud_user === sync.userId && !isWaiting(item, Date.now(), released));
  const snapshot = target => ({ folderId: target.id, revision: target.revision });
  const runFolder = async input => {
    if (!folderReady || pendingFolder.current) return;
    pendingFolder.current = true; setFolderPending(true); setFolderError('');
    const version = folderEpoch.current;
    try {
      const result = await changeFavoriteFolder(input);
      if (!mounted.current || version !== folderEpoch.current) return;
      if (!result?.success) {
        setFolderError(result?.error || '收藏夾未變更，請重新整理後重試。');
        setFolderDialog(null); setFolderConfirm(null);
        await refreshFavoriteFolders();
        return;
      }
      setFolderDialog(null); setFolderConfirm(null);
      if (input.operation === 'delete') setChosenFolder('');
      else if (result.folderId) setChosenFolder(result.folderId);
    } catch {
      if (mounted.current && version === folderEpoch.current) setFolderError('收藏夾尚未確認更新，請先重新整理，不要重複操作。');
    } finally {
      pendingFolder.current = false;
      if (mounted.current) setFolderPending(false);
    }
  };
  const openName = operation => {
    setFolderError(''); setFolderConfirm(null);
    setFolderDialog({ operation, ...(operation === 'rename' ? snapshot(folder) : {}), name: operation === 'rename' ? folder.name : '' });
  };
  const submitName = async event => {
    event.preventDefault();
    try {
      const name = folderRules.validateName(folderDialog.name, folders, folderDialog.folderId);
      await runFolder({ ...folderDialog, name });
    } catch (error) { setFolderError(error.message); }
  };
  const openAdd = item => {
    setFolderError(''); setFolderConfirm(null);
    const available = folders.filter(target => target.revision && !target.itemIds.includes(item.id));
    setFolderDialog({ operation: 'add', itemId: item.id, title: item.title, folderId: available.find(target => target.id === chosenFolder)?.id || available[0]?.id || '' });
  };
  const submitAdd = async event => {
    event.preventDefault();
    const target = folders.find(item => item.id === folderDialog.folderId);
    if (!target?.revision || target.itemIds.includes(folderDialog.itemId)) { setFolderError('請選擇尚未收錄這部劇的收藏夾。'); return; }
    await runFolder({ operation: 'add', ...snapshot(target), itemId: folderDialog.itemId });
  };
  const requestDelete = () => { setFolderError(''); setFolderDialog(null); setFolderConfirm({ operation: 'delete', ...snapshot(folder), name: folder.name, itemCount: folder.itemCount ?? folder.itemIds.length }); };
  const requestRemove = item => { setFolderError(''); setFolderDialog(null); setFolderConfirm({ operation: 'remove', ...snapshot(folder), name: folder.name, itemId: item.id, title: item.title }); };
  const view = favoriteView(favorites, { filter: chosenFilter, now: Date.now(), released, folderIds: folder?.itemIds });
  const waitingRows = view.filter === 'all' ? view.rows.filter(item => isWaiting(item, Date.now(), released)) : [];
  const visibleRows = waitingRows.length ? view.rows.filter(item => !isWaiting(item, Date.now(), released)) : view.rows;
  const row = item => {
    const onlineAt = Number(item.online_time);
    const waiting = isWaiting(item, Date.now(), released);
    return <li key={item.id} className="release-row">
      <div className="release-poster" aria-hidden="true"><span>暂无海报</span>{item.cover && <img key={item.cover} src={item.cover} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none'; }} />}</div>
      <div className="release-title"><strong>{item.title}</strong><span>{item.date ? `收藏于 ${item.date}` : '收藏日期未记录'}</span>{waiting && <em className="release-online">{onlineDateText(onlineAt)}</em>}</div>
      <div className="release-row-actions">
        <button type="button" className="btn btn-sm btn-outline" aria-label={`將《${item.title}》加入收藏夾`} disabled={!folderReady || !eligible.some(entry => entry.id === item.id) || !folders.some(target => target.revision && !target.itemIds.includes(item.id))} onClick={() => openAdd(item)}><FolderPlus size={14} />加入收藏夾</button>
        {folder && <button type="button" className="btn btn-sm btn-outline" aria-label={`將《${item.title}》移出收藏夾`} disabled={!editableFolder} onClick={() => requestRemove(item)}>移出收藏夾</button>}
        <button type="button" className="btn btn-sm btn-outline" aria-label={`取消收藏《${item.title}》`} aria-pressed={true} onClick={() => setLibrary(saveLocalSeries({ id: item.id, title: item.title, favorite: false }))}>取消收藏</button>
        <button type="button" className="btn btn-sm btn-outline" aria-label={`移除《${item.title}》`} title={sync.mode === 'cloud' && item.cloud_user === sync.userId ? '同时从手机收藏移除，不删除视频文件' : '仅移除本机收藏记录，不删除视频文件'} onClick={() => setLibrary(removeLocalSeries(item.id))}>移除</button>
        <button type="button" className="btn btn-sm" disabled={!onPlay || !!opening || !active} aria-label={`播放《${item.title}》`} onClick={() => { if (waiting) { onUnavailable?.(WAITING_NOTICE); return; } onPlay?.({ seriesId: item.id, title: item.title }); }}>{opening === item.id ? '打开中…' : '播放'}</button>
      </div>
    </li>;
  };

  return <section className="release-calendar">
    <header><h2>收藏清单</h2><p className="page-description">只列出在海报上点过爱心的剧，最近收藏的在前。日期是按下爱心的当天。</p></header>
    <div className="record-summary" aria-label="收藏同步說明">
      <div><RefreshCw size={18} /><p><strong>{sync.mode === 'cloud' ? '手機收藏自動合併' : '收藏保存在這臺電腦'}</strong><span>{sync.mode === 'cloud' ? '可播放的收藏會同步；尚未上線或暫時無法加入帳號的，先留在本機。' : '登入後，可播放的收藏會與手機合併。'}</span></p></div>
      <div><Shield size={18} /><p><strong>取消收藏，不刪影片</strong><span>{sync.mode === 'cloud' ? '已同步的收藏，取消時也會從手機移除。' : '下載的影片不受影響。'}</span></p></div>
      {sync.notice && <div role="status"><Folder size={18} /><p>{sync.notice}</p></div>}
    </div>
    {sync.error && <p className="release-error" role="status">手機收藏暫時無法同步，這臺電腦的收藏仍會保留。請稍後重試。</p>}
    {sync.foldersError && <p className="page-description" role="status">收藏夾暫時無法讀取，仍可查看全部收藏。</p>}
    {library.error && <div className="release-error" role="alert"><p>{library.error}</p><button type="button" className="btn btn-sm" onClick={() => setLibrary(readLocalLibrary())}>重新读取</button></div>}
    <div className="release-toolbar">
      <p className="release-coverage">收藏 {favorites.length} 部{sync.mode === 'cloud' && favorites.length !== inAccount ? `（手机收藏 ${inAccount} 部，其余只在这台电脑）` : ''}</p>
    </div>
    <div className="release-folders" aria-label="收藏夾管理" aria-busy={Boolean(folderBusy)}>
      <label htmlFor="favorite-folder"><Folder size={16} />收藏夾</label>
      <select id="favorite-folder" value={folder?.id || ''} disabled={folderBusy} onChange={event => { setChosenFolder(event.target.value); setFolderDialog(null); setFolderConfirm(null); setFolderError(''); }}>
        <option value="">全部收藏</option>
        {folders.map(item => <option key={item.id} value={item.id}>{item.name}（{item.itemIds.length}）</option>)}
      </select>
      <button type="button" className="btn btn-sm btn-outline" aria-label="重新整理收藏夾" disabled={!active || !sync.userId || folderBusy || !folderOnline} onClick={async () => { setFolderError(''); const result = await refreshFavoriteFolders(); if (!result?.success) setFolderError('收藏夾暫時無法讀取，已保留原有資料。'); }}><RefreshCw size={14} />重新整理</button>
      <button type="button" className="btn btn-sm" aria-label="新增收藏夾" disabled={!folderReady} onClick={() => openName('create')}><Plus size={14} />新增收藏夾</button>
      {folder && <>
        <button type="button" className="btn btn-sm btn-outline" aria-label="重新命名收藏夾" disabled={!editableFolder} onClick={() => openName('rename')}>改名</button>
        <button type="button" className="btn btn-sm btn-outline" aria-label="刪除收藏夾" disabled={!editableFolder} onClick={requestDelete}><Trash2 size={14} />刪除收藏夾</button>
        <button type="button" className="btn btn-sm btn-outline" aria-label="加入短劇到目前收藏夾" disabled={!editableFolder || !eligible.some(item => !folder.itemIds.includes(item.id))} onClick={() => { const item = eligible.find(entry => !folder.itemIds.includes(entry.id)); if (item) openAdd(item); }}><FolderPlus size={14} />加入短劇</button>
      </>}
      <small>{!folderOnline ? '目前離線，收藏夾不會變更；連線後請重新整理。' : sync.mode !== 'cloud' ? '登入並完成同步後，可編輯手機收藏夾。' : '與手機雙向同步；移出或刪除收藏夾不會取消收藏，也不刪影片。'}</small>
    </div>
    {sync.folderNotice && <p className="folder-notice" role="status">{sync.folderNotice}</p>}
    {folderError && <p className="release-error" role="alert">{folderError}</p>}
    {folderDialog && ['create', 'rename'].includes(folderDialog.operation) && <form className="folder-editor" aria-label={folderDialog.operation === 'create' ? '新增收藏夾名稱' : '修改收藏夾名稱'} onSubmit={submitName}>
      <label htmlFor="folder-name-input">收藏夾名稱</label>
      <input id="folder-name-input" value={folderDialog.name} maxLength={folderRules.MAX_NAME_LENGTH} disabled={!folderReady} autoFocus onChange={event => setFolderDialog({ ...folderDialog, name: event.target.value })} />
      <small>{folderDialog.name.trim().length} / {folderRules.MAX_NAME_LENGTH} 字；表情符號通常占 2 字</small>
      <button className="btn btn-sm" type="submit" disabled={!folderReady}>{folderBusy ? '同步中…' : '儲存收藏夾'}</button>
      <button className="btn btn-sm btn-outline" type="button" disabled={folderBusy} onClick={() => { setFolderDialog(null); setFolderError(''); }}>取消</button>
    </form>}
    {folderDialog?.operation === 'add' && <form className="folder-editor" aria-label="加入短劇到收藏夾" onSubmit={submitAdd}>
      <label htmlFor="folder-drama-input">短劇</label>
      <select id="folder-drama-input" value={folderDialog.itemId} disabled={!folderReady} onChange={event => { const item = eligible.find(entry => entry.id === event.target.value); if (item) openAdd(item); }}>{eligible.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select>
      <label htmlFor="folder-target-input">加入收藏夾</label>
      <select id="folder-target-input" value={folderDialog.folderId} disabled={!folderReady} onChange={event => setFolderDialog({ ...folderDialog, folderId: event.target.value })}>
        <option value="">請選擇收藏夾</option>
        {folders.filter(target => target.revision && !target.itemIds.includes(folderDialog.itemId)).map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
      </select>
      <button className="btn btn-sm" type="submit" disabled={!folderReady || !folderDialog.folderId}>確認加入</button>
      <button className="btn btn-sm btn-outline" type="button" disabled={folderBusy} onClick={() => setFolderDialog(null)}>取消</button>
    </form>}
    {folderConfirm && <div className="folder-confirm" role="alertdialog" aria-label={folderConfirm.operation === 'delete' ? '確認刪除收藏夾' : '確認移出收藏夾'}>
      <strong>{folderConfirm.operation === 'delete' ? `刪除「${folderConfirm.name}」？其中有 ${folderConfirm.itemCount} 筆內容。` : `將《${folderConfirm.title}》移出「${folderConfirm.name}」？`}</strong>
      <p>只變更這個收藏夾，手機的全部收藏與下載影片都會保留。</p>
      <button className="btn btn-sm btn-danger" type="button" disabled={!folderReady} onClick={() => runFolder({ ...folderConfirm, confirmed: true })}>{folderConfirm.operation === 'delete' ? '確認刪除收藏夾' : '確認移出收藏夾'}</button>
      <button className="btn btn-sm btn-outline" type="button" disabled={folderBusy} onClick={() => setFolderConfirm(null)}>取消</button>
    </div>}
    {favorites.length > 0 && <div className="release-filter" role="group" aria-label="筛选收藏">{view.filters.map(option => <button key={option.id} type="button" aria-pressed={view.filter === option.id} onClick={() => setChosenFilter(option.id)}>{option.label} {option.count}</button>)}</div>}
    {!library.error && !favorites.length && <div className="release-empty"><h3>还没有收藏</h3><p>在「发现短剧」的海报右下角点爱心，这部剧就会出现在这里。</p></div>}
    {favorites.length > 0 && !view.rows.length && <p className="page-description" role="status">这个筛选下没有收藏。</p>}
    {visibleRows.length > 0 && <ul className="release-list" aria-label="收藏清单，最近收藏的在前">{visibleRows.map(row)}</ul>}
    {waitingRows.length > 0 && <details className="release-reserved"><summary>尚未上線 {waitingRows.length} 部 · 已保留收藏，展開查看</summary><p>上線並確認可播放後，會自動回到上方清單。預計日期不代表已能播放。</p><ul className="release-list" aria-label="尚未上線的收藏">{waitingRows.map(row)}</ul></details>}
  </section>;
}
