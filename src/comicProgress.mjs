

const KEY = 'comic-progress:v1';
const MAX_COMICS = 200;
const MAX_EPISODES = 600;
const ID = /^\d{6,30}$/;

function readAll(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

export function readProgress(storage, seriesId) {
  const entry = readAll(storage)[String(seriesId)];
  const read = Array.isArray(entry?.read) ? entry.read.filter(id => ID.test(String(id))).map(String) : [];
  const last = ID.test(String(entry?.last)) ? String(entry.last) : '';
  return { read: new Set(read), last };
}

export function markRead(storage, seriesId, itemId, now = Date.now()) {
  const series = String(seriesId);
  const item = String(itemId);
  if (!ID.test(series) || !ID.test(item)) return false;
  const all = readAll(storage);
  const entry = all[series] || {};
  const read = Array.isArray(entry.read) ? entry.read.map(String).filter(id => id !== item) : [];
  read.push(item);
  all[series] = { read: read.slice(-MAX_EPISODES), last: item, at: now };
  const keys = Object.keys(all);
  if (keys.length > MAX_COMICS) {
    keys.sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0));
    for (const key of keys.slice(0, keys.length - MAX_COMICS)) delete all[key];
  }
  try { storage.setItem(KEY, JSON.stringify(all)); return true; } catch (_) { return false; }
}


export function neighbours(episodes, itemId) {
  const list = Array.isArray(episodes) ? episodes : [];
  const at = list.findIndex(entry => String(entry?.itemId) === String(itemId));
  if (at < 0) return { previous: null, next: null, position: 0 };
  return { previous: list[at - 1] || null, next: list[at + 1] || null, position: at + 1 };
}
