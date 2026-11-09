// Signed-in watch history through main's IPC with a fake account server: no app data, network or keys.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);

const ONE = '7300000000000000001', TWO = '7300000000000000002', THREE = '7300000000000000003';
const row = (id, extra = {}) => ({ book_id_str: id, book_name: `剧${id.slice(-1)}`, episode_cnt: 10, vid_index: 4, current_play_position: 30000, duration: 60000, read_timestamp_ms: 2000, ...extra });

function load({ account = true, saved = 'user-1', encryption = true, server = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-cloud-'));
  const handlers = {}, app = new EventEmitter(), sent = [], timers = [];
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const safeStorage = {
    isEncryptionAvailable: () => encryption,
    encryptString: text => Buffer.from(`enc:${text}`),
    decryptString: buf => { const text = buf.toString(); if (!text.startsWith('enc:')) throw new Error('bad'); return text.slice(4); },
  };
  const electron = { app, safeStorage, ipcMain: { handle: (name, fn) => handlers[name] = fn }, protocol: { registerSchemesAsPrivileged() {} } };
  let playback = {
    [ONE]: { watched: true, vid_index: 7, currentTime: 5, updatedAt: 3000 },
    [THREE]: { watched: true, vid_index: 1, currentTime: 2, updatedAt: 1000 },
  };
  let record = account ? { userId: 'user-1', nickname: '用户名34908929', profileFrom: 'user-info', loggedInAt: Date.now() } : null;
  let blob = saved ? Buffer.from(`enc:${JSON.stringify({ userId: saved, region: '+886', token: 't', cookies: {} })}`).toString('base64') : '';
  const store = {
    getSettings: () => ({}), getPlayback: () => structuredClone(playback), savePlayback: next => { playback = structuredClone(next); }, saveSeries() {},
    getAccount: () => record, saveAccount: next => { record = next; },
    getLoginSession: () => blob, saveLoginSession: value => { blob = value; },
    getLoginDevice: () => null, saveLoginDevice() {},
  };
  const cloud = { rows: [row(ONE), row(TWO, { vid_index: 10, current_play_position: 59500, read_timestamp_ms: 2500 })], requests: [], fail: '', ignoreDelete: false, ...server };
  let restored = null;
  const fakeClient = {
    restore: session => { restored = session; return true; },
    signedIn: () => !!restored, user: () => restored?.userId || '',
    snapshot: () => restored, reset: () => { restored = null; },
    request: async (method, apiPath, query, body) => {
      cloud.requests.push({ method, apiPath, query, body });
      if (cloud.fail) throw new Error(cloud.fail);
      if (method === 'GET') return { code: 0, data: { data_list: cloud.rows, has_more: false } };
      const update = JSON.parse(body.replace(/:(\d{16,})/g, ':"$1"')).update_datas[0];
      const id = String(update.book_id);
      cloud.rows = cloud.rows.filter(item => item.book_id_str !== id || (update.is_delete && cloud.ignoreDelete));
      if (!update.is_delete) cloud.rows.unshift(row(id, { vid_index: update.vid_index, current_play_position: update.current_play_position, read_timestamp_ms: update.read_timestamp_ms }));
      return { code: 0, data: {} };
    },
  };
  const series = [ONE, THREE].map(id => ({ series_id: id, series_title: `本地${id.slice(-1)}`, total: 10, episodes: Array.from({ length: 10 }, (_, i) => ({ vid_index: i + 1, vid: `74${i}` })) }));
  const offline = { search: async () => ({ success: true, results: [] }) };
  const overrides = { electron, './src/store': store, './src/native/account-code': { createCodeClient: () => fakeClient },
    './src/native/hongguo': { fetchEpisodeList: async id => structuredClone(series.find(item => item.series_id === id) || series[0]) }, './src/native/xifan': offline, './src/native/hema': offline };
  const context = vm.createContext({ require: name => overrides[name] || req(name), __dirname: path.dirname(source), process, console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController,
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout() {} });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  vm.runInContext('mainWindow.webContents.send = (channel, payload) => sentLog.push([channel, payload])', Object.assign(context, { sentLog: sent }));
  context.fixture = series;
  context.runSearchSniff = offline.search;
  vm.runInContext('seriesRegistry = fixture', context);
  const call = (name, ...args) => handlers[name]({}, ...args);
  return { call, cloud, sent, timers, playback: () => playback, blob: () => blob, record: () => record, restored: () => restored, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ids = result => result.results.map(item => item.series_id);

test('signed out: this computer only, no account calls', async () => {
  const h = load({ account: false });
  try {
    const result = await h.call('get-watch-history');
    assert.equal(result.sync.mode, 'local');
    assert.deepEqual(ids(result).sort(), [ONE, THREE]);
    assert.equal(h.cloud.requests.length, 0);
  } finally { h.cleanup(); }
});

test('signed in: the account list decides items and counts; newer local progress wins', async () => {
  const h = load();
  try {
    const result = await h.call('get-watch-history');
    assert.equal(result.sync.mode, 'cloud');
    assert.deepEqual(ids(result), [ONE, TWO], 'a local-only drama from before sign-in is not listed');
    assert.equal(result.results[0].vid_index, 7);
    assert.equal(result.results.filter(item => item.completed).length, 1);
    assert.deepEqual(h.cloud.requests[0].query.offset, '0');
    await h.call('get-watch-history');
    assert.equal(h.cloud.requests.length, 1, 'cached briefly');
    await h.call('refresh-watch-history');
    assert.equal(h.cloud.requests.filter(r => r.method === 'GET').length, 2, 'refresh reads the account again');
    const resume = await h.call('get-playback-position', TWO);
    assert.equal(resume.vid_index, 10);
    assert.equal(resume.currentTime, 59.5);
    assert.equal((await h.call('get-playback-position', ONE)).vid_index, 7, 'newer local progress is kept');
  } finally { h.cleanup(); }
});

test('removal goes to the account first, then this computer; an unconfirmed removal keeps everything', async () => {
  const h = load({ server: { ignoreDelete: true } });
  try {
    await h.call('get-watch-history');
    const refused = await h.call('remove-watch-history', ONE);
    assert.equal(refused.success, false);
    assert.match(refused.error, /没有确认移除/);
    assert.ok(h.playback()[ONE], 'local record kept');
    h.cloud.ignoreDelete = false;
    const done = await h.call('remove-watch-history', ONE);
    assert.equal(done.success, true);
    assert.equal(done.cloud, true);
    assert.equal(h.playback()[ONE], undefined);
    const post = h.cloud.requests.filter(r => r.method === 'POST').at(-1);
    assert.match(post.body, /"is_delete":true/);
    assert.match(post.body, new RegExp(`"book_id":${ONE},`));
    assert.deepEqual(ids(await h.call('get-watch-history')), [TWO]);
    const phoneOnly = await h.call('delete-watch-history', TWO);
    assert.equal(phoneOnly.success, true, 'a drama only the phone watched can be removed too');
    assert.deepEqual(ids(await h.call('get-watch-history')), []);
    assert.equal((await h.call('get-watch-history')).sync.mode, 'cloud', 'an empty account is still the account list');
  } finally { h.cleanup(); }
});

test('account unreadable: shows this computer with the reason, and refuses to remove', async () => {
  const h = load({ server: { fail: 'HTTP 500' } });
  try {
    const result = await h.call('get-watch-history');
    assert.equal(result.sync.mode, 'local');
    assert.match(result.sync.error, /HTTP 500/);
    assert.deepEqual(ids(result).sort(), [ONE, THREE]);
    const removed = await h.call('remove-watch-history', ONE);
    assert.equal(removed.success, false);
    assert.ok(h.playback()[ONE]);
    h.cloud.fail = '';
    assert.equal((await h.call('refresh-watch-history')).cloudError, undefined);
    assert.equal((await h.call('get-watch-history')).sync.mode, 'cloud');
  } finally { h.cleanup(); }
});

test('plays while signed in are uploaded and listed as pending until confirmed', async () => {
  const h = load();
  try {
    await h.call('get-watch-history');
    assert.equal((await h.call('save-playback-position', THREE, 2, 9, {})).success, true);
    assert.equal(h.playback()[THREE].cloudPending, 'user-1');
    const pending = await h.call('get-watch-history');
    assert.equal(pending.results.find(item => item.series_id === THREE).synced, false);
    await h.timers.at(-1)();
    const post = h.cloud.requests.filter(r => r.method === 'POST').at(-1);
    assert.match(post.body, /"vid_index":2/);
    assert.match(post.body, /"vid":741,|"vid":741}/, "episode 2 carries its own video id");
    assert.equal(h.playback()[THREE].cloudPending, undefined);
    const listed = await h.call('refresh-watch-history').then(() => h.call('get-watch-history'));
    assert.equal(listed.results.find(item => item.series_id === THREE).synced, true);
  } finally { h.cleanup(); }
});

test('session: another account, no OS encryption, and sign-out never use a stale session', async () => {
  const other = load({ saved: 'user-2' });
  try {
    const result = await other.call('get-watch-history');
    assert.equal(result.sync.mode, 'local');
    assert.match(result.sync.error, /重新登录/);
    assert.equal(other.blob(), '', 'a session for another account is dropped');
    assert.equal(other.cloud.requests.length, 0);
  } finally { other.cleanup(); }
  const plain = load({ encryption: false });
  try {
    assert.equal((await plain.call('get-watch-history')).sync.mode, 'local', 'without OS encryption nothing is restored from disk');
  } finally { plain.cleanup(); }
  const h = load();
  try {
    assert.equal((await h.call('get-watch-history')).sync.mode, 'cloud');
    await h.call('account-logout');
    assert.equal(h.blob(), '');
    assert.equal(h.restored(), null);
    const after = await h.call('get-watch-history');
    assert.equal(after.sync.mode, 'local');
    assert.deepEqual(ids(after).sort(), [ONE, THREE], 'this computer\'s records come back after sign-out');
  } finally { h.cleanup(); }
});
