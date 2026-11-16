import assert from 'node:assert/strict';
import test from 'node:test';
import { itemPageWindow, matchedPageSize, MATCHED_PAGE_LIMIT } from '../../catalogFill.mjs';

test('the matched page size follows the 红果 grid and stays bounded', () => {
  assert.equal(matchedPageSize(24), 24);
  assert.equal(matchedPageSize(40), 48);
  assert.equal(matchedPageSize(48), 48);
  assert.equal(matchedPageSize(500), MATCHED_PAGE_LIMIT);
  for (const value of [0, -3, NaN, undefined, null, 'x']) assert.equal(matchedPageSize(value), 0);
});

test('item windows cover each poster exactly once across pages', () => {
  const seen = [];
  for (let page = 1; page <= 7; page += 1) {
    const plan = itemPageWindow(page, 24, 10, 16);
    const items = [];
    for (let source = plan.start; source < plan.start + plan.count; source += 1) for (let i = 0; i < 10; i += 1) items.push((source - 1) * 10 + i);
    seen.push(...items.slice(plan.skip, plan.skip + plan.take));
  }
  assert.deepEqual(seen, Array.from({ length: 160 }, (_, i) => i));
  assert.deepEqual(itemPageWindow(1, 24, 10, 16), { page: 1, start: 1, count: 3, skip: 0, take: 24, uiPages: 7 });
  assert.deepEqual(itemPageWindow(2, 24, 10, 16), { page: 2, start: 3, count: 3, skip: 4, take: 24, uiPages: 7 });
});

test('page numbers are clamped and unusable inputs give no window', () => {
  assert.equal(itemPageWindow(99, 24, 10, 16).page, 7);
  assert.equal(itemPageWindow(0, 24, 10, 16).page, 1);
  assert.equal(itemPageWindow('2', 24, 10, 16).page, 2);
  assert.deepEqual(itemPageWindow(1, 48, 10, 1), { page: 1, start: 1, count: 1, skip: 0, take: 48, uiPages: 1 });
  for (const args of [[1, 0, 10, 5], [1, 24, 0, 5], [1, 24, 10, 0], [1, NaN, 10, 5], [1, 24, undefined, 5]]) assert.equal(itemPageWindow(...args), null);
});
