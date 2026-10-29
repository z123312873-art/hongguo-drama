import assert from 'node:assert/strict';
import {
  clampSeekTarget, readSessionEpisodeTime, resolveEpisodeSeekTarget, writeSessionEpisodeTime,
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

console.log('PASS player-session-progress unit');
