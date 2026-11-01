import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMIC_MAX, IMAGE_WIDTHS, clampPage, comicPageSize, desiredImageWidth, episodeGroups, groupIndexOf, nextImageWidth,
  pageCount, pageSlice, pagerNumbers, readerColumnWidth, skeletonCount,
} from '../../comicLayout.mjs';

// Window sizes the app is checked at: 1K (1920x1080), 2K (2560x1440), 4K (3840x2160) and smaller laptops.
const SCREENS = [
  { name: '1K', width: 1920, height: 1080, sidebarWidth: 220 },
  { name: '2K', width: 2560, height: 1440, sidebarWidth: 220 },
  { name: '4K', width: 3840, height: 2160, sidebarWidth: 220 },
  { name: 'laptop', width: 1366, height: 768, sidebarWidth: 220 },
  { name: 'small', width: 1100, height: 700, sidebarWidth: 220 },
];

test('every screen gets whole rows and at least two pages for the full 140 comics', () => {
  for (const screen of SCREENS) {
    const { columns, pageSize } = comicPageSize({ ...screen, reservedRows: 1 });
    assert.ok(columns >= 4, `${screen.name} columns ${columns}`);
    assert.equal(pageSize % columns, 0, `${screen.name} whole rows`);
    assert.ok(pageSize >= columns * 3 && pageSize <= columns * 4, `${screen.name} 3-4 rows`);
    assert.ok(pageCount(COMIC_MAX, pageSize) >= 2, `${screen.name} pages ${pageCount(COMIC_MAX, pageSize)}`);
  }
  const sizes = SCREENS.slice(0, 3).map(screen => comicPageSize({ ...screen, reservedRows: 1 }).pageSize);
  assert.ok(sizes[0] <= sizes[1] && sizes[1] <= sizes[2], `bigger screens never show fewer posters: ${sizes}`);
});

test('degenerate windows do not produce NaN or negative pages', () => {
  for (const bad of [{}, { width: 0, height: 0 }, { width: -5, height: 100 }, { width: NaN, height: NaN }, { width: 100, height: 100, sidebarWidth: 5000 }]) {
    const result = comicPageSize(bad);
    assert.ok(Number.isInteger(result.pageSize) && result.pageSize >= 0, JSON.stringify(bad));
    assert.ok(Number.isInteger(result.columns) && result.columns >= 0, JSON.stringify(bad));
  }
});

test('paging helpers cover empty, partial and out-of-range pages', () => {
  const items = Array.from({ length: 140 }, (_, i) => i);
  assert.equal(pageCount(140, 27), 6);
  assert.equal(pageCount(0, 27), 0);
  assert.equal(pageCount(10, 0), 0);
  assert.equal(pageSlice(items, 1, 27).length, 27);
  assert.equal(pageSlice(items, 6, 27).length, 5);
  assert.deepEqual(pageSlice(items, 99, 27), items.slice(135), 'clamped to the last page');
  assert.deepEqual(pageSlice(items, -3, 27), items.slice(0, 27));
  assert.deepEqual(pageSlice([], 1, 27), []);
  assert.deepEqual(pageSlice(null, 1, 27), []);
  assert.deepEqual(pageSlice(items, 1, 0), []);
  assert.equal(clampPage(9, 140, 27), 6);
  assert.equal(clampPage(0, 140, 27), 1);
  assert.equal(clampPage(3, 0, 27), 1);
  assert.deepEqual(pagerNumbers(1, 1), [1]);
  assert.deepEqual(pagerNumbers(1, 6), [1, 2, 6]);
  assert.deepEqual(pagerNumbers(4, 9), [1, 3, 4, 5, 9]);
  assert.deepEqual(pagerNumbers(1, 0), []);
});

