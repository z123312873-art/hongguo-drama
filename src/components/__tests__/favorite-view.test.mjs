import test from 'node:test';
import assert from 'node:assert/strict';
import { favoriteView, categoryFromBrowse, isWaiting, favoriteCategory } from '../../favoriteView.mjs';

const NOW = 1_800_000_000_000;
const fav = (id, extra = {}) => ({ id, title: `剧${id}`, favorite: true, favorited_at: NOW - Number(id) * 1000, online_time: null, category: '', ...extra });

test('one list, newest favorite first; undated ones last by title; un-favorited rows are not listed', () => {
  const items = [fav('3'), fav('1'), fav('2'), fav('9', { favorited_at: null, title: '乙' }), fav('8', { favorited_at: null, title: '甲' }), fav('5', { favorite: false })];
  const view = favoriteView(items, { now: NOW });
  assert.deepEqual(view.rows.map(row => row.id), ['1', '2', '3', '8', '9']);
  assert.equal(view.total, 5);
  assert.equal(view.filter, 'all');
});

test('favorites across many months stay in the same list (no month paging)', () => {
  const months = Array.from({ length: 14 }, (_, i) => fav(String(100 + i), { favorited_at: Date.UTC(2025, i, 15) }));
  const view = favoriteView(months, { now: NOW });
  assert.equal(view.rows.length, 14);
  assert.equal(view.rows[0].id, '113');
  assert.equal(view.rows.at(-1).id, '100');
});

test('playable and not-yet-online split; online by date but unconfirmed still waits', () => {
  const items = [fav('1'), fav('2', { online_time: NOW + 86_400_000 }), fav('3', { online_time: NOW - 1000 }), fav('4', { online_time: NOW - 1000 })];
  const released = { 4: true };
  assert.deepEqual(favoriteView(items, { filter: 'waiting', now: NOW, released }).rows.map(r => r.id), ['2', '3']);
  assert.deepEqual(favoriteView(items, { filter: 'playable', now: NOW, released }).rows.map(r => r.id), ['1', '4']);
  assert.equal(isWaiting({ id: '9', online_time: 0 }, NOW), false);
  assert.equal(isWaiting({ id: '9', online_time: 'x' }, NOW), false);
});

test('all category buttons remain visible, including an empty comic filter', () => {
  const items = [fav('1', { category: 'real' }), fav('2', { category: 'ai' }), fav('3', { category: 'ai' }), fav('4', { category: 'bogus' })];
  const view = favoriteView(items, { filter: 'ai', now: NOW });
  assert.deepEqual(view.filters.map(f => [f.id, f.count]), [['all', 4], ['playable', 4], ['waiting', 0], ['real', 1], ['comic', 0], ['ai', 2]]);
  assert.deepEqual(view.rows.map(r => r.id), ['2', '3']);
  const gone = favoriteView(items, { filter: 'comic', now: NOW });
  assert.equal(gone.filter, 'comic');
  assert.equal(gone.rows.length, 0);
  assert.equal(favoriteView(items, { filter: 'nonsense', now: NOW }).filter, 'all');
});

test('empty and bad input', () => {
  for (const input of [[], null, undefined, [null, { favorite: false }]]) {
    const view = favoriteView(input, { now: NOW });
    assert.deepEqual(view.rows, []);
    assert.equal(view.total, 0);
    assert.deepEqual(view.filters.map(f => f.id), ['all', 'playable', 'waiting', 'real', 'comic', 'ai']);
  }
});

test('category from the discover section', () => {
  assert.equal(categoryFromBrowse('real-drama'), 'real');
  assert.equal(categoryFromBrowse('hot-real-drama'), 'real');
  assert.equal(categoryFromBrowse('ai-drama'), 'ai');
  assert.equal(categoryFromBrowse('hot-ai-drama'), 'ai');
  assert.equal(categoryFromBrowse('comic-drama'), 'comic');
  assert.equal(categoryFromBrowse('hot-drama'), '', 'the mixed chart has no single category');
  assert.equal(categoryFromBrowse(''), '');
  assert.equal(categoryFromBrowse(undefined), '');
  assert.equal(favoriteCategory('ai'), 'ai');
  assert.equal(favoriteCategory('AI'), '');
});

test('folder membership intersects every category and changes counts immediately after removal', () => {
  const items = [
    { id: 'a', title: 'A', favorite: true, category: 'comic', favorited_at: 1 },
    { id: 'b', title: 'B', favorite: true, category: 'ai', favorited_at: 2 },
    { id: 'c', title: 'C', favorite: true, category: 'real', favorited_at: 3 },
  ];
  const view = favoriteView(items, { folderIds: ['a', 'b'] });
  assert.deepEqual(view.rows.map(item => item.id), ['b', 'a']);
  assert.equal(view.total, 2);
  assert.equal(view.filters.find(item => item.id === 'real').count, 0);
  assert.deepEqual(favoriteView(items, { folderIds: [], filter: 'comic' }).rows, []);
  assert.equal(favoriteView(items.map(item => item.id === 'a' ? { ...item, favorite: false } : item), { folderIds: ['a', 'b'] }).total, 1);
});
