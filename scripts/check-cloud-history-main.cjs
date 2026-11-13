
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

function load({ account = true, saved = '1000000000000001', encryption = true, server = {}, clock = null } = {}) {
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
    request: async (method, apiPath, query, body, options) => {
      cloud.requests.push({ method, apiPath, query, body, options });
      if (cloud.folderHandler && apiPath.includes('bookshelf_folder')) return cloud.folderHandler(method, apiPath, query, body, options);
      if (cloud.fail) throw new Error(cloud.fail);
      if (apiPath.includes('bookshelf_folder')) return cloud.folderResponse || { code: 0, data: { folders: [], folder_count: 0, has_more: false } };
      if (apiPath.includes('bookshelf')) {
        if (cloud.favFail) throw new Error(cloud.favFail);
        if (method === 'GET') return { code: 0, data: { video_shelf_info: cloud.favorites.map(id => ({ series_id: id, collect_time: 1700000000 })) } };
        if (cloud.favUpdateFail) throw new Error(cloud.favUpdateFail);
        const change = JSON.parse(body).update_bookshelf_video_list[0];
        if (!cloud.favIgnore) cloud.favorites = change.video_shelf_operate_type === 0 ? [...new Set([...cloud.favorites, change.book_id])] : cloud.favorites.filter(id => id !== change.book_id);
        return { code: 0, data: {} };
      }
      if (method === 'GET') { if (cloud.hold) await cloud.hold; return { code: 0, data: { data_list: cloud.rows, has_more: false, total: cloud.reportedTotal } }; }
      if (cloud.postFail?.(body)) throw new Error('HTTP 502');
      const update = JSON.parse(body.replace(/:(\d{16,})/g, ':"$1"')).update_datas[0];
      const id = String(update.book_id);
      cloud.rows = cloud.rows.filter(item => item.book_id_str !== id || (update.is_delete && (cloud.ignoreDelete || cloud.keepIds?.includes(id))) || (!update.is_delete && cloud.dropUploads));
      if (!update.is_delete && !cloud.dropUploads) cloud.rows.unshift(row(id, { vid_index: update.vid_index, current_play_position: update.current_play_position, read_timestamp_ms: update.read_timestamp_ms }));
      return { code: 0, data: {} };
    },
  };
  const series = [ONE, THREE].map(id => ({ series_id: id, series_title: `本地${id.slice(-1)}`, total: 10, episodes: Array.from({ length: 10 }, (_, i) => ({ vid_index: i + 1, vid: `74${i}` })) }));
  const freshSeries = structuredClone(series);
  const offline = { search: async () => ({ success: true, results: [] }) };
  const overrides = { electron, './src/store': store, './src/native/account-code': { createCodeClient: () => fakeClient },
    './src/native/hongguo': { fetchEpisodeList: async id => { (cloud.catalogReads ||= []).push(id); if (cloud.availability === 'error') throw new Error('HTTP 500'); return cloud.availability === 'offline' ? { episodes: [] } : structuredClone(cloud.catalog || freshSeries.find(item => item.series_id === id) || freshSeries[0]); } }, './src/native/xifan': offline, './src/native/hema': offline };
  overrides['./src/native/hongguo'].fetchSeriesMetadata = async id => ({ ...await overrides['./src/native/hongguo'].fetchEpisodeList(id), series_id: id });
  const context = vm.createContext({ Date: clock === null ? Date : class extends Date { static now() { return typeof clock === 'function' ? clock() : clock; } }, require: name => overrides[name] || req(name), __dirname: path.dirname(source), process, console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController,
    setTimeout: (fn, ms) => { timers.push(Object.assign(fn, { ms })); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  vm.runInContext('mainWindow.webContents.send = (channel, payload) => sentLog.push([channel, payload])', Object.assign(context, { sentLog: sent }));
  context.fixture = series;
  context.runSearchSniff = offline.search;
  vm.runInContext('seriesRegistry = fixture', context);
  const call = (name, ...args) => handlers[name]({}, ...args);
  return { call, cloud, sent, timers, app, registry: () => vm.runInContext('seriesRegistry', context), playback: () => playback, blob: () => blob, record: () => record, restored: () => restored, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
    assert.match(failed.error, /暫時無法同步/);
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

test('existing same-time synced history repairs its completed tab without inventing newer progress', async () => {
  const h = load({ server: { rows: [row(TWO, { vid_index: 10, current_play_position: 0, duration: 12000000, read_timestamp_ms: 2500 })] } });
  try {
    h.playback()[TWO] = { watched: true, vid_index: 10, currentTime: 0, updatedAt: 2500, cloudSynced: '1000000000000001', remote: { title: '剧2', total: 10 } };
    const result = await h.call('get-watch-history');
    assert.equal(result.results.find(r => r.series_id === TWO).completed, true);
    assert.equal(h.playback()[TWO].completedEpisode, 10);
    assert.equal(h.playback()[TWO].currentTime, 0);
    assert.equal(h.playback()[TWO].updatedAt, 2500);
    assert.equal(result.results.filter(r => r.completed).length, 1);
  } finally { h.cleanup(); }
});

test('removal returns the fresh history and both count sources without a page reload', async () => {
  const h = load({ clock: Date.now() + 1000, server: { reportedTotal: 14 } });
  try {
    await h.call('get-watch-history');
    h.cloud.reportedTotal = 13;
    const removed = await h.call('remove-watch-history', ONE);
    assert.equal(removed.success, true);
    assert.equal(removed.history.sync.accountCount, 2);
    assert.equal(removed.history.sync.reportedTotal, 13);
    assert.match(removed.history.sync.notice, /13.*2/);
    assert.ok(!ids(removed.history).includes(ONE));
  } finally { h.cleanup(); }
});

test('unavailable and unconfirmed availability defer only uploads, preserving cancellations', async () => {
  for (const availability of ['offline', 'error']) {
    const h = load({ server: { availability } });
    try {
      const deferred = await h.call('cloud-favorite-set', ONE, true);
      assert.equal(deferred.success, true); assert.equal(deferred.deferred, true);
      assert.ok(!h.cloud.requests.some(row => row.apiPath?.includes('video/update')));
      const cancelled = await h.call('cloud-favorite-set', TWO, false);
      assert.equal(cancelled.success, true); assert.ok(!h.cloud.favorites.includes(TWO));
    } finally { h.cleanup(); }
  }
});

test('removed content is deferred without raw codes; other failures stay friendly and retryable', async () => {
  const h = load({ server: { favUpdateFail: 'CODE 101109' } });
  try {
    const added = await h.call('cloud-favorite-set', ONE, true);
    assert.equal(added.success, true); assert.equal(added.deferred, true);
    assert.doesNotMatch(JSON.stringify(added), /101109|CODE/);
    const cancelled = await h.call('cloud-favorite-set', TWO, false);
    assert.equal(cancelled.success, false); assert.doesNotMatch(cancelled.error, /101109|CODE/);
    h.cloud.favUpdateFail = 'HTTP 500';
    const failed = await h.call('cloud-favorite-set', ONE, true);
    assert.equal(failed.success, false); assert.match(failed.error, /暫時無法同步/);
  } finally { h.cleanup(); }
});

test('stale-account writes and removals are refused before any account request', async () => {
  const h = load();
  try {
    assert.equal((await h.call('cloud-favorite-set', ONE, true, 'other')).success, false);
    assert.equal((await h.call('remove-watch-history', ONE, 'other')).success, false);
    assert.equal(h.cloud.requests.length, 0);
  } finally { h.cleanup(); }
});

test('folder reads are independent from favorites; an error does not turn favorites into an empty list', async () => {
  const h = load({ server: { folderResponse: { code: 120007 } } });
  try {
    const result = await h.call('cloud-favorites');
    assert.equal(result.mode, 'cloud'); assert.equal(result.rows.length, 2);
    assert.match(result.foldersError, /暫時無法讀取/);
    assert.doesNotMatch(JSON.stringify(result), /120007|CODE/);
  } finally { h.cleanup(); }
});

test('history opens the same validated exact episode as search and repairs a saved stale catalog without rewriting progress', async () => {
  const h = load();
  try {
    const entry = h.registry().find(item => item.series_id === ONE);
    entry.episodes[0].vid = '7300000000000999999';
    const before = structuredClone(h.playback());
    assert.equal((await h.call('play-series', { seriesId: ONE, vidIndex: 1, resume: true })).success, true);
    const history = await h.call('get-series-episodes', ONE);
    assert.equal(history.data.episodes[0].vid, '740');
    const repaired = h.registry().find(item => item.series_id === ONE).episodes[0].vid;
    await h.call('search-resolve', ONE);
    const searched = await h.call('get-series-episodes', ONE);
    assert.equal(searched.data.episodes[0].vid, repaired);
    assert.deepEqual(h.playback(), before);
  } finally { h.cleanup(); }
});

test('failed or empty resume refresh keeps the saved catalog and local playback; a missing episode never silently selects the first', async () => {
  const h = load();
  try {
    const before = JSON.stringify(h.registry());
    h.cloud.availability = 'error';
    assert.equal((await h.call('play-series', { seriesId: ONE, vidIndex: 1, resume: true })).success, true);
    assert.equal(JSON.stringify(h.registry()), before);
    h.cloud.availability = 'offline';
    assert.equal((await h.call('play-series', { seriesId: ONE, vidIndex: 1, resume: true })).success, true);
    assert.equal(JSON.stringify(h.registry()), before);
    h.cloud.availability = '';
    h.cloud.catalog = { series_id: ONE, episodes: [{ vid: '7300000000000000999', vid_index: 1 }] };
    const missing = await h.call('play-series', { seriesId: ONE, vidIndex: 7, resume: true });
    assert.equal(missing.success, false); assert.equal(missing.code, 'HISTORY_EPISODE_UNAVAILABLE');
    assert.equal(JSON.stringify(h.registry()), before);
  } finally { h.cleanup(); }
});

test('wrong-series or imprecise catalog data never replaces saved playback metadata', async () => {
  for (const catalog of [{ series_id: TWO, episodes: [{ vid: '7300000000000000999', vid_index: 1 }] }, { series_id: ONE, episodes: [{ vid: 7300000000000000999, vid_index: 1 }] }]) {
    const h = load({ server: { catalog } });
    try {
      const before = JSON.stringify(h.registry());
      await h.call('play-series', { seriesId: ONE, vidIndex: 1, resume: true });
      assert.equal(JSON.stringify(h.registry()), before);
      assert.equal((await h.call('search-resolve', ONE)).success, false);
    } finally { h.cleanup(); }
  }
});

test('folder IPC binds reads and mutations to the session and refuses logged-out or stale-account callers', async () => {
  for (const account of [false, true]) {
    const h = load({ account });
    try {
      const userId = account ? '2000000000000002' : '1000000000000001';
      assert.equal((await h.call('cloud-folder-list', userId)).success, false);
      assert.equal((await h.call('cloud-folder-change', { userId, operation: 'create', name: '桌面夾' })).success, false);
      assert.equal(h.cloud.requests.length, 0);
    } finally { h.cleanup(); }
  }
});
test('folder IPC verifies a new folder, forwards dynamic identity and disables mutation retries', async () => {
  const U = '1000000000000001', F = '7300000000000000101'; let folders = [];
  const h = load({ server: { folderHandler: async (_method, apiPath, _query, body) => {
    if (apiPath.includes('/update/')) {
      const op = JSON.parse(body).operate_data[0];
      assert.equal(op.folder_id, 0); assert.equal(op.operate_type, 1);
      folders = [{ folder_id: F, folder_name: op.folder_name, is_publish: false, item_count: 0, items: [] }];
      return { code: 0, data: {} };
    }
    return { code: 0, data: { folders, folder_count: folders.length, has_more: false } };
  } } });
  try {
    const result = await h.call('cloud-folder-change', { userId: U, operation: 'create', name: '桌面夾' });
    assert.equal(result.success, true); assert.equal(result.userId, U); assert.equal(result.folderId, F);
    assert.equal(h.cloud.requests.filter(row => row.apiPath.includes('/update/')).length, 1);
    for (const row of h.cloud.requests) {
      assert.equal(row.options.expectedUserId, U);
      assert.equal(row.options.retry, !row.apiPath.includes('/update/'));
    }
  } finally { h.cleanup(); }
});

test('zero-episode favorites keep title and poster, and metadata failures never remove favorites', async () => {
  const title = '尚未上線的短劇', cover = 'https://example.com/poster.jpg';
  const h = load({ server: { favorites: [TWO], catalog: { series_id: TWO, series_title: title, cover, total: 0, episodes: [] } } });
  try {
    const first = await h.call('cloud-favorites');
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].title, title);
    assert.equal(first.rows[0].cover, cover);
    h.cloud.availability = 'error';
    const second = await h.call('cloud-favorites');
    assert.equal(second.rows[0].title, title);
    assert.equal(second.rows[0].cover, cover);
    assert.deepEqual(h.cloud.favorites, [TWO]);
    assert.equal(h.cloud.requests.filter(request => request.apiPath === req('./src/native/cloud-favorites').UPDATE_PATH).length, 0);
  } finally { h.cleanup(); }
});

test('missing metadata during an outage leaves every cloud favorite listed without any write', async () => {
  const h = load({ server: { availability: 'error', favorites: [TWO, '7300000000000000099'] } });
  try {
    const result = await h.call('cloud-favorites');
    assert.equal(result.rows.length, 2);
    assert.equal(h.cloud.favorites.length, 2);
    assert.equal(h.cloud.requests.filter(request => request.apiPath === req('./src/native/cloud-favorites').UPDATE_PATH).length, 0);
  } finally { h.cleanup(); }
});

const plain = value => JSON.parse(JSON.stringify(value));
const posts = h => h.cloud.requests.filter(r => r.method === 'POST');
const reads = h => h.cloud.requests.filter(r => r.method === 'GET' && r.apiPath.includes('read_history')).length;

test('continuous playback cannot starve the upload: one timer per drama, sent early, then at most once per interval', async () => {
  let now = Date.now() + 1000;
  const h = load({ clock: () => now });
  try {
    await h.call('get-watch-history');
    const before = h.timers.length, sentBefore = posts(h).length;
    await h.call('save-playback-position', THREE, 2, 5, {});
    assert.equal(h.timers.length, before + 1);
    assert.ok(h.timers.at(-1).ms <= 2000, 'the first save of a drama goes up within a couple of seconds');
    for (const seconds of [10, 15, 20]) { now += 5000; await h.call('save-playback-position', THREE, 2, seconds, {}); }
    assert.equal(h.timers.length, before + 1, 'later saves reuse the pending timer instead of pushing it back');
    assert.ok(!h.timers.at(-1).cleared, 'the pending upload is never cancelled by another save');
    await h.timers.at(-1)();
    assert.equal(posts(h).length, sentBefore + 1);
    assert.match(posts(h).at(-1).body, /"current_play_position":20000/, 'the newest position is what goes up');
    now += 5000;
    await h.call('save-playback-position', THREE, 2, 25, {});
    assert.equal(h.timers.length, before + 2);
    assert.ok(h.timers.at(-1).ms >= 14000 && h.timers.at(-1).ms <= 20000, 'the next upload waits out the interval');
    await h.call('save-playback-position', ONE, 8, 3, {});
    assert.ok(h.timers.at(-1).ms <= 2000, 'another drama has its own schedule');
  } finally { h.cleanup(); }
});

test('a save that lands while an upload is in flight is sent afterwards, not lost', async () => {
  const h = load();
  try {
    await h.call('get-watch-history');
    await h.call('save-playback-position', THREE, 2, 5, {});
    const running = h.timers.at(-1)();
    await h.call('save-playback-position', THREE, 3, 1, {});
    const count = h.timers.length;
    await running;
    assert.equal(h.timers.length, count + 1, 'a follow-up upload is scheduled');
    await h.timers.at(-1)();
    assert.match(posts(h).at(-1).body, /"vid_index":3/);
  } finally { h.cleanup(); }
});

test('quitting sends pending progress first and does nothing when there is none', async () => {
  const h = load();
  try {
    await h.call('get-watch-history');
    let prevented = 0;
    h.app.quit = () => {};
    h.app.emit('before-quit', { preventDefault() { prevented++; } });
    assert.equal(prevented, 0, 'nothing pending: quit is not held back');
    await h.call('save-playback-position', THREE, 2, 9, {});
    const before = posts(h).length;
    h.app.emit('before-quit', { preventDefault() { prevented++; } });
    assert.equal(prevented, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(posts(h).length, before + 1, 'the pending upload went out immediately');
  } finally { h.cleanup(); }
});

test('a background refresh re-reads the account only after a short gap', async () => {
  let now = Date.now() + 1000;
  const h = load({ clock: () => now });
  try {
    await h.call('get-watch-history');
    const first = reads(h);
    await h.call('get-watch-history', { fresh: true });
    assert.equal(reads(h), first, 'asked again right away: reuses the last read');
    now += 16_000;
    h.cloud.rows = h.cloud.rows.filter(item => item.book_id_str !== TWO);
    const result = await h.call('get-watch-history', { fresh: true });
    assert.ok(reads(h) > first);
    assert.ok(!ids(result).includes(TWO), 'a drama removed on the phone disappears here');
    h.cloud.rows.unshift(row('7300000000000000004', { read_timestamp_ms: 9000 }));
    now += 16_000;
    assert.ok(ids(await h.call('get-watch-history', { fresh: true })).includes('7300000000000000004'), 'a drama watched on the phone appears here');
    now += 16_000;
    h.cloud.fail = 'HTTP 500';
    const failed = await h.call('get-watch-history', { fresh: true });
    assert.equal(failed.sync.mode, 'cloud');
    assert.deepEqual(plain(ids(failed)).sort(), plain(ids(result)).concat('7300000000000000004').sort(), 'a failed refresh changes nothing');
  } finally { h.cleanup(); }
});

test('batch removal: one read, one confirmation, per-drama outcomes, nothing unconfirmed is dropped', async () => {
  const h = load({ server: { keepIds: [TWO] } });
  try {
    await h.call('get-watch-history');
    const before = reads(h), postsBefore = posts(h).length;
    const result = await h.call('remove-watch-history-batch', [ONE, TWO, THREE, ONE, '7300000000000000077']);
    assert.equal(result.success, true);
    assert.deepEqual(plain(result.removed).sort(), [ONE, THREE]);
    assert.deepEqual(plain(result.failed).map(item => item.series_id).sort(), [TWO, '7300000000000000077'].sort());
    assert.match(result.failed.find(item => item.series_id === TWO).error, /没有确认移除/);
    assert.match(result.failed.find(item => item.series_id === '7300000000000000077').error, /不在观看记录/);
    assert.equal(reads(h) - before, 2, 'the account list is read once before and once after, not per drama');
    assert.equal(posts(h).length - postsBefore, 3, 'one delete per listed drama, duplicates collapsed');
    assert.equal(h.playback()[ONE], undefined);
    assert.equal(h.playback()[THREE], undefined);
    assert.ok(h.playback()[TWO], 'the unconfirmed drama stays here');
    assert.deepEqual(plain(ids(result.history)), [TWO]);
    assert.deepEqual(plain(h.sent.at(-1)), ['watch-history-updated', { removedSeriesIds: plain(result.removed) }]);
  } finally { h.cleanup(); }
});

test('batch removal: a failed delete request only affects that drama; input and account are validated', async () => {
  const h = load({ server: { postFail: body => body.includes(`"book_id":${ONE},`) && body.includes('"is_delete":true') } });
  try {
    await h.call('get-watch-history');
    for (const bad of [[], 'x', [1], [''], Array.from({ length: 101 }, (_, i) => `73000000000000001${String(i).padStart(2, '0')}`)]) {
      assert.equal((await h.call('remove-watch-history-batch', bad)).success, false);
    }
    assert.equal((await h.call('remove-watch-history-batch', [ONE], 'other')).success, false);
    const result = await h.call('remove-watch-history-batch', [ONE, THREE], '1000000000000001');
    assert.deepEqual(plain(result.removed), [THREE]);
    assert.match(result.failed[0].error, /HTTP 502/);
    assert.ok(h.playback()[ONE]);
    assert.deepEqual(plain(h.sent.at(-1)), ['watch-history-updated', { removedSeriesId: THREE }]);
  } finally { h.cleanup(); }
});

test('batch removal: account unreadable removes nothing; signed out removes on this computer only', async () => {
  const h = load();
  try {
    await h.call('get-watch-history');
    h.cloud.fail = 'HTTP 500';
    const refused = await h.call('remove-watch-history-batch', [ONE, THREE]);
    assert.deepEqual(plain(refused.removed), []);
    assert.equal(refused.failed.length, 2);
    assert.ok(h.playback()[ONE] && h.playback()[THREE]);
  } finally { h.cleanup(); }
  const local = load({ account: false });
  try {
    const result = await local.call('remove-watch-history-batch', [ONE, THREE]);
    assert.deepEqual(plain(result.removed), [ONE, THREE]);
    assert.equal(result.cloud, false);
    assert.equal(local.cloud.requests.length, 0);
    assert.deepEqual(local.playback(), {});
  } finally { local.cleanup(); }
});

test('a refresh that started before a removal cannot bring the removed drama back', async () => {
  const h = load();
  try {
    await h.call('get-watch-history');
    let open;
    h.cloud.hold = new Promise(resolve => { open = resolve; });
    const refresh = h.call('refresh-watch-history');
    const removal = h.call('remove-watch-history', TWO);
    await new Promise(resolve => setImmediate(resolve));
    h.cloud.hold = null; open();
    const [, done] = await Promise.all([refresh, removal]);
    assert.equal(done.success, true);
    assert.equal(h.playback()[TWO], undefined);
    assert.ok(!ids(await h.call('get-watch-history')).includes(TWO));
  } finally { h.cleanup(); }
});

test('removing a drama cancels its pending upload; a failed removal keeps the upload', async () => {
  const h = load({ server: { ignoreDelete: true } });
  try {
    await h.call('get-watch-history');
    await h.call('save-playback-position', ONE, 8, 3, {});
    const pending = h.timers.at(-1);
    assert.equal((await h.call('remove-watch-history', ONE)).success, false);
    assert.ok(pending.cleared, 'held while the removal runs');
    assert.ok(!h.timers.at(-1).cleared && h.timers.at(-1) !== pending, 'rescheduled because the drama is still here');
    h.cloud.ignoreDelete = false;
    const live = h.timers.at(-1), before = posts(h).length;
    assert.equal((await h.call('remove-watch-history', ONE)).success, true);
    assert.ok(live.cleared);
    await live();
    assert.equal(posts(h).length, before + 1, 'only the delete went out; the cancelled upload sends nothing');
  } finally { h.cleanup(); }
});
