import { useEffect, useRef, useSyncExternalStore } from 'react';
import { readLocalLibrary, replaceLocalLibrary, subscribeLocalLibrary } from '../localLibrary';
import { markConfirmed, newCancels, planFavorites } from '../favoriteSync.mjs';

const CANCEL_KEY = 'hongguo:favorite-cancels:v1';
const REFRESH_MS = 5 * 60 * 1000;
const LOCAL = { mode: 'local' };
const FOLDER_KEY = 'hongguo:favorite-folders:v1';
const SYNC_ERROR = '手機收藏暫時無法同步，這臺電腦的收藏仍會保留。請稍後重試。';
let current = LOCAL;
let folderVersion = 0;
let folderAction = null;
let folderRefresh = null;
const listeners = new Set();

function publish(next) {
  if (next.userId !== current.userId || (next.mode !== 'cloud' && current.mode === 'cloud')) folderVersion++;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeFavoriteSync(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const favoriteSyncStatus = () => current;
export function useFavoriteSyncStatus() {
  return useSyncExternalStore(subscribeFavoriteSync, favoriteSyncStatus, favoriteSyncStatus);
}

function readCancels(userId) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CANCEL_KEY) || 'null');
    return saved?.userId === userId && Array.isArray(saved.ids) ? saved.ids.filter(id => typeof id === 'string' && /^\d{6,25}$/.test(id)) : [];
  } catch { return []; }
}
function writeCancels(userId, ids) {
  try {
    if (ids.length) window.localStorage.setItem(CANCEL_KEY, JSON.stringify({ userId, ids: [...new Set(ids)].slice(0, 500) }));
    else window.localStorage.removeItem(CANCEL_KEY);
  } catch {                                }
}

function cachedFolders(userId, incoming) {
  if (!userId) return [];
  let saved;
  try { saved = JSON.parse(window.localStorage.getItem(FOLDER_KEY) || 'null'); } catch {}
  const previous = saved?.userId === userId && Array.isArray(saved.folders) ? saved.folders : [];
  const valid = folders => folders.filter(folder => typeof folder?.id === 'string' && /^\d{6,25}$/.test(folder.id) && typeof folder.name === 'string' && Array.isArray(folder.itemIds) && folder.itemIds.every(id => typeof id === 'string' && /^\d{6,25}$/.test(id)));
  if (Array.isArray(incoming)) {
    const folders = valid(incoming);
    if (folders.length !== incoming.length) return valid(previous);
    try { window.localStorage.setItem(FOLDER_KEY, JSON.stringify({ userId, folders })); } catch {}
    return folders;
  }
  return valid(previous);
}

