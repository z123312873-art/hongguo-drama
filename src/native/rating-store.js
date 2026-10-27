'use strict';

const fs = require('node:fs');
const path = require('node:path');

function ratingValue(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 10) return undefined;
  return Math.round(number * 10) / 10;
}

function createRatingStore(options = {}) {
  const ttl = options.ttl || 6 * 60 * 60 * 1000;
  const maxEntries = options.maxEntries || 500;
  const now = options.now || Date.now;
  const memory = new Map();
  let file = options.file || '';
  let dirty = false;

  function remember(id, rating, expires) {
    memory.delete(id);
    memory.set(id, { rating, expires });
    while (memory.size > maxEntries) memory.delete(memory.keys().next().value);
  }

  function load(filePath) {
    file = filePath || file;
    memory.clear();
    dirty = false;
    if (!file) return;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') dirty = false; return; }
    let data;
    try { data = JSON.parse(raw); }
    catch { return; }
    const entries = data?.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return;
    const time = now();
    for (const [id, entry] of Object.entries(entries)) {
      if (!/^\d{6,30}$/.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const expires = Number(entry.expires);
      if (!Number.isFinite(expires) || expires <= time) continue;
      const rating = ratingValue(entry.rating);
      if (rating === undefined) continue;
      remember(id, rating, expires);
    }
  }

  function save() {
    if (!file || !dirty) return;
    const time = now();
    const entries = {};
    for (const [id, entry] of memory) {
      if (entry.expires <= time) continue;
      entries[id] = { rating: entry.rating, expires: entry.expires };
    }
    const body = JSON.stringify({ version: 1, entries });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      dirty = false;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* the next confirmed score tries again */ }
    }
  }

  if (file) load(file);

  return {
    load,
    get(id) {
      const entry = memory.get(String(id || ''));
      if (!entry) return undefined;
      if (entry.expires <= now()) {
        memory.delete(String(id));
        return undefined;
      }
      return entry.rating;
    },
    set(id, rating) {
      const key = String(id || '');
      if (!/^\d{6,30}$/.test(key)) return false;
      const value = ratingValue(rating);
      if (value === undefined) return false;
      remember(key, value, now() + ttl);
      dirty = true;
      return true;
    },
    save,
  };
}

module.exports = { createRatingStore };
