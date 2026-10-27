import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPublicRatings } from '../../publicRatings.mjs';

test('confirmed scores are remembered and a failed lookup stays retryable', () => {
  const checked = new Map();
  const numeric = applyPublicRatings(checked, {
    ratings: { 1234567: 8.64, 2234567: null, 3234567: null },
    pending: ['3234567'],
  }, ['1234567', '2234567', '3234567'], 5000);
  assert.equal(numeric['1234567'], 8.6);
  assert.equal(numeric['2234567'], null);
  assert.equal(Object.hasOwn(numeric, '3234567'), false);
  assert.equal(checked.get('1234567'), 5000);
  assert.equal(checked.get('2234567'), 5000);
  assert.equal(checked.has('3234567'), false);
});

test('a response without ratings does not mark every card as checked', () => {
  const checked = new Map();
  assert.deepEqual(applyPublicRatings(checked, { pending: ['1234567'] }, ['1234567']), {});
  assert.equal(checked.size, 0);
});