const FOLDER_ERROR = '收藏夾暫時無法更新，已保留原有資料。請重新整理後重試。';
function folderFailure(result) {
  const text = result?.error;
  return typeof text === 'string' && text.length <= 140 && !/(?:CODE|HTTP|Error|[_A-Z]{3,}|https?:|\d{5})/.test(text) ? text : FOLDER_ERROR;
}
const ACCOUNT_ERROR = '帳號已變更或登入已過期，請重新登入後再操作。';
export async function refreshFavoriteFolders() {
  const userId = current.userId;
  if (!userId || typeof window.electronAPI?.cloudFolderList !== 'function') return { success: false, error: ACCOUNT_ERROR };
  if (folderAction || folderRefresh) return { success: false, error: '收藏夾正在更新，請稍候。' };
  const action = {};
  folderRefresh = action;
  const version = ++folderVersion;
  publish({ ...current, folderBusy: true, folderNotice: '正在重新整理收藏夾…' });
  try {
    const result = await window.electronAPI.cloudFolderList(userId);
    if (version !== folderVersion || userId !== current.userId) return { success: false, error: ACCOUNT_ERROR };
    if (!result?.success || String(result.userId) !== userId || !Array.isArray(result.folders)) throw new Error('UNCONFIRMED');
    const folders = cachedFolders(userId, result.folders);
    publish({ ...current, folders, foldersStale: false, foldersError: '', folderNoticeId: version, folderNoticeUntil: Date.now() + 3200, folderNotice: `收藏夾已重新整理，共 ${folders.length} 個。` });
    return { success: true, folders };
  } catch {
    if (version === folderVersion && userId === current.userId) publish({ ...current, foldersError: FOLDER_ERROR, foldersStale: true, folderNotice: '' });
    return { success: false, error: FOLDER_ERROR };
  } finally {
    if (folderRefresh === action) folderRefresh = null;
    if (!folderAction && !folderRefresh && current.folderBusy) publish({ ...current, folderBusy: false });
  }
}
export async function changeFavoriteFolder(input) {
  const userId = current.userId;
  if (!userId || current.mode !== 'cloud' || typeof window.electronAPI?.cloudFolderChange !== 'function') return { success: false, error: ACCOUNT_ERROR };
  if (window.navigator?.onLine === false) return { success: false, error: '目前離線，收藏夾未變更。連線後請重新整理再操作。' };
  if (folderAction || folderRefresh) return { success: false, error: '收藏夾正在更新，請稍候。' };
  const action = {};
  folderAction = action;
  const version = ++folderVersion;
  publish({ ...current, folderBusy: true, folderNotice: '' });
  try {
    const result = await window.electronAPI.cloudFolderChange({ ...input, userId });
    if (version !== folderVersion || userId !== current.userId || current.mode !== 'cloud') return { success: false, error: ACCOUNT_ERROR };
    if (!result?.success || String(result.userId) !== userId || !Array.isArray(result.folders)) return { success: false, uncertain: result?.uncertain === true, error: folderFailure(result) };
    const folders = cachedFolders(userId, result.folders);
    const notice = { create: '收藏夾已新增並同步到手機。', rename: '收藏夾已改名並同步到手機。', delete: '收藏夾已刪除，手機收藏與影片不受影響。', add: '已加入收藏夾並同步到手機。', remove: '已從收藏夾移除，仍保留在全部收藏。' }[input.operation];
    publish({ ...current, folders, foldersError: '', foldersStale: false, folderNoticeId: version, folderNoticeUntil: Date.now() + 3200, folderNotice: notice || '', folderBusy: false });
    return { success: true, folderId: result.folderId, deletedId: result.deletedId || '' };
  } catch {
    return { success: false, uncertain: true, error: FOLDER_ERROR };
  } finally {
    if (folderAction === action) folderAction = null;
    if (!folderAction && !folderRefresh && current.folderBusy) publish({ ...current, folderBusy: false });
  }
}

