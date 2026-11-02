// Look-ahead rules for the comic reader. Nothing here touches the DOM, so every rule can be checked on its own.

// Pages that load before anything has been scrolled, and how many pages past the last one in view keep loading.
export const INITIAL_PAGES = 4;
export const AHEAD_PAGES = 4;
// Pages of the next episode fetched while the reader nears the end of this one.
export const NEXT_EPISODE_PAGES = 3;
// Direct requests that fail before the reader stops trying them and goes straight to the decrypted copy.
export const DIRECT_FAILURES_BEFORE_SKIP = 3;

/**
 * The span of pages that should be loading: from the first page near the viewport to a few pages past the last one.
 * `near` holds the indexes of pages inside the margin around the viewport. Before any is known the first pages load.
 */
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

// The next episode is worth warming once every page of this one is already being fetched.
export function reachedEnd(window, total) {
  const count = Math.floor(Number(total)) || 0;
  return count > 0 && window.hi >= count - 1;
}

// The first few pictures of an episode, in reading order, as plain URLs.
export function firstPictureUrls(chapter, count = NEXT_EPISODE_PAGES) {
  const list = Array.isArray(chapter?.pictures) ? chapter.pictures : [];
  return list.map((picture) => picture?.url).filter((url) => typeof url === 'string' && url).slice(0, Math.max(0, count));
}

// Tracks whether the public image host answers at all for this reader. After a run of failures with no success
// the signed, decrypted copy is requested directly, which saves one failed round trip per page.
export function createDirectHealth(limit = DIRECT_FAILURES_BEFORE_SKIP) {
  let failures = 0;
  let worked = false;
  return {
    noteLoaded() { worked = true; failures = 0; },
    noteFailed() { if (!worked) failures += 1; },
    skipDirect() { return !worked && failures >= limit; },
  };
}
