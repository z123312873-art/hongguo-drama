// How many source pages to join so the current window's poster grid can fill.
// A short page stays one page. Extra pages stop at the visible slots, and never past four.
const MAX_SOURCE_PAGES = 4;

export function posterSlots({ width, height, minCard = 150, gapX = 20, gapY = 26, textHeight = 78 } = {}) {
  const boxWidth = Number(width);
  const boxHeight = Number(height);
  const card = Number(minCard);
  if (!(boxWidth >= card) || !(boxHeight > 0) || !(card > 0)) return 0;
  const columns = Math.max(1, Math.floor((boxWidth + gapX) / (card + gapX)));
  const cardWidth = (boxWidth - gapX * (columns - 1)) / columns;
  const cardHeight = cardWidth * 4 / 3 + textHeight;
  const rows = Math.max(1, Math.floor((boxHeight + gapY) / (cardHeight + gapY)));
  return columns * rows;
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
