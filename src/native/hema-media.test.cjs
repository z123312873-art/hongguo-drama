const assert = require('node:assert/strict');
const test = require('node:test');
const { hedgeMedia } = require('./hema-media');

function hang(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ data: { destroy() {}, id: 'slow' } }), 5000);
    const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' })); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

test('non-hema media uses one request', async () => {
  let calls = 0;
  const value = await hedgeMedia(() => { calls += 1; return { data: { id: 'one' } }; }, { source: 'hongguo', url: 'https://cdn.example/a.mp4' }, {});
  assert.equal(calls, 1);
  assert.equal(value.data.id, 'one');
});

test('a fast hema response does not open a second connection', async () => {
  let calls = 0;
  const value = await hedgeMedia(() => { calls += 1; return { data: { id: 'fast' } }; }, { source: 'hema', url: 'https://cdn.example/a.mp4' }, {}, 50);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, 1);
  assert.equal(value.data.id, 'fast');
});

test('a stalled hema response loses to the later connection', async () => {
  const signals = [];
  const value = await hedgeMedia((_info, options) => {
    signals.push(options.signal);
    if (signals.length === 1) return hang(options.signal);
    return { data: { id: 'second', destroy() {} } };
  }, { source: 'hema', url: 'https://cdn.example/a.mp4' }, {}, 20);
  assert.equal(value.data.id, 'second');
  assert.equal(signals[0].aborted, true);
  assert.equal(signals.length, 2);
});

test('a hema failure still waits for the later connection', async () => {
  let calls = 0;
  const value = await hedgeMedia(() => {
    calls += 1;
    if (calls === 1) return Promise.reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    return { data: { id: 'retry' } };
  }, { source: 'hema', url: 'https://cdn.example/a.mp4' }, {}, 15);
  assert.equal(value.data.id, 'retry');
  assert.equal(calls, 2);
});

test('cancelling hema media does not start the later connection', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = hedgeMedia((_info, options) => {
    calls += 1;
    return hang(options.signal);
  }, { source: 'hema', url: 'https://cdn.example/a.mp4' }, { signal: controller.signal }, 40);
  controller.abort();
  await assert.rejects(pending);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls, 1);
});
