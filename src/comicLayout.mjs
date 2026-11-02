import { alignedPageSize, posterColumns, posterSlots } from './catalogFill.mjs';
import { uiScale } from './uiScale.mjs';

export const COMIC_MAX = 140;
// Renditions the image CDN is asked for (kept in step with native/comic-api.js).
export const IMAGE_WIDTHS = Object.freeze([360, 540, 720, 900, 1080, 1440]);
const MIN_ROWS = 3;
const MAX_ROWS = 4;
const EPISODE_GROUP = 50;

// Poster page size from the window alone. Rows come from the window; the count is rounded up
// to whole source pages so the drama categories show the same number of posters on page one.
export function comicPageSize({ width, height, reservedRows = 0, sidebarWidth = 0 } = {}) {
  const viewport = Number(width);
  if (!(viewport > 0)) return { columns: 0, pageSize: 0 };
  const scale = uiScale(viewport);
  const boxWidth = Math.max(0, viewport - Math.max(0, Number(sidebarWidth) || 0) - 72);
  const boxHeight = Math.max(0, (Number(height) || 0) - 300);
  const minCard = 150 * scale;
  const columns = posterColumns({ width: boxWidth, minCard });
  if (!columns) return { columns: 0, pageSize: 0 };
  const fitted = posterSlots({ width: boxWidth, height: boxHeight, minCard, reservedRows }) / columns;
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round(fitted)));
  return { columns, pageSize: alignedPageSize(columns * rows) };
}

// Posters a drama list should open with: the comic page size, or the given minimum when that is larger.
export function firstPagePosters({ minimum = 0, ...window } = {}) {
  const { columns, pageSize } = comicPageSize(window);
  if (!columns) return { columns: 0, slots: 0 };
  const floor = Math.floor(Number(minimum));
  return { columns, slots: Math.max(pageSize, Number.isFinite(floor) && floor > 0 ? floor : 0) };
}

export function pageCount(total, pageSize) {
  const size = Math.floor(Number(pageSize));
  const count = Math.floor(Number(total));
  if (!(size > 0) || !(count > 0)) return 0;
  return Math.ceil(count / size);
}

export function pageSlice(items, page, pageSize) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.floor(Number(pageSize));
  if (!(size > 0)) return [];
  const pages = Math.max(1, pageCount(list.length, size));
  const current = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
  return list.slice((current - 1) * size, current * size);
}

export function clampPage(page, total, pageSize) {
  const pages = pageCount(total, pageSize);
  if (!pages) return 1;
  return Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
}

// Empty cells shown behind the loaded posters of the last known page while more are still arriving.
export function skeletonCount({ loaded, page, pageSize, expectedTotal, pending }) {
  if (!pending) return 0;
  const size = Math.floor(Number(pageSize));
  if (!(size > 0)) return 0;
  const target = Math.min(Math.max(Number(expectedTotal) || 0, Number(loaded) || 0), COMIC_MAX);
  const pagesKnown = Math.max(1, pageCount(target, size));
  if (page < pagesKnown && page * size <= loaded) return 0;
  return Math.max(0, Math.min(size, target - (page - 1) * size) - Math.max(0, loaded - (page - 1) * size));
}

// Reader column: wide enough to read, never wider than a comfortable strip, at every window size.
export function readerColumnWidth(viewportWidth) {
  const viewport = Number(viewportWidth);
  if (!(viewport > 0)) return 0;
  const scale = uiScale(viewport);
  return Math.round(Math.min(viewport, Math.max(320, Math.min(viewport * 0.92, 860 * scale))));
}

// Device pixels the picture will occupy, as a width to ask the CDN for.
export function desiredImageWidth(cssWidth, devicePixelRatio = 1) {
  const width = Number(cssWidth);
  const ratio = Number(devicePixelRatio);
  if (!(width > 0)) return IMAGE_WIDTHS[0];
  const dpr = ratio > 0 && Number.isFinite(ratio) ? Math.min(ratio, 3) : 1;
  const need = Math.ceil(width * dpr);
  return IMAGE_WIDTHS.find(step => step >= need) || IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1];
}

// Resizing only ever asks for a sharper rendition; shrinking keeps what is already on screen.
export function nextImageWidth(current, wanted) {
  const have = Number(current) || 0;
  const want = Number(wanted) || 0;
  return want > have ? want : have;
}

export function episodeGroups(total, size = EPISODE_GROUP) {
  const count = Math.floor(Number(total));
  const step = Math.max(1, Math.floor(Number(size)) || EPISODE_GROUP);
  if (!(count > 0)) return [];
  const groups = [];
  for (let start = 1; start <= count; start += step) groups.push({ start, end: Math.min(count, start + step - 1) });
  return groups;
}

export function groupIndexOf(position, groups) {
  const index = groups.findIndex(group => position >= group.start && position <= group.end);
  return index < 0 ? 0 : index;
}

export function pagerNumbers(current, total) {
  const pages = Math.floor(Number(total));
  if (!(pages > 0)) return [];
  const out = new Set([1, pages]);
  for (let i = current - 1; i <= current + 1; i += 1) if (i >= 1 && i <= pages) out.add(i);
  return [...out].sort((a, b) => a - b);
}
