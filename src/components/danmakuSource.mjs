

















import { useEffect, useState } from 'react';
import { DEFAULT_DANMAKU_SOURCE, normalizeDanmakuSource } from './danmakuOfficial.mjs';

const STORAGE_KEY = 'hongguo:danmaku-source:v1';

const CHANGE_EVENT = 'hongguo:danmaku-source-change';

const storage = () => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

export function readDanmakuSource() {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    return raw === null || raw === undefined ? DEFAULT_DANMAKU_SOURCE : normalizeDanmakuSource(JSON.parse(raw));
  } catch {
    return DEFAULT_DANMAKU_SOURCE;
  }
}

export function writeDanmakuSource(value) {
  const next = normalizeDanmakuSource(value);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {

  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  return next;
}

export function useDanmakuSource() {
  const [source, setSource] = useState(readDanmakuSource);
  useEffect(() => {
    const sync = event => setSource(normalizeDanmakuSource(event?.detail));
    const syncStorage = event => {
      if (event.key === STORAGE_KEY) setSource(readDanmakuSource());
    };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);
  return source;
}

export { STORAGE_KEY, CHANGE_EVENT };
