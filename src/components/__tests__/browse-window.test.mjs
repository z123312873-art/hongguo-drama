import assert from 'node:assert/strict';
import { keepRicherSnapshot, pageWindow, RANK_TOTAL, reuseFreshSnapshot, shownBrowseTotal } from '../../browseWindow.mjs';

assert.deepEqual(pageWindow(17, 1), [1, 2, 3, 4, 5, 17]);
assert.equal(pageWindow(17, 1).includes(5), true);
assert.deepEqual(pageWindow(17, 10), [1, 10, 11, 12, 13, 14, 17]);
assert.deepEqual(pageWindow(17, 15), [1, 15, 16, 17]);
assert.deepEqual(pageWindow(3, 1), [1, 2, 3]);
assert.deepEqual(pageWindow(0, 1), []);

assert.equal(shownBrowseTotal({ source: 'hongguo', category: 'hot-drama', genre: '', total: 20 }), RANK_TOTAL);
assert.equal(RANK_TOTAL, 100);
assert.equal(shownBrowseTotal({ source: 'hongguo', category: 'hot-ai-drama', genre: '', total: 0 }), 100);
assert.equal(shownBrowseTotal({ source: 'hongguo', category: 'real-drama', genre: '', total: 800 }), 0);
assert.equal(shownBrowseTotal({ source: 'hongguo', category: 'comic-drama', genre: '', total: 800 }), 0);
assert.equal(shownBrowseTotal({ source: 'hongguo', category: 'ai-drama', genre: '', total: 800 }), 0);
assert.equal(shownBrowseTotal({ source: 'hongguo', category: 'real-drama', genre: '', total: 48 }), 48);
assert.equal(shownBrowseTotal({ source: 'hongguo', category: 'real-drama', genre: 'legend', total: 88 }), 88);
assert.equal(shownBrowseTotal({ source: 'hongguo', category: 'comic-drama', genre: 'sci-fi', total: 800 }), 800);
assert.equal(shownBrowseTotal({ source: 'xifan', category: '', genre: '', total: 12 }), 12);

assert.equal(reuseFreshSnapshot({ haveCards: true, stale: true, forceRefresh: false, neededSpan: 1, pageSpan: 1 }), false);
assert.equal(reuseFreshSnapshot({ haveCards: true, stale: false, forceRefresh: false, neededSpan: 1, pageSpan: 2 }), true);
assert.equal(reuseFreshSnapshot({ haveCards: true, stale: false, forceRefresh: true, neededSpan: 1, pageSpan: 2 }), false);

const longList = { results: [1, 2, 3, 4], pageSpan: 2 };
const shortList = { results: [1], pageSpan: 1 };
assert.equal(keepRicherSnapshot(longList, shortList), longList);
assert.equal(keepRicherSnapshot(shortList, longList), longList);
assert.equal(keepRicherSnapshot(null, shortList), shortList);

console.log('PASS browse window');
