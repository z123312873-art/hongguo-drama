// Offline app-source regression. No credentials, network beyond a local fixture, or GUI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-app-media-'));
const contentKey = '01'.repeat(16); // Synthetic test key, never a captured credential.
const clearBytes = Buffer.from('decrypted-mp4-fixture');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(condition, message, attempts = 200) {
  for (let i = 0; i < attempts; i++) { if (await condition()) return; await sleep(10); }
  assert.fail(message);
}
function load(url, mode = 'ok', key = contentKey) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const handlers = {}, protocols = {}, children = [], decrypting = [], app = new EventEmitter();
  let releaseDecrypt = () => {};
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (n, f) => handlers[n] = f }, protocol: { registerSchemesAsPrivileged() {}, handle: (n, f) => protocols[n] = f } };
  const native = { fetchPlayUrlSingle: async () => ({ url, contentKey: key, source: 'app', codec: 'h264' }), UA: 'test', VIDEO_REFERER: 'https://example.com/', deriveKey: () => { throw new Error('contentKey must never go through spade'); } };
  const childProcess = { spawn: (file, args) => {
    assert.equal(file, '/bundled/ffmpeg');
    assert.equal(args[args.indexOf('-decryption_key') + 1], contentKey);
    assert.ok(args.includes('copy'), 'remux without lossy transcode');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; child.stdout.end(); setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
    children.push(child);
    const output = args.at(-1);
    if (output === 'pipe:1') {
      if (mode !== 'wait') setImmediate(() => {
        if (mode !== 'fail') child.stdout.end(clearBytes);
        else child.stdout.end();
        if (mode === 'fail') child.stderr.emit('data', Buffer.from('bad media ' + contentKey));
        child.emit('close', mode === 'fail' ? 1 : 0);
      });
      return child;
    }
    decrypting.push(child);
    if (mode === 'wait') fs.writeFileSync(output, 'partial');
    else if (mode === 'slow-decrypt') {
      const finish = releaseDecrypt;
      releaseDecrypt = () => { finish(); if (child.killed) return; fs.writeFileSync(output, clearBytes); child.emit('close', 0); };
    } else setImmediate(() => {
      fs.writeFileSync(output, mode === 'fail' ? 'partial' : clearBytes);
      if (mode === 'fail') child.stderr.emit('data', Buffer.from('bad media ' + contentKey));
      child.emit('close', mode === 'fail' ? 1 : 0);
    });
    return child;
  } };
  const context = vm.createContext({ require: n => n === 'electron' ? electron : n === './src/native/hongguo' ? native : n === 'child_process' || n === 'node:child_process' ? childProcess : n === './src/store' ? { saveTasks() {}, getSettings: () => ({ root: dir }) } : req(n), __dirname: path.dirname(source), console: { log() {}, warn() {}, error() {} }, process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  // These transport/decryption fixtures are synthetic; real media validity is checked separately.
  context.probeVideoInfo = async () => ({ w: 1080, h: 1920, duration: 12, codec: 'h264' });
  context.resolveFfmpeg = () => '/fixture/ffprobe';
  context.resolveFfmpeg = () => '/bundled/ffmpeg'; context.registerStreamProtocol();
  return { dir, handlers, protocols, children, context, decrypting: () => decrypting, finishDecrypt: () => releaseDecrypt() };
}
(async () => {
  let hits = 0;
  const server = http.createServer((r, s) => { hits++; s.end('encrypted-fixture'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/media`;
  let failures = 0;
  async function check(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message.replaceAll(contentKey, '[test-key]')); } }
  await check('app prepare returns a decrypted stream instead of the encrypted URL', async () => {
    const h = load(url); const p = await h.handlers['prepare-online-play']({}, { vid: 'app' });
    assert.equal(p.success, true); assert.equal(p.streaming, true);
    assert.ok(!p.url.includes('127.0.0.1'), 'renderer must not receive the encrypted media URL');
    assert.equal(h.children.length, 0, 'ffmpeg starts when playback reads the stream');
    const response = await h.protocols['hongguo-stream'](new Request(p.url));
    assert.equal(await response.text(), clearBytes.toString()); assert.equal(h.children.length, 1);
    assert.ok(!JSON.stringify(response.headers).includes(contentKey));
    const kept = () => fs.readdirSync(h.dir).flatMap(name => fs.readdirSync(path.join(h.dir, name)));
    await until(() => kept().join() === 'video.mp4', 'only the decrypted file may stay after the encrypted copy is decoded');
    h.context.clearOnlineCache();
    await until(() => fs.readdirSync(h.dir).length === 0, 'clearing the cache removes every temporary file');
  });
  await check('a streamed episode becomes a seekable cached file without downloading twice', async () => {
    const h = load(url); const first = await h.handlers['prepare-online-play']({}, { vid: 'seek', requestId: 'one' });
    assert.equal(first.streaming, true);
    const before = hits;
    assert.equal(await (await h.protocols['hongguo-stream'](new Request(first.url))).text(), clearBytes.toString());
    const second = await h.handlers['prepare-online-play']({}, { vid: 'seek', requestId: 'two', seekable: true });
    assert.equal(second.success, true); assert.equal(second.streaming, false); assert.equal(second.cached, true);
    assert.equal(second.size, clearBytes.length);
    assert.equal(hits - before, 1, 'the kept encrypted bytes serve the seekable file');
    const ranged = await h.protocols['hongguo-stream'](new Request(second.url, { headers: { Range: 'bytes=2-6' } }));
    assert.equal(ranged.status, 206); assert.equal(ranged.headers.get('content-range'), `bytes 2-6/${clearBytes.length}`);
    assert.equal(await ranged.text(), clearBytes.subarray(2, 7).toString());
    const tail = await h.protocols['hongguo-stream'](new Request(second.url, { headers: { Range: 'bytes=-4' } }));
    assert.equal(await tail.text(), clearBytes.subarray(-4).toString());
    h.context.clearOnlineCache();
    await until(() => fs.readdirSync(h.dir).length === 0, 'seekable file is removed with the cache');
  });
  await check('seekable prepare waits for the capture that is already downloading', async () => {
    const h = load(url, 'slow-decrypt'); const first = await h.handlers['prepare-online-play']({}, { vid: 'wait-seek', requestId: 'one' });
    await (await h.protocols['hongguo-stream'](new Request(first.url))).text();
    let settled = false;
    const pending = h.handlers['prepare-online-play']({}, { vid: 'wait-seek', requestId: 'two', seekable: true }).then(r => { settled = true; return r; });
    await sleep(60); assert.equal(settled, false, 'must not answer with the live stream while the file is still being prepared');
    h.finishDecrypt();
    const ready = await pending;
    assert.equal(ready.success, true); assert.equal(ready.streaming, false);
    h.context.clearOnlineCache();
  });
  await check('seekable prepare without a kept copy decrypts a complete file instead of returning the live stream', async () => {
    const h = load(url); const p = await h.handlers['prepare-online-play']({}, { vid: 'direct-seek', requestId: 'one', seekable: true });
    assert.equal(p.success, true); assert.equal(p.streaming, false);
    const ranged = await h.protocols['hongguo-stream'](new Request(p.url, { headers: { Range: 'bytes=0-3' } }));
    assert.equal(ranged.status, 206); assert.equal(await ranged.text(), clearBytes.subarray(0, 4).toString());
    h.context.clearOnlineCache();
  });
  await check('leaving the episode stops its background download and removes the kept files', async () => {
    const h = load(url, 'slow-decrypt'); const p = await h.handlers['prepare-online-play']({}, { vid: 'leave', requestId: 'leave' });
    await (await h.protocols['hongguo-stream'](new Request(p.url))).text();
    await until(() => h.decrypting().length === 1, 'the finished download starts decrypting');
    await h.handlers['release-online-play']({}, { requestId: 'leave' });
    await until(() => h.decrypting()[0].killed === true, 'decryption of an abandoned episode is stopped');
    await until(() => fs.readdirSync(h.dir).length === 0, 'abandoned episode leaves no temporary files');
  });
  await check('a second session for the same episode keeps the capture alive until the last one leaves', async () => {
    const h = load(url, 'slow-decrypt'); const a = await h.handlers['prepare-online-play']({}, { vid: 'shared', requestId: 'a' });
    await (await h.protocols['hongguo-stream'](new Request(a.url))).text();
    await until(() => h.decrypting().length === 1, 'decrypting');
    const pending = h.handlers['prepare-online-play']({}, { vid: 'shared', requestId: 'b', seekable: true });
    await sleep(30);
    await h.handlers['release-online-play']({}, { requestId: 'a' });
    await sleep(40); assert.equal(h.decrypting()[0].killed, undefined, 'the waiting seekable session still needs it');
    h.finishDecrypt();
    assert.equal((await pending).success, true);
    h.context.clearOnlineCache();
  });
  await check('a cancelled seekable request does not leave the capture running', async () => {
    const h = load(url, 'slow-decrypt'); const a = await h.handlers['prepare-online-play']({}, { vid: 'cancel-seek', requestId: 'a' });
    await (await h.protocols['hongguo-stream'](new Request(a.url))).text();
    await until(() => h.decrypting().length === 1, 'decrypting');
    const pending = h.handlers['prepare-online-play']({}, { vid: 'cancel-seek', requestId: 'b', seekable: true });
    await sleep(30);
    await h.handlers['release-online-play']({}, { requestId: 'b' });
    await h.handlers['release-online-play']({}, { requestId: 'a' });
    const result = await pending;
    assert.equal(result.success, false, 'a released request must not be handed a stream');
    await until(() => h.decrypting()[0].killed === true, 'capture stops once nobody uses the episode');
    await until(() => fs.readdirSync(h.dir).length === 0, 'cleanup completes');
  });
  await check('forcing a reconnect discards the old capture and cache', async () => {
    const h = load(url, 'slow-decrypt'); const a = await h.handlers['prepare-online-play']({}, { vid: 'force', requestId: 'a' });
    await (await h.protocols['hongguo-stream'](new Request(a.url))).text();
    await until(() => h.decrypting().length === 1, 'decrypting');
    const b = await h.handlers['prepare-online-play']({}, { vid: 'force', requestId: 'b', force: true });
    assert.equal(b.streaming, true);
    await until(() => h.decrypting()[0].killed === true, 'a replaced capture stops');
    h.context.clearOnlineCache();
  });
  await check('app download publishes decrypted bytes and removes intermediate files', async () => {
    const h = load(url), task = { id: 'download', type: 'hongguo', filename: 'final.mp4', customDir: h.dir, hongguoInfo: { vid: 'app' } };
    await h.context.executeHongguoDownload(task);
    assert.equal(task.status, 'completed'); assert.deepEqual(fs.readFileSync(task.savePath), clearBytes);
    assert.deepEqual(fs.readdirSync(h.dir), ['final.mp4']);
  });
  await check('cancel during native decryption kills child and removes partial output', async () => {
    const h = load(url, 'wait'); const prepared = await h.handlers['prepare-online-play']({}, { vid: 'cancel', requestId: 'cancel' });
    assert.equal(prepared.success, true);
    const pending = h.protocols['hongguo-stream'](new Request(prepared.url));
    for (let i=0; i<30 && !h.children.length; i++) await sleep(5);
    assert.equal(h.children.length, 1, 'encrypted playback must start ffmpeg');
    await h.handlers['release-online-play']({}, { requestId: 'cancel' });
    assert.equal(h.children[0].killed, true);
    await pending.catch(() => {});
    await until(() => fs.readdirSync(h.dir).length === 0, 'cancelled playback removes the kept encrypted copy');
  });
  await check('native failure does not expose keys or retain partial output', async () => {
    const h = load(url, 'fail'); const p = await h.handlers['prepare-online-play']({}, { vid: 'fail' });
    assert.equal(p.success, true);
    const response = await h.protocols['hongguo-stream'](new Request(p.url));
    const body = await response.text();
    assert.ok(!body.includes(contentKey)); assert.ok(!String(p.error || '').includes(contentKey));
    await until(() => fs.readdirSync(h.dir).length === 0, 'a failed decode leaves no kept files');
  });
  await check('invalid content key is rejected before launching native code', async () => {
    const h = load(url, 'ok', 'invalid'); const p = await h.handlers['prepare-online-play']({}, { vid: 'invalid' });
    assert.equal(p.success, false); assert.equal(h.children.length, 0); assert.deepEqual(fs.readdirSync(h.dir), []);
  });
  server.closeAllConnections(); await new Promise(r => server.close(r));
  assert.equal(failures, 0, `${failures} app-media regressions`);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
