import assert from 'node:assert/strict';
import test from 'node:test';
import { AHEAD_PAGES, INITIAL_PAGES, createDirectHealth, firstPictureUrls, inWindow, preloadWindow, reachedEnd } from '../../comicPreload.mjs';

test('before anything is in view the first pages load, never more than the episode has', () => {
  assert.deepEqual(preloadWindow({ near: [], total: 30 }), { lo: 0, hi: INITIAL_PAGES - 1 });
  assert.deepEqual(preloadWindow({ near: [], total: 2 }), { lo: 0, hi: 1 });
  assert.deepEqual(preloadWindow({ near: [], total: 1 }), { lo: 0, hi: 0 });
  assert.deepEqual(preloadWindow({ near: [], total: 0 }), { lo: 0, hi: -1 });
  assert.deepEqual(preloadWindow({ total: undefined }), { lo: 0, hi: -1 });
});

test('the window runs from the first page near the viewport to a few pages after the last one', () => {
  assert.deepEqual(preloadWindow({ near: [3, 4], total: 30 }), { lo: 3, hi: 4 + AHEAD_PAGES });
  assert.deepEqual(preloadWindow({ near: new Set([10]), total: 30 }), { lo: 10, hi: 10 + AHEAD_PAGES });
  assert.deepEqual(preloadWindow({ near: [28], total: 30 }), { lo: 28, hi: 29 }, 'never past the last page');
  assert.deepEqual(preloadWindow({ near: [5], total: 30, ahead: 0 }), { lo: 5, hi: 5 });
});

test('jumping far down does not pull in every page between', () => {
  const window = preloadWindow({ near: [20, 21], total: 40 });
  assert.equal(inWindow(2, window), false);
  assert.equal(inWindow(20, window), true);
  assert.equal(inWindow(21 + AHEAD_PAGES, window), true);
  assert.equal(inWindow(21 + AHEAD_PAGES + 1, window), false);
});

test('bad input is ignored instead of widening the window', () => {
  assert.deepEqual(preloadWindow({ near: [-1, 99, 'x', 1.5, NaN, 2], total: 10 }), { lo: 2, hi: 2 + AHEAD_PAGES });
  assert.deepEqual(preloadWindow({ near: [-1, 99], total: 10 }), { lo: 0, hi: INITIAL_PAGES - 1 });
});

test('the next episode is warmed only once this one is fully requested', () => {
  assert.equal(reachedEnd(preloadWindow({ near: [0], total: 30 }), 30), false);
  assert.equal(reachedEnd(preloadWindow({ near: [26], total: 30 }), 30), true);
  assert.equal(reachedEnd(preloadWindow({ near: [], total: 3 }), 3), true, 'a short episode is fully requested at once');
  assert.equal(reachedEnd({ lo: 0, hi: -1 }, 0), false);
});

test('only the first few pictures of the next episode are chosen, in order, and bad entries are skipped', () => {
  const chapter = { pictures: [{ url: 'a' }, { url: '' }, { url: 'b' }, null, { url: 'c' }, { url: 'd' }] };
  assert.deepEqual(firstPictureUrls(chapter), ['a', 'b', 'c']);
  assert.deepEqual(firstPictureUrls(chapter, 1), ['a']);
  assert.deepEqual(firstPictureUrls(chapter, 0), []);
  assert.deepEqual(firstPictureUrls(null), []);
  assert.deepEqual(firstPictureUrls({ pictures: 'x' }), []);
});

test('the direct image host is skipped only after repeated failures with no success', () => {
  const health = createDirectHealth(3);
  assert.equal(health.skipDirect(), false);
  health.noteFailed(); health.noteFailed();
  assert.equal(health.skipDirect(), false);
  health.noteFailed();
  assert.equal(health.skipDirect(), true);
  const working = createDirectHealth(3);
  working.noteLoaded();
  for (let i = 0; i < 10; i += 1) working.noteFailed();
  assert.equal(working.skipDirect(), false, 'one success means the host answers; single pages fall back on their own');
});
