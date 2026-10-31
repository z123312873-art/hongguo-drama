import assert from 'node:assert/strict';
import {
  clampRelativeSeek, clampSeekTarget, readSessionEpisodeTime, resolveEpisodeSeekTarget,
  shouldDeferPlaybackEnd, writeSessionEpisodeTime,
} from '../playerSessionProgress.js';

const map = new Map();
writeSessionEpisodeTime(map, 'S1', 2, 41.5);
assert.equal(readSessionEpisodeTime(map, 'S1', 2), 41.5);
assert.equal(readSessionEpisodeTime(map, 'S1', 3), null);

assert.equal(resolveEpisodeSeekTarget(map, 'S1', 3, undefined, 2, () => 9), 0);
assert.equal(resolveEpisodeSeekTarget(map, 'S1', 2, undefined, 2, () => 9), 9);
assert.equal(resolveEpisodeSeekTarget(map, 'S1', 2, 12, 2, () => 9), 12);

const clamped = clampSeekTarget(120, 90, 100);
assert.equal(clamped.time, 90);
assert.equal(clamped.blocked, true);

assert.equal(clampRelativeSeek(60, -5, 15, 100).time, 55, 'backward must not snap to seekableEnd');
assert.equal(clampRelativeSeek(3, -5, 15, 100).time, 0);
assert.equal(clampRelativeSeek(60, 5, 15, 100).time, 15);
assert.equal(clampRelativeSeek(60, 5, 15, 100).blocked, true);

const fakeVideo = { ended: true, currentTime: 12, duration: 18, buffered: { length: 1, end: () => 120 } };
assert.equal(shouldDeferPlaybackEnd(fakeVideo), true);
assert.equal(shouldDeferPlaybackEnd({ ended: true, currentTime: 98, duration: 100, buffered: { length: 1, end: () => 100 } }), false);

console.log('PASS player-session-progress unit');
