import assert from 'node:assert/strict';
import test from 'node:test';
import { markRead, neighbours, readProgress } from '../../comicProgress.mjs';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } };
}

test('opened episodes are remembered per comic and the last one is kept', () => {
  const storage = memoryStorage();
  assert.equal(markRead(storage, '7000001', '8000001'), true);
  assert.equal(markRead(storage, '7000001', '8000002'), true);
  assert.equal(markRead(storage, '7000002', '9000001'), true);
  const one = readProgress(storage, '7000001');
  assert.deepEqual([...one.read], ['8000001', '8000002']);
  assert.equal(one.last, '8000002');
  assert.deepEqual([...readProgress(storage, '7000002').read], ['9000001']);
  assert.equal(readProgress(storage, '7999999').last, '');
});

test('opening the same episode again moves it to the end without duplicating', () => {
  const storage = memoryStorage();
  markRead(storage, '7000001', '8000001'); markRead(storage, '7000001', '8000002'); markRead(storage, '7000001', '8000001');
  assert.deepEqual([...readProgress(storage, '7000001').read], ['8000002', '8000001']);
});

test('a missing, corrupt or full store never throws', () => {
  assert.deepEqual([...readProgress(null, '7000001').read], []);
  assert.deepEqual([...readProgress(memoryStorage({ 'comic-progress:v1': '{not json' }), '7000001').read], []);
  assert.deepEqual([...readProgress(memoryStorage({ 'comic-progress:v1': '[1,2]' }), '7000001').read], []);
  const full = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.equal(markRead(full, '7000001', '8000001'), false);
  assert.equal(markRead(memoryStorage(), 'abc', '8000001'), false);
  assert.equal(markRead(memoryStorage(), '7000001', '<x>'), false);
});

test('the oldest comics are dropped past the cap', () => {
  const storage = memoryStorage();
  for (let n = 0; n < 205; n += 1) markRead(storage, String(7100000 + n), '8000001', n);
  const all = JSON.parse(storage.data['comic-progress:v1']);
  assert.equal(Object.keys(all).length, 200);
  assert.equal(all['7100000'], undefined);
  assert.ok(all['7100204']);
});

test('neighbours follow the directory order and stop at both ends', () => {
  const list = [1, 2, 3].map(n => ({ itemId: String(8000000 + n), index: n }));
  assert.deepEqual(neighbours(list, '8000002'), { previous: list[0], next: list[2], position: 2 });
  assert.equal(neighbours(list, '8000001').previous, null);
  assert.equal(neighbours(list, '8000003').next, null);
  assert.deepEqual(neighbours(list, '1'), { previous: null, next: null, position: 0 });
  assert.deepEqual(neighbours(null, '1'), { previous: null, next: null, position: 0 });
});
