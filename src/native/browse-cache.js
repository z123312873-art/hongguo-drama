





const fs = require('node:fs');
const path = require('node:path');

const FRESH_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const FALLBACK_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AUX_FRESH_MS = 6 * 60 * 60 * 1000;
const PERIODIC_MS = 30 * 60 * 1000;
const RECENT_USE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 120;
const MAX_ITEMS = 200;
const NETWORK_SLOTS = 4;
const PERIODIC_BATCH = 6;
const PERIODIC_GAP_MS = 2000;

function usableCover(value) {
  if (value === '') return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch (_) { return false; }
}

function validData(data) {
  return Boolean(data) && typeof data === 'object' && data.success === true && Array.isArray(data.results)
    && data.results.length > 0 && data.results.length <= MAX_ITEMS
    && data.results.every(item => item && typeof item.series_id === 'string' && typeof item.series_title === 'string'
      && typeof item.cover === 'string' && usableCover(item.cover));
}

function createBrowseCache({ now = Date.now, slots = NETWORK_SLOTS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let file = '';
  let saveTimer = null;
  let periodicTimer = null;
  const entries = new Map();
  const aux = new Map();
  const sources = new Map();
  const inflight = new Map();
  const waiting = { foreground: [], background: [] };
  let running = 0;

  const keyOf = (source, genre, page) => JSON.stringify([source, String(genre || ''), page]);

  function pump() {
    while (running < slots) {
      const next = waiting.foreground.shift() || waiting.background.shift();
      if (!next) return;
      running += 1;
      next().finally(() => { running -= 1; pump(); });
    }
  }

  function enqueue(task, background) {
    return new Promise((resolve, reject) => {
      const run = () => Promise.resolve().then(task).then(resolve, reject);
      (background ? waiting.background : waiting.foreground).push(run);
      pump();
    });
  }

  function save() {
    if (!file || saveTimer) return;
    saveTimer = setTimer(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries: [...entries.values()], aux: Object.fromEntries(aux) }));
        fs.renameSync(temporary, file);
      } catch (_) {                                                                              }
    }, 800);
    saveTimer.unref?.();
  }

  function trim() {
    if (entries.size <= MAX_ENTRIES) return;
    const oldest = [...entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, entries.size - MAX_ENTRIES);
    for (const [key] of oldest) entries.delete(key);
  }

  function configure({ file: target } = {}) {
    file = target || '';
    entries.clear();
    aux.clear();
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.version !== 1) return;
      const at = now();
      for (const entry of Array.isArray(data.entries) ? data.entries : []) {
        const page = Number(entry?.options?.page);
        if (!entry || typeof entry.source !== 'string' || !Number.isInteger(page) || page < 1 || page > 200
          || !Number.isFinite(entry.savedAt) || at - entry.savedAt > FALLBACK_AGE_MS || !validData(entry.data)) continue;
        const genre = typeof entry.options.genre === 'string' ? entry.options.genre.slice(0, 200) : '';
        entries.set(keyOf(entry.source, genre, page), { source: entry.source, options: { genre, page }, savedAt: entry.savedAt,
          usedAt: Number(entry.usedAt) || entry.savedAt, data: entry.data });
      }
      for (const [name, value] of Object.entries(data.aux && typeof data.aux === 'object' ? data.aux : {})) {
        if (Number.isFinite(value?.savedAt) && at - value.savedAt <= FALLBACK_AGE_MS && value.value !== undefined) aux.set(name, { savedAt: value.savedAt, value: value.value });
      }
      trim();
    } catch (_) {                                                              }
  }

  function store(source, genre, page, data) {
    if (!validData(data)) return false;
    const at = now();
    entries.set(keyOf(source, genre, page), { source, options: { genre: String(genre || ''), page }, savedAt: at, usedAt: at, data });
    trim();
    save();
    return true;
  }

  function fetchShared(source, genre, page, options, background) {
    const key = keyOf(source, genre, page);
    const running = inflight.get(key);
    if (running) return running;
    const fetcher = sources.get(source);
    const promise = enqueue(() => fetcher(options), background).then((data) => {
      store(source, genre, page, data);
      return data;
    }).finally(() => { inflight.delete(key); });
    inflight.set(key, promise);
    return promise;
  }

  function refreshInBackground(source, genre, page, options) {
    fetchShared(source, genre, page, options, true).catch(() => {});
  }


  function wrap(source, fetcher) {
    sources.set(source, fetcher);
    return async function cachedList(options = {}) {
      const request = options && typeof options === 'object' ? options : {};
      const page = Math.max(1, Number.parseInt(request.page, 10) || 1);
      const genre = String(request.genre || '');
      const key = keyOf(source, genre, page);
      const hit = entries.get(key);
      const age = hit ? now() - hit.savedAt : Infinity;
      if (hit && request.forceRefresh !== true && age <= MAX_AGE_MS) {
        hit.usedAt = now();
        if (age > FRESH_MS) refreshInBackground(source, genre, page, { genre, page });
        return { ...hit.data, fromCache: true, refreshing: age > FRESH_MS };
      }
      const data = await fetchShared(source, genre, page, request, false);
      if (data?.success !== true && hit && request.forceRefresh !== true) return { ...hit.data, fromCache: true, stale: true };
      return data;
    };
  }

  function getAux(name, maxAge = AUX_FRESH_MS) {
    const hit = aux.get(name);
    return hit && now() - hit.savedAt <= maxAge ? hit.value : undefined;
  }

  function setAux(name, value) {
    aux.set(name, { savedAt: now(), value });
    save();
  }


  async function refreshDue() {
    const at = now();
    const due = [...entries.values()].filter(entry => sources.has(entry.source) && at - entry.savedAt > FRESH_MS
      && at - entry.usedAt <= RECENT_USE_MS).sort((a, b) => a.savedAt - b.savedAt).slice(0, PERIODIC_BATCH);
    for (const entry of due) {
      try { await fetchShared(entry.source, entry.options.genre, entry.options.page, { ...entry.options }, true); } catch (_) {                              }
      await new Promise(resolve => { setTimer(resolve, PERIODIC_GAP_MS); });
    }
    return due.length;
  }

  function startPeriodicRefresh() {
    if (periodicTimer) return;
    const tick = () => {
      periodicTimer = setTimer(() => { refreshDue().catch(() => {}).finally(tick); }, PERIODIC_MS);
      periodicTimer.unref?.();
    };
    tick();
  }

  function stopPeriodicRefresh() {
    if (periodicTimer) clearTimer(periodicTimer);
    periodicTimer = null;
  }

  return { configure, wrap, getAux, setAux, refreshDue, startPeriodicRefresh, stopPeriodicRefresh,
    snapshot: () => ({ entries: entries.size, inflight: inflight.size, running, queued: waiting.foreground.length + waiting.background.length }) };
}

const shared = createBrowseCache();

module.exports = { createBrowseCache, shared, FRESH_MS, MAX_AGE_MS };
