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

function load({ account = true, saved = '1000000000000001', encryption = true, server = {} } = {}) {
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
    [ONE]: { watched: true, vid_index: 7, currentTime: 5, updatedAt: 5000 },
    [THREE]: { watched: true, vid_index: 1, currentTime: 2, updatedAt: 1000 },
  };
  let record = account ? { userId: '1000000000000001', nickname: '用户名34908929', profileFrom: 'user-info', loggedInAt: Date.now() } : null;
  let blob = saved ? Buffer.from(`enc:${JSON.stringify({ userId: saved, region: '+886', token: 't', cookies: {} })}`).toString('base64') : '';
  const store = {
    getSettings: () => ({}), getPlayback: () => structuredClone(playback), savePlayback: next => { playback = structuredClone(next); }, saveSeries() {},
    getAccount: () => record, saveAccount: next => { record = next; },
    getLoginSession: () => blob, saveLoginSession: value => { blob = value; },
    getLoginDevice: () => null, saveLoginDevice() {},
  };
  const cloud = { favorites: [TWO, '7300000000000000099'], rows: [row(ONE), row(TWO, { vid_index: 10, current_play_position: 59500, read_timestamp_ms: 2500 })], requests: [], fail: '', ignoreDelete: false, ...server };
  let restored = null;
  const fakeClient = {
    restore: session => { restored = session; return true; },
    signedIn: () => !!restored, user: () => restored?.userId || '',
    snapshot: () => restored, reset: () => { restored = null; },
    request: async (method, apiPath, query, body) => {
      cloud.requests.push({ method, apiPath, query, body });
      if (cloud.fail) throw new Error(cloud.fail);
      if (apiPath.includes('bookshelf')) {
        if (cloud.favFail) throw new Error(cloud.favFail);
        if (method === 'GET') return { code: 0, data: { video_shelf_info: cloud.favorites.map(id => ({ series_id: id, collect_time: 1700000000 })) } };
        const change = JSON.parse(body).update_bookshelf_video_list[0];
        if (!cloud.favIgnore) cloud.favorites = change.video_shelf_operate_type === 0 ? [...new Set([...cloud.favorites, change.book_id])] : cloud.favorites.filter(id => id !== change.book_id);
        return { code: 0, data: {} };
      }
      if (method === 'GET') return { code: 0, data: { data_list: cloud.rows, has_more: false, total: cloud.reportedTotal } };
      const update = JSON.parse(body.replace(/:(\d{16,})/g, ':"$1"')).update_datas[0];
      const id = String(update.book_id);
      cloud.rows = cloud.rows.filter(item => item.book_id_str !== id || (update.is_delete && cloud.ignoreDelete) || (!update.is_delete && cloud.dropUploads));
      if (!update.is_delete && !cloud.dropUploads) cloud.rows.unshift(row(id, { vid_index: update.vid_index, current_play_position: update.current_play_position, read_timestamp_ms: update.read_timestamp_ms }));
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

test('signed in: both sides merge; local-only goes up, phone-only comes in, newer progress wins', async () => {
  const h = load();
  try {
    const result = await h.call('get-watch-history');
    assert.equal(result.sync.mode, 'cloud');
    assert.deepEqual(ids(result).sort(), [ONE, TWO, THREE], 'nothing local is hidden, the phone-only drama is added');
    assert.equal(result.results.find(r => r.series_id === ONE).vid_index, 7, 'newer local progress kept');
    assert.equal(result.results.find(r => r.series_id === TWO).series_title, '剧2', 'phone-only drama listed by its account name');
    assert.equal(result.results.filter(item => item.completed).length, 1);
    const posts = h.cloud.requests.filter(r => r.method === 'POST').map(r => r.body);
    assert.ok(posts.some(body => body.includes(`"book_id":${THREE},`)), 'never-synced local record uploaded');
    assert.ok(posts.some(body => body.includes(`"book_id":${ONE},`) && body.includes('"vid_index":7')), 'newer local progress uploaded');
    assert.equal(h.playback()[THREE].cloudSynced, '1000000000000001', 'marked synced only after the account lists it');
    assert.equal(h.playback()[TWO].cloudSynced, '1000000000000001');
    assert.ok(result.results.every(item => item.synced === true));
    const reads = h.cloud.requests.length;
    await h.call('get-watch-history');
    assert.equal(h.cloud.requests.length, reads, 'cached briefly');
    await h.call('refresh-watch-history');
    assert.ok(h.cloud.requests.length > reads, 'refresh reads the account again');
    assert.equal((await h.call('get-playback-position', TWO)).vid_index, 10);
  } finally { h.cleanup(); }
});

test('an upload the account does not list stays unsynced and is never treated as a deletion', async () => {
  const h = load({ server: { dropUploads: true } });
  try {
    await h.call('get-watch-history');
    assert.equal(h.playback()[THREE].cloudSynced, undefined);
    const again = await h.call('refresh-watch-history').then(() => h.call('get-watch-history'));
    assert.ok(ids(again).includes(THREE), 'still listed here');
    assert.equal(again.results.find(r => r.series_id === THREE).synced, false);
  } finally { h.cleanup(); }
});

test('deleted on the phone: a synced drama disappears here on the next sync; an empty account deletes nothing', async () => {
  const h = load();
  try {
    await h.call('get-watch-history');
    h.cloud.rows = h.cloud.rows.filter(item => item.book_id_str !== TWO);
    const after = await h.call('refresh-watch-history').then(() => h.call('get-watch-history'));
    assert.deepEqual(ids(after).sort(), [ONE, THREE]);
    assert.equal(h.playback()[TWO], undefined);
    assert.equal(h.cloud.requests.filter(r => r.method === 'POST' && r.body.includes(`"book_id":${TWO},`)).length, 0, 'not uploaded again');
    h.cloud.rows = [];
    const empty = await h.call('refresh-watch-history').then(() => h.call('get-watch-history'));
    assert.deepEqual(ids(empty).sort(), [ONE, THREE], 'an empty account list removes nothing');
    assert.match(empty.sync.notice, /先保留/);
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
    const listed = await h.call('refresh-watch-history').then(() => h.call('get-watch-history'));
    assert.ok(!ids(listed).includes(ONE), 'the next merge does not bring it back');
    assert.equal((await h.call('delete-watch-history', TWO)).success, true, 'a drama first seen on the phone can be removed too');
    assert.ok(!ids(await h.call('get-watch-history')).includes(TWO));
  } finally { h.cleanup(); }
});

test('account unreadable: this computer only with the reason, nothing changed, removal refused', async () => {
  const h = load({ server: { fail: 'HTTP 500' } });
  try {
    const before = JSON.stringify(h.playback());
    const result = await h.call('get-watch-history');
    assert.equal(result.sync.mode, 'local');
    assert.match(result.sync.error, /HTTP 500/);
    assert.deepEqual(ids(result).sort(), [ONE, THREE]);
    assert.equal(JSON.stringify(h.playback()), before);
    assert.equal((await h.call('remove-watch-history', ONE)).success, false);
    h.cloud.fail = '';
    assert.equal((await h.call('refresh-watch-history')).cloudError, undefined);
    assert.equal((await h.call('get-watch-history')).sync.mode, 'cloud');
  } finally { h.cleanup(); }
});

test('plays while signed in are sent up a few seconds later', async () => {
  const h = load();
  try {
    await h.call('get-watch-history');
    assert.equal((await h.call('save-playback-position', THREE, 2, 9, {})).success, true);
    await h.timers.at(-1)();
    const post = h.cloud.requests.filter(r => r.method === 'POST').at(-1);
    assert.match(post.body, /"vid_index":2/);
    assert.match(post.body, /"vid":741[,}]/, 'episode 2 carries its own video id');
  } finally { h.cleanup(); }
});

test('session: another account, no OS encryption, and sign-out never use a stale session', async () => {
  const other = load({ saved: '1000000000000002' });
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
    assert.deepEqual(ids(after).sort(), [ONE, TWO, THREE], 'records stay on this computer after sign-out, including the one added from the phone');
  } finally { h.cleanup(); }
});

