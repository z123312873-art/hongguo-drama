// Offline proxy routing checks: real main-process handlers, isolated env, no network/app data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-proxy-'));
const target = 'https://www.baidu.com';
const system = { proxy_enabled: true, proxy_mode: 'system' };
const custom = { proxy_enabled: true, proxy_mode: 'custom', proxy_host: '127.0.0.1', proxy_port: 19192 };
let failures = 0;
function realResolver(env) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(req.resolve('proxy-from-env'), 'utf8'), { module, exports: module.exports, process: { env }, URL });
  return module.exports.getProxyForUrl;
}
function load(env) {
  const handlers = {}, proxyCalls = [], requests = [], app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} }, session: { defaultSession: { setProxy: async config => proxyCalls.push(config) } } };
  const context = vm.createContext({ require: name => name === 'electron' ? electron : name === './src/store' ? { getSettings: () => ({ root }) } : name === 'axios' ? { get: async (url, options) => { requests.push({ url, options }); return { status: 200 }; } } : req(name), __dirname: path.dirname(source), process: { ...process, env: { ...env } }, console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  return { context, handlers, proxyCalls, requests };
}
async function check(name, run) {
  try { await run(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
}
(async () => {
  await check('system draft tests startup route without changing the active proxy', async () => {
    const env = { HTTPS_PROXY: 'http://startup:19191' }, h = load(env);
    for (const active of [custom, { proxy_enabled: false }]) {
      await h.context.applyProxySettings(active);
      const before = { ...h.context.process.env }, sessions = h.proxyCalls.length;
      const result = await h.handlers['test-proxy']({}, system);
      assert.equal(h.requests.at(-1).options.proxy?.host, 'startup');
      assert.equal(result.via, 'http://startup:19191/');
      assert.deepEqual({ ...h.context.process.env }, before);
      assert.equal(h.proxyCalls.length, sessions);
    }
  });
  await check('snapshot routing matches installed proxy-from-env for protocol, priority and bypass', () => {
    const cases = [
      [{}, target],
      [{ HTTP_PROXY: 'http://http-only:80' }, target],
      [{ HTTPS_PROXY: 'http://upper:80', https_proxy: 'http://lower:81' }, target],
      [{ HTTPS_PROXY: 'http://upper:80', https_proxy: '' }, target],
      [{ ALL_PROXY: 'http://upper:80', all_proxy: 'http://lower:81' }, target],
      [{ HTTPS_PROXY: 'proxy.test:443' }, target],
      ...['*', '.baidu.com', '*.baidu.com', 'www.baidu.com:443', 'www.baidu.com:80', 'BAIDU.com, WWW.BAIDU.COM', '', 'other.test'].map(NO_PROXY => [{ HTTPS_PROXY: 'http://proxy:80', NO_PROXY }, target]),
      [{ HTTPS_PROXY: 'http://proxy:80', NO_PROXY: '*', no_proxy: 'other.test' }, target],
      [{ HTTPS_PROXY: 'http://proxy:80', NO_PROXY: '*', no_proxy: '' }, target],
      [{ HTTP_PROXY: 'proxy:80', HTTPS_PROXY: 'other:443' }, 'http://example.test'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: '[::1]:443' }, 'https://[::1]/'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: '[::1]:80' }, 'https://[::1]/'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: 'example.test:21' }, 'ftp://example.test'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: 'example.test:70' }, 'gopher://example.test'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: 'example.test:80' }, 'ws://example.test'],
      [{ ALL_PROXY: 'proxy:80', NO_PROXY: 'example.test:443' }, 'wss://example.test'],
      [{ ALL_PROXY: 'proxy:80' }, 'not a URL'],
    ];
    for (const [env, url] of cases) {
      const h = load(env);
      assert.equal(h.context.snapshotProxyUrl(url) || '', realResolver(env)(url), `${url} ${JSON.stringify(env)}`);
    }
  });
  await check('test reports actual direct or proxy route, including HTTP-only and NO_PROXY', async () => {
    for (const env of [{}, { HTTP_PROXY: 'http://http-only:80' }, { HTTPS_PROXY: 'http://proxy:80', NO_PROXY: '*' }, { HTTPS_PROXY: 'http://upper:80', https_proxy: 'http://lower:81' }]) {
      const h = load(env), result = await h.handlers['test-proxy']({}, system), expected = realResolver(env)(target);
      assert.equal(h.requests[0].url, target);
      if (expected) {
        assert.equal(h.requests[0].options.proxy.host, new URL(expected).hostname);
        assert.equal(result.via, new URL(expected).toString());
      } else {
        assert.equal(h.requests[0].options.proxy, false);
        assert.equal(result.via, '(直连)');
      }
    }
  });
  await check('custom overrides bypass, direct disables proxies, system restores exact env and Chromium system mode', async () => {
    const env = { HTTPS_PROXY: 'http://upper:80', https_proxy: '', HTTP_PROXY: '', NO_PROXY: '*', no_proxy: '' }, h = load(env);
    const route = realResolver(h.context.process.env);
    await h.context.applyProxySettings(custom);
    assert.equal(route(target), 'http://127.0.0.1:19192');
    assert.equal(h.context.process.env.NO_PROXY, undefined);
    assert.equal(h.context.process.env.no_proxy, undefined);
    await h.context.applyProxySettings({ proxy_enabled: true, proxy_mode: 'direct' });
    assert.equal(route(target), '');
    await h.context.applyProxySettings(system);
    assert.deepEqual({ ...h.context.process.env }, env);
    assert.equal(h.proxyCalls.at(-1).mode, 'system');
    assert.equal(route(target), '');
  });
  assert.equal(failures, 0, `${failures} proxy routing regressions`);
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
