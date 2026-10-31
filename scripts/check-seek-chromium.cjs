// Real Chromium + real FFmpeg check of the encrypted-episode seek path, using the production main.js.
// Needs ffmpeg on PATH and a display:  xvfb-run -a node_modules/electron/dist/electron scripts/check-seek-chromium.cjs --no-sandbox
// Env: HONGGUO_MAIN=<path> runs another main.js (for example the previous release) for start-up comparisons.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (!process.versions.electron) {
  const electron = require('electron');
  const run = spawnSync(process.platform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : electron,
    process.platform === 'linux' && !process.env.DISPLAY ? ['-a', electron, __filename, '--no-sandbox', ...process.argv.slice(2)] : [__filename, ...process.argv.slice(2)],
    { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');

const KEY = '00112233445566778899aabbccddeeff';
const KID = '112233445566778899aabbccddeeff00';
const source = path.resolve(process.env.HONGGUO_MAIN || path.join(__dirname, '../main.js'));
const req = createRequire(path.join(__dirname, '../main.js'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-seek-'));
const RUNS = Number(process.env.RUNS || 1);
const log = (...a) => console.log(...a);

protocol.registerSchemesAsPrivileged([{ scheme: 'hongguo-stream', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true } }]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function makeFixture() {
  const clear = path.join(root, 'clear.mp4'), enc = path.join(root, 'enc.mp4');
  const run = (args) => { const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
  run(['-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '90', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1500k', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', clear]);
  run(['-i', clear, '-c', 'copy', '-encryption_scheme', 'cenc-aes-ctr', '-encryption_key', KEY, '-encryption_kid', KID, '-movflags', '+faststart', enc]);
  return enc;
}

function loadMain(url) {
  const dir = fs.mkdtempSync(path.join(root, 'app-'));
  const handlers = {}, appMock = new EventEmitter();
  Object.assign(appMock, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const realProtocol = protocol;
  const electron = { app: appMock, ipcMain: { handle: (n, f) => { handlers[n] = f; } }, protocol: { registerSchemesAsPrivileged() {}, handle: (n, f) => realProtocol.handle(n, f) } };
  const native = { fetchPlayUrlSingle: async () => ({ url, contentKey: KEY, source: 'app', codec: 'h264' }), UA: 'test', VIDEO_REFERER: 'https://example.com/', deriveKey: () => { throw new Error('unused'); } };
  const context = vm.createContext({
    require: n => n === 'electron' ? electron : n === './src/native/hongguo' ? native : n === './src/store' ? { saveTasks() {}, getSettings: () => ({ root: dir }) } : req(n),
    __dirname: path.dirname(source), console: { log() {}, warn() {}, error: (...a) => log('[main:error]', ...a) }, process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  context.resolveFfmpeg = () => 'ffmpeg';
  context.probeVideoInfo = async () => ({ w: 540, h: 960, duration: 90, codec: 'h264' });
  context.registerStreamProtocol();
  return { dir, handlers, context };
}

const pageScript = String.raw`
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const v = document.getElementById('v');
  const out = {};
  const ranges = t => Array.from({ length: t.length }, (_, i) => [+t.start(i).toFixed(2), +t.end(i).toFixed(2)]);
  const load = (url) => new Promise((resolve, reject) => {
    const done = () => { v.removeEventListener('loadedmetadata', done); resolve(); };
    v.addEventListener('loadedmetadata', done); v.addEventListener('error', () => reject(new Error('media error ' + (v.error && v.error.message))), { once: true });
    v.src = url; v.load();
  });
  const seeked = (apply) => new Promise(resolve => {
    const t = setTimeout(() => resolve(false), 6000);
    v.addEventListener('seeked', () => { clearTimeout(t); resolve(true); }, { once: true });
    apply();
  });
  const playedTo = async (t) => { for (let i = 0; i < 300 && v.currentTime < t; i++) await sleep(50); };

  const vidA = 'episode-' + Math.random().toString(36).slice(2);
  const t0 = performance.now();
  const streamed = await window.t.prepare({ vid: vidA, requestId: 'live-' + vidA });
  out.prepareMs = Math.round(performance.now() - t0);
  out.streaming = streamed.streaming;
  const t1 = performance.now();
  v.muted = true;
  await load(streamed.url);
  await v.play();
  out.firstPlayMs = Math.round(performance.now() - t1);
  await playedTo(4);
  out.streamSeekable = ranges(v.seekable);
  out.streamStart = +v.currentTime.toFixed(2);

  if (window.t.skipSwap) { await window.t.release({ requestId: 'live-' + vidA }); return out; }

  const before = v.currentTime;
  await seeked(() => { v.currentTime = before + 5; });
  await sleep(500);
  out.nativeSeekOnStream = { from: +before.toFixed(2), now: +v.currentTime.toFixed(2) };

  await playedTo(before + 2 > v.currentTime ? before + 2 : v.currentTime + 1);
  const origin = v.currentTime, target = origin + 5;
  const t2 = performance.now();
  const file = await window.t.prepare({ vid: vidA, requestId: 'seek-' + vidA, seekable: true });
  out.swapPrepareMs = Math.round(performance.now() - t2);
  out.swapResult = { success: file.success, streaming: file.streaming, cached: file.cached, size: file.size };
  await window.t.release({ requestId: 'live-' + vidA });
  const t3 = performance.now();
  await load(file.url);
  v.currentTime = target;
  await v.play();
  await sleep(700);
  out.swapLoadMs = Math.round(performance.now() - t3);
  out.afterSwap = { target: +target.toFixed(2), now: +v.currentTime.toFixed(2), paused: v.paused, seekable: ranges(v.seekable), duration: +v.duration.toFixed(2) };

  const steps = [];
  for (const delta of [5, 5, -5, -5, -5, 5]) {
    const from = v.currentTime;
    await seeked(() => { v.currentTime = Math.max(0, from + delta); });
    await sleep(250);
    steps.push({ delta, from: +from.toFixed(2), now: +v.currentTime.toFixed(2) });
  }
  out.nativeSteps = steps;
  const far = v.duration - 1;
  await seeked(() => { v.currentTime = far; });
  await sleep(400);
  out.nearEnd = { target: +far.toFixed(2), now: +v.currentTime.toFixed(2) };
  await window.t.release({ requestId: 'seek-' + vidA });
  return out;
})()`;

app.whenReady().then(async () => {
  const encPath = makeFixture();
  const size = fs.statSync(encPath).size;
  const server = http.createServer((request, response) => {
    const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
    const start = m && m[1] !== '' ? +m[1] : 0, end = m && m[2] !== '' ? Math.min(+m[2], size - 1) : size - 1;
    response.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
    fs.createReadStream(encPath, { start, end }).pipe(response);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const main = loadMain(`http://127.0.0.1:${server.address().port}/enc.mp4`);
  const call = (channel) => async (_event, payload) => main.handlers[channel]({}, payload);
  ipcMain.handle('t:prepare', call('prepare-online-play'));
  ipcMain.handle('t:release', call('release-online-play'));
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `const { ipcRenderer } = require('electron');
window.t = { prepare: p => ipcRenderer.invoke('t:prepare', p), release: p => ipcRenderer.invoke('t:release', p), skipSwap: ${process.env.SKIP_SWAP ? 'true' : 'false'} };`);
  const html = path.join(root, 'index.html');
  fs.writeFileSync(html, '<video id="v" muted playsinline style="width:270px;height:480px"></video>');
  const win = new BrowserWindow({ width: 320, height: 520, show: false, webPreferences: { preload, sandbox: false, contextIsolation: false } });
  await win.loadFile(html);
  const results = [];
  let failures = 0;
  try {
    for (let i = 0; i < RUNS; i++) {
      const result = await win.webContents.executeJavaScript(pageScript);
      results.push(result);
      log(JSON.stringify(result));
    }
    const r = results[0];
    const check = (name, fn) => { try { fn(); log('PASS ' + name); } catch (e) { failures++; log('FAIL ' + name + ': ' + e.message); } };
    log('MEDIAN firstPlayMs=' + [...results.map(x => x.firstPlayMs)].sort((a, b) => a - b)[Math.floor(RUNS / 2)] + ' prepareMs=' + [...results.map(x => x.prepareMs)].sort((a, b) => a - b)[Math.floor(RUNS / 2)]);
    if (!process.env.SKIP_SWAP) {
      check('the live encrypted stream reports no seekable range', () => assert.deepEqual(r.streamSeekable.length ? r.streamSeekable[0] : [0, 0], [0, 0]));
      check('a browser seek on the live stream does not land on the target (the reported bug)', () => assert.ok(r.nativeSeekOnStream.now < r.nativeSeekOnStream.from + 3, JSON.stringify(r.nativeSeekOnStream)));
      check('the prepared file replaces the stream without another stream', () => { assert.equal(r.swapResult.success, true); assert.equal(r.swapResult.streaming, false); });
      check('the swapped file lands exactly five seconds ahead and keeps playing', () => { assert.ok(Math.abs(r.afterSwap.now - r.afterSwap.target) < 1.5, JSON.stringify(r.afterSwap)); assert.equal(r.afterSwap.paused, false); });
      check('the swapped file is seekable over the full episode', () => { assert.ok(r.afterSwap.seekable[0][1] > 80, JSON.stringify(r.afterSwap.seekable)); });
      check('later +/-5 second seeks are exact', () => { for (const s of r.nativeSteps) assert.ok(Math.abs(s.now - Math.max(0, s.from + s.delta)) < 1, JSON.stringify(s)); });
      check('seeking near the end stays near the end', () => assert.ok(r.nearEnd.now > r.nearEnd.target - 1, JSON.stringify(r.nearEnd)));
    }
    main.context.clearOnlineCache();
    await new Promise(r => setTimeout(r, 500));
    check('temporary files are removed afterwards', () => assert.deepEqual(fs.readdirSync(main.dir), []));
  } catch (error) {
    failures++; log('FAIL harness: ' + (error.stack || error));
  }
  server.close();
  app.exit(failures ? 1 : 0);
});
