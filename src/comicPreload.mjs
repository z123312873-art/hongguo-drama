


export const INITIAL_PAGES = 4;
export const AHEAD_PAGES = 4;

export const NEXT_EPISODE_PAGES = 3;

export const DIRECT_FAILURES_BEFORE_SKIP = 3;





export function preloadWindow({ near = [], total = 0, initial = INITIAL_PAGES, ahead = AHEAD_PAGES } = {}) {
  const count = Math.max(0, Math.floor(Number(total)) || 0);
  if (!count) return { lo: 0, hi: -1 };
  const indexes = [...near].map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value < count);
  if (!indexes.length) return { lo: 0, hi: Math.min(count, Math.max(1, initial)) - 1 };
  return { lo: Math.min(...indexes), hi: Math.min(count - 1, Math.max(...indexes) + Math.max(0, ahead)) };
}

export function inWindow(index, window) {
  return index >= window.lo && index <= window.hi;
}


export function reachedEnd(window, total) {
  const count = Math.floor(Number(total)) || 0;
  return count > 0 && window.hi >= count - 1;
}


export function firstPictureUrls(chapter, count = NEXT_EPISODE_PAGES) {
  const list = Array.isArray(chapter?.pictures) ? chapter.pictures : [];
  return list.map((picture) => picture?.url).filter((url) => typeof url === 'string' && url).slice(0, Math.max(0, count));
}



export function createDirectHealth(limit = DIRECT_FAILURES_BEFORE_SKIP) {
  let failures = 0;
  let worked = false;
  return {
    noteLoaded() { worked = true; failures = 0; },
    noteFailed() { if (!worked) failures += 1; },
    skipDirect() { return !worked && failures >= limit; },
  };
}