test('favorites: signed out stays local; signed in lists the account with names; changes are confirmed', async () => {
  const out = load({ account: false });
  try {
    assert.equal(JSON.stringify(await out.call('cloud-favorites')), JSON.stringify({ success: true, mode: 'local' }));
    assert.equal((await out.call('cloud-favorite-set', ONE, true)).success, false);
  } finally { out.cleanup(); }
  const h = load();
  try {
    await h.call('get-watch-history');
    const listed = await h.call('cloud-favorites');
    assert.equal(listed.mode, 'cloud', listed.error);
    assert.equal(listed.userId, '1000000000000001');
    assert.equal(listed.rows.find(r => r.id === TWO).title, '剧2', 'name from the account history');
    assert.equal(listed.rows.find(r => r.id === '7300000000000000099').title, '本地1', 'name from one episode-list read');
    assert.equal(JSON.stringify([...(await h.call('cloud-favorite-set', ONE, true)).rows].map(r => r.id).sort()), JSON.stringify([ONE, TWO, '7300000000000000099'].sort()));
    h.cloud.favIgnore = true;
    const refused = await h.call('cloud-favorite-set', TWO, false);
    assert.equal(refused.success, false);
    assert.equal(refused.code, 'CLOUD_FAVORITE_UNCONFIRMED');
    assert.equal((await h.call('cloud-favorite-set', 'hema:1', true)).success, false);
    h.cloud.favFail = 'HTTP 500';
    const failed = await h.call('cloud-favorites');
    assert.equal(failed.mode, 'local');
    assert.match(failed.error, /HTTP 500/);
  } finally { h.cleanup(); }
});


test('a failed refresh never reconciles a stale snapshot or permits account deletion', async () => {
  const h = load();
  try {
    await h.call('get-watch-history');
    const extra = '7300000000000000998';
    h.playback()[extra] = { watched: true, vid_index: 2, currentTime: 1, updatedAt: Date.now(), cloudSynced: '1000000000000001', remote: { title: '刚同步的记录', total: 10 } };
    const progress = () => JSON.stringify(Object.entries(h.playback()).map(([id, r]) => [id, r.vid_index, r.currentTime, r.updatedAt, r.completedEpisode]));
    const before = progress();
    h.cloud.fail = 'HTTP 503';
    await h.call('refresh-watch-history');
    assert.equal(progress(), before, 'the cached older list cannot delete a newer synced record after a failed request');
    assert.equal((await h.call('remove-watch-history', ONE)).success, false);
    assert.ok(h.playback()[extra]);
  } finally { h.cleanup(); }
});

test('reported account total is disclosed separately; visible tab counts use actual records', async () => {
  const h = load({ server: { reportedTotal: 14 } });
  try {
    const result = await h.call('get-watch-history');
    assert.equal(result.results.length, 3);
    assert.match(result.sync.notice, /14.*3/);
  } finally { h.cleanup(); }
});