test('placeholders fill only the page that is still waiting for posters', () => {
  assert.equal(skeletonCount({ loaded: 24, page: 1, pageSize: 27, expectedTotal: 140, pending: true }), 3, 'first page: 3 of 27 still missing');
  assert.equal(skeletonCount({ loaded: 140, page: 1, pageSize: 27, expectedTotal: 140, pending: false }), 0);
  assert.equal(skeletonCount({ loaded: 74, page: 1, pageSize: 27, expectedTotal: 140, pending: true }), 0, 'a full page needs none');
  assert.equal(skeletonCount({ loaded: 74, page: 3, pageSize: 27, expectedTotal: 140, pending: true }), 27 - 20);
  assert.equal(skeletonCount({ loaded: 0, page: 1, pageSize: 27, expectedTotal: 140, pending: true }), 27, 'nothing loaded yet: a full page of cells');
  assert.equal(skeletonCount({ loaded: 5, page: 1, pageSize: 0, expectedTotal: 140, pending: true }), 0);
  assert.equal(skeletonCount({ loaded: 5, page: 1, pageSize: 27, expectedTotal: 9999, pending: true }), 22, 'never more than one page of cells, never beyond 140');
});

test('the reader column and image width stay sensible from 1K to 4K at 100%, 125% and 200% scaling', () => {
  const widths = new Map();
  for (const viewport of [800, 1100, 1366, 1920, 2560, 3840]) {
    const column = readerColumnWidth(viewport);
    assert.ok(column >= 320 || column === viewport, `${viewport} column ${column}`);
    assert.ok(column <= viewport, `${viewport} column fits`);
    assert.ok(column <= 1032, `${viewport} column is a comfortable strip, not the whole screen`);
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const asked = desiredImageWidth(column, dpr);
      assert.ok(IMAGE_WIDTHS.includes(asked), `${viewport}@${dpr} asks for a published rendition`);
      assert.ok(asked >= Math.min(column * dpr, IMAGE_WIDTHS.at(-1)), `${viewport}@${dpr} never blurrier than the screen`);
      widths.set(`${viewport}@${dpr}`, asked);
    }
  }
  assert.equal(widths.get('1920@1'), 1080);
  assert.equal(widths.get('2560@1'), 1080);
  assert.equal(widths.get('3840@1'), 1080);
  assert.equal(widths.get('3840@2'), 1440, '4K at 200%: capped at the largest rendition');
  assert.equal(readerColumnWidth(0), 0);
  assert.equal(readerColumnWidth(NaN), 0);
  assert.equal(desiredImageWidth(0, 1), IMAGE_WIDTHS[0]);
  assert.equal(desiredImageWidth(NaN, NaN), IMAGE_WIDTHS[0]);
  assert.equal(desiredImageWidth(900, 0), 900);
  assert.equal(desiredImageWidth(900, 99), 1440, 'a bogus ratio is bounded');
  assert.equal(desiredImageWidth(5000, 1), 1440);
});

test('a resize only raises the requested rendition', () => {
  assert.equal(nextImageWidth(720, 1080), 1080);
  assert.equal(nextImageWidth(1080, 720), 1080);
  assert.equal(nextImageWidth(0, 720), 720);
  assert.equal(nextImageWidth(undefined, undefined), 0);
});

test('episode groups of fifty cover every episode exactly once', () => {
  assert.deepEqual(episodeGroups(0), []);
  assert.deepEqual(episodeGroups(1), [{ start: 1, end: 1 }]);
  assert.deepEqual(episodeGroups(50), [{ start: 1, end: 50 }]);
  assert.deepEqual(episodeGroups(51), [{ start: 1, end: 50 }, { start: 51, end: 51 }]);
  for (const total of [7, 49, 50, 99, 100, 217, 803, 2000]) {
    const groups = episodeGroups(total);
    const covered = groups.reduce((sum, group) => sum + group.end - group.start + 1, 0);
    assert.equal(covered, total);
    assert.equal(groups.at(-1).end, total);
    for (let i = 1; i < groups.length; i += 1) assert.equal(groups[i].start, groups[i - 1].end + 1);
  }
  assert.equal(groupIndexOf(120, episodeGroups(217)), 2);
  assert.equal(groupIndexOf(1, episodeGroups(217)), 0);
  assert.equal(groupIndexOf(999, episodeGroups(217)), 0, 'unknown position falls back to the first group');
  assert.deepEqual(episodeGroups('x'), []);
});
