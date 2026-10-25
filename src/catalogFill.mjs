// How many source pages to join so the current window's poster grid can fill.
// A short page stays one page. Extra pages stop at the visible slots, and never past four.
const MAX_SOURCE_PAGES = 4;

export function posterColumns({ width, minCard = 150, gapX = 20 } = {}) {
  const boxWidth = Number(width);
  const card = Number(minCard);
  if (!(boxWidth >= card) || !(card > 0)) return 0;
  return Math.max(1, Math.floor((boxWidth + gapX) / (card + gapX)));
}

export function posterSlots({ width, height, minCard = 150, gapX = 20, gapY = 26, textHeight = 78, reservedRows = 0 } = {}) {
  const columns = posterColumns({ width, minCard, gapX });
  const boxWidth = Number(width);
  const boxHeight = Number(height);
  if (!columns || !(boxHeight > 0)) return 0;
  const cardWidth = (boxWidth - gapX * (columns - 1)) / columns;
  const cardHeight = cardWidth * 4 / 3 + textHeight;
  const fitted = Math.max(1, Math.floor((boxHeight + gapY) / (cardHeight + gapY)));
  const reserve = Number(reservedRows);
  const hold = Number.isFinite(reserve) && reserve > 0 ? Math.floor(reserve) : 0;
  // A banner can reserve rows, but a short window still keeps one row of posters.
  const rows = Math.max(1, fitted - hold);
  return columns * rows;
}

// Genre chips and category rows appear after the first paint. One extra row keeps a
// near-full window from collapsing back to a single source page on refresh.
export function cushionedSlots(slots, columns) {
  const need = Number(slots);
  const cols = Math.floor(Number(columns));
  if (!Number.isFinite(need) || need < 1) return 0;
  if (!Number.isFinite(cols) || cols < 1) return Math.floor(need);
  return Math.floor(need) + cols;
}

// Ignore scrollbar and sub-pixel noise. A real resize still starts over.
export function sameCatalogWindow(previousWidth, nextWidth, tolerance = 80) {
  const previous = Number(previousWidth);
  const next = Number(nextWidth);
  if (!(previous > 0) || !(next > 0)) return false;
  return Math.abs(previous - next) < tolerance;
}

export function pagesToFill(slots, pageCount, totalPages) {
  const count = Number(pageCount);
  const pages = Number(totalPages);
  const need = Number(slots);
  if (!Number.isFinite(count) || count < 1) return 1;
  if (!Number.isFinite(need) || need <= count) return 1;
  if (!Number.isFinite(pages) || pages < 2) return 1;
  return Math.min(pages, MAX_SOURCE_PAGES, Math.max(1, Math.ceil(need / count)));
}

export function sourcePageWindow(uiPage, span, totalSourcePages) {
  const page = Math.max(1, Number.parseInt(uiPage, 10) || 1);
  const width = Math.max(1, Number.parseInt(span, 10) || 1);
  const total = Math.max(1, Number.parseInt(totalSourcePages, 10) || 1);
  const start = (page - 1) * width + 1;
  const count = Math.max(0, Math.min(width, total - start + 1));
  return { start, count, uiPages: Math.max(1, Math.ceil(total / width)) };
}
