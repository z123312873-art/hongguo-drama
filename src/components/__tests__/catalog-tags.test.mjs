import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPublicScore } from '../../catalogTags.mjs';
test('public scores use one decimal and ignore empty values', () => {
  assert.equal(formatPublicScore(9.14), '9.1');
  assert.equal(formatPublicScore(9), '9.0');
  assert.equal(formatPublicScore(0), '');
  assert.equal(formatPublicScore(null), '');
  assert.equal(formatPublicScore(11), '');
});
