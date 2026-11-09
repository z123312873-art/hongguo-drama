import { useEffect, useRef, useSyncExternalStore } from 'react';
import { readLocalLibrary, replaceLocalLibrary, subscribeLocalLibrary } from '../localLibrary';
import { markConfirmed, newCancels, planFavorites } from '../favoriteSync.mjs';

const CANCEL_KEY = 'hongguo:favorite-cancels:v1';
const REFRESH_MS = 5 * 60 * 1000;
const LOCAL = { mode: 'local' };
let current = LOCAL;
const listeners = new Set();

function publish(next) {
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
  } catch { /* retried on the next sync */ }
}

// Keeps this computer's favorites equal to the signed-in account's. Signed out, nothing is sent.
export default function useFavoriteSync(loggedIn) {
  const user = useRef('');
  const busy = useRef(false);
  const again = useRef(false);
  const applying = useRef(false);
  const timer = useRef(0);
  const before = useRef(readLocalLibrary().items);
  const live = useRef(loggedIn);
  live.current = loggedIn;

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
    try {
      const result = await api.cloudFavorites();
      if (!live.current) return;
      if (!result?.success || result.mode !== 'cloud' || !Array.isArray(result.rows)) {
        user.current = '';
        publish({ mode: 'local', error: result?.error || '' });
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
      if (plan.changed) {
        const written = apply(plan.items);
        if (written.error) errors.push(written.error);
      }
      for (const [ids, on] of [[plan.toAdd, true], [plan.toCancel, false]]) {
        for (const id of ids) {
          if (!live.current || user.current !== userId) return;
          let reply;
          try { reply = await api.cloudFavoriteSet(id, on); } catch (error) { reply = { success: false, error: error.message }; }
          if (!reply?.success) { errors.push(reply?.error || '手机收藏同步失败'); continue; }
          if (!on) { cancels = cancels.filter(item => item !== id); writeCancels(userId, cancels); }
          apply(markConfirmed(readLocalLibrary().items, id, userId, on));
        }
      }
      publish({ mode: 'cloud', userId, syncedAt: Date.now(), notice: plan.notice, error: errors[0] || '' });
    } catch (error) {
      publish({ mode: 'local', error: error.message || '手机收藏暂时读不到' });
    } finally {
      busy.current = false;
      if (again.current) { again.current = false; sync(); }
    }
  };

  // Changes made on this computer: remember cancellations of confirmed favorites, then sync soon.
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
    before.current = readLocalLibrary().items;
    if (!loggedIn) { user.current = ''; publish(LOCAL); return undefined; }
    sync();
    const interval = setInterval(sync, REFRESH_MS);
    let lastFocus = 0;
    const onFocus = () => { if (Date.now() - lastFocus > 30000) { lastFocus = Date.now(); sync(); } };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(interval); clearTimeout(timer.current); window.removeEventListener('focus', onFocus); };
  }, [loggedIn]);
}
