const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { feedContentKey, createStdinWriter } = require('../src/native/content-key-feed');

function rangeOf(header) {
  const match = /bytes=(\d+)-(\d*)/.exec(header || '');
  if (!match) return null;
  return { start: Number(match[1]), end: match[2] === '' ? Infinity : Number(match[2]) };
}

function responseFor(file, header) {
  const range = rangeOf(header);
  const start = range ? range.start : 0;
  const end = range ? Math.min(file.length - 1, range.end) : file.length - 1;
  const slice = file.subarray(start, end + 1);
  return {
    status: range ? 206 : 200,
    headers: { 'content-range': `bytes ${start}-${end}/${file.length}` },
    data: Readable.from([slice]),
  };
}

function collector() {
  const parts = [];
  let firstWrite = 0;
  const stdin = new Writable({
    write(chunk, _enc, callback) {
      if (!firstWrite) firstWrite = Date.now();
      parts.push(Buffer.from(chunk));
      callback();
    },
  });
  return { stdin, parts, firstWrite: () => firstWrite };
}

(async () => {
  const file = Buffer.alloc(2.5 * 1024 * 1024);
  for (let i = 0; i < file.length; i += 1) file[i] = i % 251;
  let tailReady = 0;
  const sink = collector();
  const started = Date.now();
  await feedContentKey({ url: 'https://media.example/episode.mp4' }, sink.stdin, undefined, {
    request: async (_info, options) => {
      const range = rangeOf(options.headers?.Range);
      if (range && range.start > 0) {
        await new Promise(resolve => setTimeout(resolve, 40));
        tailReady = Date.now();
      }
      return responseFor(file, options.headers?.Range);
    },
  });
  assert.ok(tailReady > sink.firstWrite() && sink.firstWrite() >= started, 'the first bytes are written before later windows finish');
  assert.ok(Buffer.concat(sink.parts).equals(file));

  const small = Buffer.from('small-media-bytes');
  const smallSink = collector();
  let requests = 0;
  await feedContentKey({}, smallSink.stdin, undefined, {
    request: async (_info, options) => {
      requests += 1;
      return responseFor(small, options.headers?.Range);
    },
  });
  assert.equal(requests, 1, 'a file inside the first window uses one request');
  assert.ok(Buffer.concat(smallSink.parts).equals(small));

  const controller = new AbortController();
  let sawAbort = false;
  const hanging = feedContentKey({}, collector().stdin, controller.signal, {
    request: (_info, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(Object.assign(new Error('已取消媒体请求'), { code: 'ERR_CANCELED' }));
      });
    }),
  });
  controller.abort();
  await hanging;
  assert.equal(sawAbort, true);

  const fast = new AbortController();
  fast.abort();
  let called = 0;
  await feedContentKey({}, collector().stdin, fast.signal, { request: () => { called += 1; } });
  assert.equal(called, 0, 'an episode switch that already aborted does not start another download');

  await assert.rejects(feedContentKey({}, collector().stdin, undefined, {
    request: async (_info, options) => {
      const range = rangeOf(options.headers?.Range);
      if (range && range.start === 0) {
        return { status: 206, headers: { 'content-range': 'bytes 0-1048575/3000000' }, data: Readable.from([Buffer.from('short')]) };
      }
      return { status: 206, headers: { 'content-range': 'bytes 0-0/1' }, data: Readable.from([Buffer.alloc(0)]) };
    },
  }), /分片长度不符/);

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['pipe', 'ignore', 'ignore'] });
  let uncaught = 0;
  const onUncaught = () => { uncaught += 1; };
  process.on('uncaughtException', onUncaught);
  const writer = createStdinWriter(child.stdin);
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('close', resolve));
  await writer.write(Buffer.alloc(256 * 1024));
  await new Promise(resolve => setTimeout(resolve, 100));
  process.off('uncaughtException', onUncaught);
  assert.equal(uncaught, 0, 'closing FFmpeg while a window is still writing must not raise write EOF');

  const helper = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const { createStdinWriter } = require(${JSON.stringify(path.join(__dirname, '../src/native/content-key-feed.js'))});
    let crashed = 0;
    process.on('uncaughtException', () => { crashed += 1; });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const writer = createStdinWriter(child.stdin);
    child.kill('SIGKILL');
    child.once('close', async () => {
      await writer.write(Buffer.alloc(64 * 1024));
      await writer.end();
      setTimeout(() => process.exit(crashed ? 2 : 0), 150);
    });
  `], { timeout: 5000 });
  assert.equal(helper.status, 0, helper.stderr?.toString() || 'closed pipe write crashed');
  console.log('PASS content-key feed: early bytes, ordered windows, cancel and closed stdin');
})().catch(error => { console.error(error); process.exitCode = 1; });
