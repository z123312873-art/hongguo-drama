const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createContentKeyCapture } = require('../src/native/seekable-capture');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-capture-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function rangeOf(header) {
  const match = /bytes=(\d+)-(\d*)/.exec(header || '');
  return match ? { start: Number(match[1]), end: match[2] === '' ? Infinity : Number(match[2]) } : null;
}

function serve(file, { tailDelay = 0, onRequest } = {}) {
  return async (_info, options) => {
    const range = rangeOf(options.headers?.Range);
    onRequest?.(range);
    if (range && range.start > 0 && tailDelay) await sleep(tailDelay);
    if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' });
    const start = range ? range.start : 0;
    const end = range ? Math.min(file.length - 1, range.end) : file.length - 1;
    return { status: range ? 206 : 200, headers: { 'content-range': `bytes ${start}-${end}/${file.length}` },
      data: Readable.from([file.subarray(start, end + 1)]) };
  };
}

function directory() {
  return fs.mkdtempSync(path.join(root, 'capture-'));
}

async function collect(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

const decryptCopy = async (input, output) => { fs.copyFileSync(input, output); };

(async () => {
  const file = Buffer.alloc(2.5 * 1024 * 1024);
  for (let i = 0; i < file.length; i += 1) file[i] = (i * 7) % 251;
  let failures = 0;
  const test = async (name, run) => {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); }
  };

  await test('a reader receives the whole encrypted file in order while later windows are still downloading', async () => {
    const dir = directory();
    let firstReadAt = 0;
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(file, { tailDelay: 80 }), maxBytes: 10 * file.length, directory: dir, decrypt: decryptCopy });
    const reader = capture.reader();
    const body = await (async () => {
      const parts = [];
      for await (const chunk of reader) { firstReadAt ||= Date.now(); parts.push(Buffer.from(chunk)); }
      return Buffer.concat(parts);
    })();
    const readEnded = Date.now();
    assert.ok(body.equals(file));
    assert.ok(firstReadAt && firstReadAt < readEnded, 'streaming must not wait for the end of the download');
    const finished = await capture.result;
    assert.equal(finished.size, file.length);
    assert.ok(fs.readFileSync(finished.filePath).equals(file));
    assert.equal(fs.existsSync(path.join(dir, 'encrypted.mp4')), false, 'the encrypted copy is removed once decrypted');
    assert.equal(capture.readable, false, 'a finished capture no longer offers the encrypted bytes');
    capture.adopt();
  });

  await test('an episode larger than the in-memory head is delivered intact to early and late readers', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 13 + (i >> 11)) % 253;
    const dir = directory();
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(big, { tailDelay: 20 }), maxBytes: 2 * big.length, directory: dir, decrypt: decryptCopy });
    const early = collect(capture.reader());
    await sleep(15);
    const mid = collect(capture.reader());
    assert.ok((await early).equals(big));
    assert.ok((await mid).equals(big));
    const finished = await capture.result;
    assert.ok(fs.readFileSync(finished.filePath).equals(big));
    capture.adopt();
  });

  await test('several readers are served from the same single download', async () => {
    const dir = directory();
    let requests = 0;
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(file, { onRequest: () => { requests += 1; } }), maxBytes: 10 * file.length, directory: dir, decrypt: decryptCopy });
    const [a, b] = await Promise.all([collect(capture.reader()), collect(capture.reader())]);
    assert.ok(a.equals(file) && b.equals(file));
    await capture.result;
    assert.equal(requests, 4, 'one first window plus three tail windows, whatever the number of readers');
    await capture.discard();
    assert.equal(fs.existsSync(dir), false);
  });

  await test('a small episode is one request and still becomes a decrypted file', async () => {
    const small = Buffer.from('tiny-encrypted-episode');
    const dir = directory();
    let requests = 0;
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(small, { onRequest: () => { requests += 1; } }), maxBytes: 1024, directory: dir,
      decrypt: async (input, output) => fs.writeFileSync(output, Buffer.concat([fs.readFileSync(input), Buffer.from('+clear')])) });
    const { filePath, size } = await capture.result;
    assert.equal(requests, 1);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'tiny-encrypted-episode+clear');
    assert.equal(size, 28);
    capture.adopt();
  });

  await test('abort stops the download, ends readers with an error and removes the directory', async () => {
    const dir = directory();
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(file, { tailDelay: 400 }), maxBytes: 10 * file.length, directory: dir, decrypt: decryptCopy });
    const reading = collect(capture.reader()).then(() => 'ended', error => error.code || error.message);
    await sleep(60);
    capture.abort();
    await assert.rejects(capture.result, { code: 'ERR_CANCELED' });
    assert.notEqual(await reading, 'ended', 'a reader must not see a truncated file as complete');
    assert.equal(fs.existsSync(dir), false);
    assert.equal(capture.readable, false);
    assert.throws(() => capture.reader(), { code: 'ERR_CANCELED' });
  });

  await test('abort during decryption passes the signal on and cleans up after the tool stops', async () => {
    const dir = directory();
    let seenSignal;
    let stopped = false;
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(file), maxBytes: 10 * file.length, directory: dir,
      decrypt: (_input, _output, { signal }) => new Promise((_resolve, reject) => {
        seenSignal = signal;
        signal.addEventListener('abort', () => setTimeout(() => { stopped = true; reject(new Error('已取消媒体解密')); }, 30), { once: true });
      }) });
    for (let i = 0; i < 200 && !seenSignal; i += 1) await sleep(5);
    assert.ok(seenSignal, 'decryption starts as soon as the download completes');
    capture.abort();
    await assert.rejects(capture.result, /取消/);
    assert.equal(stopped, true);
    assert.equal(fs.existsSync(dir), false);
  });

  await test('an episode over the size limit fails with MEDIA_TOO_LARGE and leaves nothing behind', async () => {
    const dir = directory();
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(file), maxBytes: file.length - 10, directory: dir, decrypt: decryptCopy });
    const reading = collect(capture.reader()).then(() => 'ended', error => error.code);
    await assert.rejects(capture.result, { code: 'MEDIA_TOO_LARGE' });
    assert.equal(await reading, 'MEDIA_TOO_LARGE');
    assert.equal(fs.existsSync(dir), false);
  });

  await test('a truncated download is rejected instead of being decrypted', async () => {
    const dir = directory();
    let decrypted = false;
    const capture = createContentKeyCapture({ playInfo: {}, maxBytes: 10 * file.length, directory: dir,
      request: async (_info, options) => {
        const range = rangeOf(options.headers?.Range);
        if (range && range.start === 0) return { status: 206, headers: { 'content-range': `bytes 0-1048575/${file.length}` }, data: Readable.from([Buffer.from('short')]) };
        return { status: 206, headers: { 'content-range': 'bytes 0-0/1' }, data: Readable.from([Buffer.alloc(0)]) };
      },
      decrypt: async () => { decrypted = true; } });
    await assert.rejects(capture.result, /分片长度不符/);
    assert.equal(decrypted, false);
    assert.equal(fs.existsSync(dir), false);
  });

  await test('a decrypt failure removes the capture and reports the error', async () => {
    const dir = directory();
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(file), maxBytes: 10 * file.length, directory: dir,
      decrypt: async () => { throw new Error('bad key'); } });
    await assert.rejects(capture.result, /bad key/);
    assert.equal(fs.existsSync(dir), false);
  });

  await test('an empty decrypted file is a failure', async () => {
    const dir = directory();
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(file), maxBytes: 10 * file.length, directory: dir,
      decrypt: async (_input, output) => fs.writeFileSync(output, '') });
    await assert.rejects(capture.result, /解密失败/);
    assert.equal(fs.existsSync(dir), false);
  });

  await test('adopt keeps the directory and discard removes an unused finished capture', async () => {
    const kept = directory();
    const adopted = createContentKeyCapture({ playInfo: {}, request: serve(file), maxBytes: 10 * file.length, directory: kept, decrypt: decryptCopy });
    adopted.adopt();
    await adopted.result;
    await adopted.discard();
    assert.equal(fs.existsSync(path.join(kept, 'video.mp4')), true, 'an adopted directory belongs to its new owner');
    const dropped = directory();
    const unused = createContentKeyCapture({ playInfo: {}, request: serve(file), maxBytes: 10 * file.length, directory: dropped, decrypt: decryptCopy });
    await unused.result;
    await unused.discard();
    assert.equal(fs.existsSync(dropped), false);
  });

  await test('a reader that is destroyed early releases the file so the directory can be removed', async () => {
    const dir = directory();
    const capture = createContentKeyCapture({ playInfo: {}, request: serve(file, { tailDelay: 100 }), maxBytes: 10 * file.length, directory: dir, decrypt: decryptCopy });
    const reader = capture.reader();
    await new Promise(resolve => reader.once('readable', resolve));
    reader.destroy();
    await capture.result;
    await capture.discard();
    assert.equal(fs.existsSync(dir), false);
  });

  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(failures, 0, `${failures} seekable capture regressions`);
  console.log('PASS seekable capture: shared download, ordered readers, decrypt handoff, abort and cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
