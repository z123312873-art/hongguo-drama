const assert = require('node:assert/strict');
const test = require('node:test');
const { boundedEpisodeIds, codecExhausted, EPISODE_REQUEST_CAP } = require('./playback-policy');

test('an episode request stays in order and stops at fifteen', () => {
  const ids = Array.from({ length: EPISODE_REQUEST_CAP }, (_, index) => String(index + 1));
  assert.deepEqual(boundedEpisodeIds(ids), ids);
  assert.throws(() => boundedEpisodeIds([...ids, '16']), error => error.code === 'EPISODE_WINDOW');
  assert.deepEqual(boundedEpisodeIds(['5', '', '6']), ['5', '6']);
});

test('a model without H.264 or HEVC is not retried as a network miss', () => {
  assert.equal(codecExhausted({ code: 'NO_COMPATIBLE_CODEC' }), true);
  assert.equal(codecExhausted({ code: 'SOURCE_UNAVAILABLE', sources: [{ code: 'NO_PLAYABLE_SOURCE' }, { code: 'NO_PLAYABLE_SOURCE' }] }), true);
  assert.equal(codecExhausted({ code: 'SOURCE_UNAVAILABLE', sources: [{ code: 'NO_PLAYABLE_SOURCE' }, { code: 'EMPTY_RESPONSE' }] }), false);
  assert.equal(codecExhausted({ code: 'ECONNRESET' }), false);
});
