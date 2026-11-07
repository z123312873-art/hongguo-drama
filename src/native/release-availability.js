const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function taipeiDay(ms) {
  const shifted = new Date(Number(ms) + TAIPEI_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return '';
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

function createReleaseCache(now = Date.now()) {
  return { day: taipeiDay(now), entries: new Map() };
}

function rememberRelease(cache, id, playable, now = Date.now()) {
  const day = taipeiDay(now);
  if (!cache || cache.day !== day) {
    cache = { day, entries: new Map() };
  }
  cache.entries.set(String(id), playable === true ? true : playable === 'error' ? 'error' : false);
  return cache;
}

function readRelease(cache, id, now = Date.now()) {
  if (!cache || cache.day !== taipeiDay(now)) return undefined;
  const value = cache.entries.get(String(id));
  if (value === undefined) return undefined;
  return value === true || value === 'error' ? value : false;
}

function confirmedOffline(error) {
  return /未获取到剧集数据|分集列表为空|官网页面未找到分集数据/.test(String(error?.message || ''));
}

function visibleUpcoming(items, { now = Date.now(), gone = new Set() } = {}) {
  const today = taipeiDay(now);
  return (items || []).filter(item => {
    const id = String(item?.series_id || item?.id || '');
    if (!id || gone.has(id)) return false;
    const day = taipeiDay(item?.online_time);
    // A date before today stays off the wall. A failed check is not proof the show launched.
    if (day && today && day < today) return false;
    return true;
  });
}

function releaseProbeIds(items, now = Date.now()) {
  const today = taipeiDay(now);
  return dueReleaseIds(items, now).filter(id => {
    const item = (items || []).find(row => String(row?.series_id || row?.id || '') === id);
    return Boolean(item) && taipeiDay(item.online_time) === today;
  });
}

function dueReleaseIds(items, now = Date.now()) {
  const moment = Number(now);
  const ids = [];
  const seen = new Set();
  for (const item of items || []) {
    const time = Number(item?.online_time);
    const id = String(item?.series_id || item?.id || '').trim();
    if (!id || seen.has(id) || !Number.isFinite(time) || time <= 0 || time > moment) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function createReleaseProbe({ lookup, now = () => Date.now() }) {
  let cache = createReleaseCache(now());
  const inflight = new Map();
  return {
    known(id) {
      return readRelease(cache, id, now());
    },
    ask(id) {
      const moment = now();
      if (cache.day !== taipeiDay(moment)) cache = createReleaseCache(moment);
      const known = readRelease(cache, id, moment);
      if (known !== undefined) return Promise.resolve(known);
      const key = String(id);
      if (!inflight.has(key)) {
        const pending = Promise.resolve()
          .then(() => lookup(key))
          .then(playable => {
            const state = playable === true ? true : playable === 'error' ? 'error' : false;
            cache = rememberRelease(cache, key, state, now());
            return state;
          })
          .catch(() => {
            cache = rememberRelease(cache, key, 'error', now());
            return 'error';
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      return inflight.get(key);
    },
  };
}

function scheduleReleaseDrops({ ask, shouldStop = () => false, onPlayable, onUnavailable, onUnknown }) {
  const queue = [];
  const seen = new Set();
  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        if (shouldStop()) return;
        const id = queue.shift();
        const playable = await ask(id);
        if (shouldStop()) return;
        if (playable === true) onPlayable(id);
        else if (playable === false) onUnavailable?.(id);
        else onUnknown?.(id);
      }
    } finally {
      running = false;
      if (queue.length && !shouldStop()) void pump();
    }
  };
  return {
    push(ids) {
      for (const id of ids || []) {
        const key = String(id || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        queue.push(key);
      }
      void pump();
    },
  };
}

module.exports = {
  taipeiDay,
  createReleaseCache,
  rememberRelease,
  readRelease,
  dueReleaseIds,
  confirmedOffline,
  visibleUpcoming,
  releaseProbeIds,
  createReleaseProbe,
  scheduleReleaseDrops,
};