export default function useFavoriteSync(loggedIn) {
  const user = useRef('');
  const busy = useRef(false);
  const again = useRef(false);
  const applying = useRef(false);
  const timer = useRef(0);
  const before = useRef(readLocalLibrary().items);
  const live = useRef(loggedIn);
  live.current = loggedIn;
  const epoch = useRef(0);

  const apply = (items) => {
    applying.current = true;
    let result;
    try { result = replaceLocalLibrary(items); } finally { applying.current = false; }
    before.current = readLocalLibrary().items;
    return result;
  };

  const sync = async () => {
    const api = window.electronAPI;
    if (!live.current || typeof api?.cloudFavorites !== 'function') { user.current = ''; publish(LOCAL); return; }
    if (busy.current) { again.current = true; return; }
    busy.current = true;
    const version = epoch.current;
    const folderReadVersion = folderVersion;
    const valid = () => live.current && version === epoch.current;
    try {
      const result = await api.cloudFavorites();
      if (!valid()) return;
      if (!result?.success || result.mode !== 'cloud' || !Array.isArray(result.rows)) {
        user.current = String(result?.userId || '');
        publish({ mode: 'local', userId: user.current, folders: cachedFolders(user.current), error: result?.error ? SYNC_ERROR : '' });
        return;
      }
      const userId = String(result.userId || '');
      user.current = userId;
      const library = readLocalLibrary();
      if (library.error) { publish({ mode: 'local', error: library.error }); return; }
      const plan = planFavorites({ items: library.items, cloud: result.rows, userId, cancels: readCancels(userId) });
      let cancels = plan.cancels;
      writeCancels(userId, cancels);
      const errors = [];
      let deferredNotice = '';
      if (plan.changed) {
        const written = apply(plan.items);
        if (written.error) errors.push(written.error);
      }
      for (const [ids, on] of [[plan.toAdd, true], [plan.toCancel, false]]) {
        for (const id of ids) {
          if (!valid() || user.current !== userId) return;
          let reply;
          try { reply = await api.cloudFavoriteSet(id, on, userId); } catch (error) { reply = { success: false, error: error.message }; }
          if (!valid() || (reply?.userId && String(reply.userId) !== userId)) return;
          if (reply?.deferred) { deferredNotice = '部分影片尚無法加入手機收藏，已先保留在這臺電腦；可播放後會再同步。'; continue; }
          if (!reply?.success) { errors.push(reply?.error || '手机收藏同步失败'); continue; }
          if (!on) { cancels = cancels.filter(item => item !== id); writeCancels(userId, cancels); }
          const latest = readLocalLibrary().items;
          if (on && !latest.some(item => item.id === id && item.favorite)) {
            cancels = [...new Set([...cancels, id])];
            writeCancels(userId, cancels);
            again.current = true;
          }
          apply(markConfirmed(latest, id, userId, on));
        }
      }
      const freshFolders = folderReadVersion === folderVersion;
      const confirmedFolders = freshFolders && !result.foldersError && Array.isArray(result.folders);
      const folders = confirmedFolders ? cachedFolders(userId, result.folders) : (current.userId === userId ? current.folders || [] : cachedFolders(userId));
      const foldersStale = freshFolders ? !confirmedFolders : current.foldersStale;
      publish({ mode: 'cloud', userId, syncedAt: Date.now(), folders, foldersStale, foldersError: freshFolders ? result.foldersError || (foldersStale ? FOLDER_ERROR : '') : current.foldersError, folderBusy: Boolean(folderAction || folderRefresh), folderNoticeId: current.userId === userId ? current.folderNoticeId : 0, folderNoticeUntil: current.userId === userId ? current.folderNoticeUntil : 0, folderNotice: current.userId === userId ? current.folderNotice : '', notice: deferredNotice || plan.notice, error: errors.length ? SYNC_ERROR : '' });
    } catch (error) {
      if (valid()) publish({ mode: 'local', userId: user.current, folders: cachedFolders(user.current), error: SYNC_ERROR });
    } finally {
      busy.current = false;
      if (again.current) { again.current = false; sync(); }
    }
  };


  useEffect(() => subscribeLocalLibrary(library => {
    if (applying.current) return;
    const previous = before.current;
    before.current = library.items;
    if (!live.current || !user.current || library.error) return;
    const cancelled = newCancels(previous, library.items, user.current);
    if (cancelled.length) writeCancels(user.current, [...readCancels(user.current), ...cancelled]);
    clearTimeout(timer.current);
    timer.current = setTimeout(sync, 1500);
  }), []);

  useEffect(() => {
    epoch.current++;
    before.current = readLocalLibrary().items;
    if (!loggedIn) { user.current = ''; publish(LOCAL); return undefined; }
    sync();
    const interval = setInterval(sync, REFRESH_MS);
    let lastFocus = 0;
    const onFocus = () => { if (Date.now() - lastFocus > 30000) { lastFocus = Date.now(); sync(); } };
    window.addEventListener('focus', onFocus);
    return () => { epoch.current++; live.current = false; clearInterval(interval); clearTimeout(timer.current); window.removeEventListener('focus', onFocus); };
  }, [loggedIn]);
}
