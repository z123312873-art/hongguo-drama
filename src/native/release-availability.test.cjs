const assert = require('node:assert/strict');
const test = require('node:test');
const { taipeiDay, rememberRelease, readRelease, dueReleaseIds, createReleaseProbe, scheduleReleaseDrops } = require('./release-availability');

const taipei = iso => Date.parse(iso);

test('a release answer is remembered until the Taipei day changes', () => {
  const morning = taipei('2026-11-07T00:30:00+08:00');
  assert.equal(taipeiDay(morning), '2026-11-07');
  let cache = rememberRelease(null, '甲', false, morning);
  cache = rememberRelease(cache, '乙', true, morning);
  assert.equal(readRelease(cache, '甲', taipei('2026-11-07T23:00:00+08:00')), false);
  assert.equal(readRelease(cache, '乙', morning), true);
  assert.equal(readRelease(cache, '甲', taipei('2026-11-08T00:05:00+08:00')), undefined);
});

test('only a due id is probed, and a future or blank time is left out', () => {
  const now = taipei('2026-11-07T12:00:00+08:00');
  assert.deepEqual(dueReleaseIds([
    { series_id: '甲', online_time: now - 1000 },
    { series_id: '乙', online_time: now + 1000 },
    { series_id: '丙', online_time: 0 },
    { id: '丁' },
    { series_id: '甲', online_time: now - 1 },
  ], now), ['甲']);
});

test('one lookup is shared, a failure stays false, and the next Taipei day asks again', async () => {
  let clock = taipei('2026-11-07T12:00:00+08:00');
  const calls = [];
  const probe = createReleaseProbe({
    now: () => clock,
    lookup: async id => {
      calls.push(id);
      if (id === '失败') throw new Error('empty');
      return id === '可播';
    },
  });
  const [first, second] = await Promise.all([probe.ask('可播'), probe.ask('可播')]);
  assert.deepEqual([first, second], [true, true]);
  assert.deepEqual(calls, ['可播']);
  assert.equal(await probe.ask('可播'), true);
  assert.equal(calls.length, 1);
  assert.equal(await probe.ask('失败'), false);
  assert.equal(probe.known('失败'), false);
  clock = taipei('2026-11-08T00:10:00+08:00');
  assert.equal(probe.known('可播'), undefined);
  assert.equal(await probe.ask('可播'), true);
  assert.equal(calls.filter(id => id === '可播').length, 2);
});

test('a stopped check does not report a later id', async () => {
  const found = [];
  let stop = false;
  const drops = scheduleReleaseDrops({
    ask: async id => id === '可播',
    shouldStop: () => stop,
    onPlayable: id => found.push(id),
  });
  drops.push(['可播', '未播']);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(found, ['可播']);
  stop = true;
  drops.push(['下一']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(found, ['可播']);
});
