const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { waitForMediaProcess } = require('./media-finalize');
function fixture(closeOnKill = true) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
  child.kill = signal => { child.kills.push(signal); if (closeOnKill) child.emit('close', null); return true; };
  return child;
}
test('native progress accepts split lines, remains monotonic and ignores diagnostics', async () => {
  const child = fixture(), rows = [];
  const pending = waitForMediaProcess(child, { onProgress: row => rows.push(row) });
  child.stdout.write('out_time_us=150'); child.stdout.write('0000\ntotal_size=1200\nout_time_ms=1000000\nout_time_us=NaN\n');
  child.stderr.write('private input or key must never reach the renderer');
  child.emit('close', 0); await pending;
  assert.deepEqual(rows, [{ seconds: 1.5, bytes: 0 }, { seconds: 1.5, bytes: 1200 }]);
});
test('stalled native process terminates and reports retryable user guidance rather than waiting forever', async () => {
  const child = fixture();
  await assert.rejects(waitForMediaProcess(child, { timeoutMs: 1000, idleTimeoutMs: 20 }), error => error.code === 'MEDIA_FINALIZE_TIMEOUT' && /重试/.test(error.message));
  assert.deepEqual(child.kills, ['SIGTERM']);
});
test('absolute deadline still bounds a process that keeps emitting advancing progress', async () => {
  const child = fixture(); let n = 0;
  const timer = setInterval(() => child.stdout.write(`out_time_us=${++n * 1000000}\n`), 5);
  try { await assert.rejects(waitForMediaProcess(child, { timeoutMs: 40, idleTimeoutMs: 100 }), { code: 'MEDIA_FINALIZE_TIMEOUT' }); }
  finally { clearInterval(timer); }
});
test('unresponsive child is force-killed and the operation settles even without a close event', async () => {
  const child = fixture(false);
  await assert.rejects(waitForMediaProcess(child, { idleTimeoutMs: 15, killAfterMs: 15 }), { code: 'MEDIA_FINALIZE_TIMEOUT' });
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
});
test('abort and an already-cancelled token cannot leak a process or timeout', async () => {
  const child = fixture(), controller = new AbortController();
  const pending = waitForMediaProcess(child, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { code: 'ERR_CANCELED' });
  const other = fixture(); let unsubscribed = false;
  await assert.rejects(waitForMediaProcess(other, { cancelToken: { reason: {}, subscribe: fn => fn(), unsubscribe: () => unsubscribed = true } }), { code: 'ERR_CANCELED' });
  assert.equal(unsubscribed, true); assert.equal(other.kills.length, 1);
});
test('native failures are sanitized and a missing executable is not a quality fallback', async () => {
  const child = fixture(), pending = waitForMediaProcess(child);
  child.stderr.write('secret-key and private URL'); child.emit('close', 1);
  await assert.rejects(pending, error => error.code === 'MEDIA_FINALIZE_FAILED' && !/secret|URL/.test(error.message));
  const other = fixture(), failed = waitForMediaProcess(other); other.emit('error', Error('private executable path'));
  await assert.rejects(failed, { code: 'LOCAL_MEDIA_TOOL_ERROR' });
});
