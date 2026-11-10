// In-memory records only. Never reads the user's local storage or Electron profile.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function fixture(timers = {}) {
  const storage = new Map(), events = new Map();
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    dispatchEvent: event => events.get(event.type)?.(event), electronAPI: {},
  };
  const load = (file, imports = {}) => {
    const module = { exports: {} };
    const code = transformSync(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs' }).code;
    vm.runInNewContext(code, { module, exports: module.exports, require: name => imports[name] || {}, window, Event, setTimeout, clearTimeout, setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval, ...timers });
    return module.exports;
  };
  const mount = (file, imports = {}, props = {}) => {
    let cursor = 0, tree;
    const slots = [], effects = [], cleanups = new Map();
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
      useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
      useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || !deps || deps.some((value, index) => !Object.is(value, slots[i].deps[index]))) slots[i] = { deps, value: fn() }; return slots[i].value; },
      useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i][j]))) { slots[i] = deps; effects.push(() => { cleanups.get(i)?.(); const cleanup = fn(); if (typeof cleanup === 'function') cleanups.set(i, cleanup); }); } },
    };
    react.useLayoutEffect = react.useEffect;
    const component = load(file, { './usePlaybackNotice': load('components/usePlaybackNotice.js', { react, '../waitingNotice.mjs': load('waitingNotice.mjs') }).default, '../native/folder-rules': require('../src/native/folder-rules'), './useFavoriteSync': { useFavoriteSyncStatus: () => ({ mode: 'local' }) }, '../favoriteView.mjs': load('favoriteView.mjs'), ...imports, react }).default;
    const render = () => { cursor = 0; tree = component(props); effects.splice(0).forEach(fn => fn()); };
    const nodes = () => { const result = []; const visit = n => { if (!n || typeof n !== 'object') return; result.push(n); n.children?.forEach(visit); }; visit(tree); return result; };
    render();
    return { render, unmount: () => { for (const cleanup of cleanups.values()) cleanup(); }, nodes, find: fn => nodes().find(fn), flush: async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } } };
  };
  return { storage, window, load, mount };
}

test('one search history term is removed and a failed write keeps stored history', () => {
  const h = fixture(), search = h.load('searchHistory.js');
  search.saveSearchTerm('甲'); search.saveSearchTerm('乙');
  assert.equal(typeof search.removeSearchTerm, 'function');
  assert.equal(JSON.stringify(search.removeSearchTerm('甲')), '["乙"]');
  h.window.localStorage.setItem = () => { throw new Error('full'); };
  assert.throws(() => search.removeSearchTerm('乙'), /full/);
  assert.equal(JSON.stringify(search.readSearchHistory()), '["乙"]');
});

test('favorite poster survives toggle and removal preserves other records and corrupt storage', () => {
  const h = fixture(), library = h.load('localLibrary.js');
  const first = library.saveLocalSeries({ id: 'a', title: '甲', favorite: true, cover: 'https://fixture.invalid/poster.jpg', published_at: 1700000000000 });
  const stamp = first.items.find(item => item.id === 'a').favorited_at;
  assert.equal(typeof stamp, 'number');
  assert.notEqual(stamp, 1700000000000, 'the heart date is not the public release date');
  assert.equal(library.saveLocalSeries({ id: 'a', title: '甲', favorite: true }).items.find(item => item.id === 'a').favorited_at, stamp);
  library.saveLocalSeries({ id: 'b', title: '乙', favorite: true });
  let saved = library.saveLocalSeries({ id: 'a', title: '甲', favorite: false });
  assert.equal(saved.items.find(item => item.id === 'a').cover, 'https://fixture.invalid/poster.jpg');
  saved = library.removeLocalSeries('a');
  assert.equal(JSON.stringify(saved.items.map(item => item.id)), '["b"]');
  h.window.localStorage.setItem = () => { throw new Error('full'); };
  assert.match(library.removeLocalSeries('b').error, /full/);
  assert.equal(library.readLocalLibrary().items.length, 1);
  h.storage.set('hongguo:public-library:v1', '{broken');
  assert.ok(library.removeLocalSeries('b').error);
  assert.equal(h.storage.get('hongguo:public-library:v1'), '{broken');
});

test('an upcoming favorite keeps its online day and an old record still loads', () => {
  const h = fixture(), library = h.load('localLibrary.js');
  const when = Date.parse('2026-12-31T00:00:00+08:00');
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true, online_time: when });
  assert.equal(library.readLocalLibrary().items[0].online_time, when);
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true });
  assert.equal(library.readLocalLibrary().items[0].online_time, when, 'a later save without the field keeps the online day');
  h.storage.set('hongguo:public-library:v1', JSON.stringify([{ id: 'b', title: '乙', favorite: true, published_at: null, favorited_at: when, cover: '' }]));
  const legacy = library.readLocalLibrary();
  assert.equal(legacy.error, '');
  assert.equal(legacy.items[0].online_time, null);
  h.storage.set('hongguo:public-library:v1', JSON.stringify([{ id: 'c', title: '丙', favorite: true, published_at: null, favorited_at: when, cover: '', online_time: 'soon' }]));
  const messy = library.readLocalLibrary();
  assert.equal(messy.error, '');
  assert.equal(messy.items[0].online_time, null);
  assert.equal(messy.items[0].title, '丙');
});

test('a scheduled favorite waits, and a confirmed episode list restores play', async () => {
  const h = fixture(), library = h.load('localLibrary.js');
  const future = Date.parse('2026-12-31T00:00:00+08:00');
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true, online_time: future });
  const played = [], notes = [];
  const waiting = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library }, { onPlay: item => played.push(item), onUnavailable: message => notes.push(message) });
  assert.match(waiting.find(n => n.props.className === 'release-online').children.join(''), /预计上线日期12月31日/);
  waiting.find(n => n.props['aria-label'] === '播放《甲》').props.onClick();
  assert.equal(played.length, 0);
  assert.match(notes[0], /尚未上线/);
  library.saveLocalSeries({ id: 'b', title: '乙', favorite: true, online_time: Date.now() - 1000 });
  h.window.electronAPI.inspectRelease = async ids => ({ success: true, results: ids.map(item => ({ id: item.id, playable: item.id === 'b' })) });
  const ready = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library }, { onPlay: item => played.push(item), onUnavailable: message => notes.push(message) });
  await ready.flush();
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(text).join('') || '';
  const rowFor = title => ready.nodes().find(node => node.props.className === 'release-row' && text(node).includes(title));
  assert.equal(rowFor('乙').children.some(node => text(node).includes('预计上线日期')), false);
  assert.match(text(rowFor('甲')), /预计上线日期12月31日/);
  ready.find(n => n.props['aria-label'] === '播放《乙》').props.onClick();
  assert.equal(played.at(-1).seriesId, 'b');
  ready.find(n => n.props['aria-label'] === '播放《甲》').props.onClick();
  assert.equal(played.filter(item => item.seriesId === 'a').length, 0);
});

test('search x deletes a term without selecting it or starting a search', async () => {
  const h = fixture(), search = h.load('searchHistory.js');
  search.saveSearchTerm('甲'); search.saveSearchTerm('乙');
  const media = { sources: [{ id: 'hongguo', label: '红果' }], revision: 0, loading: false };
  const ui = h.mount('components/SearchPanel.jsx', { '../searchHistory': search, './useMediaSources': { default: () => media, __esModule: true } });
  const remove = ui.find(n => n.props['aria-label'] === '删除搜索历史：甲');
  assert.ok(remove);
  remove.props.onClick(); await ui.flush();
  assert.equal(JSON.stringify(search.readSearchHistory()), '["乙"]');
  assert.equal(ui.find(n => n.type === 'input').props.value, '');
  assert.ok(!ui.find(n => n.props['aria-label'] === '删除搜索历史：甲'));
});

test('watch row removal calls only the removal API and retains row on error', async () => {
  const h = fixture(); let fail = true, calls = 0;
  h.window.electronAPI = {
    getWatchHistory: async () => ({ success: true, results: [{ series_id: 'a', series_title: '甲', vid_index: 1, total: 2, updatedAt: Date.now() }] }),
    removeWatchHistory: async id => { assert.equal(id, 'a'); calls++; return fail ? { success: false, error: 'fixture failure' } : { success: true }; },
  };
  const ui = h.mount('components/WatchHistory.jsx'); await ui.flush();
  const remove = () => ui.find(n => n.props['aria-label'] === '从观看记录移除 甲');
  const confirm = () => ui.find(n => n.props['aria-label'] === '确认从观看记录移除 甲');
  assert.ok(remove());
  await remove().props.onClick(); await ui.flush();
  assert.equal(calls, 0, 'the first click only asks for confirmation');
  assert.ok(confirm());
  await confirm().props.onClick(); await ui.flush();
  assert.ok(remove(), 'failed persistence must retain the row');
  assert.ok(ui.find(n => n.props.role === 'alert'));
  fail = false;
  await remove().props.onClick(); await ui.flush();
  await confirm().props.onClick(); await ui.flush();
  assert.equal(calls, 2); assert.ok(!remove());
});

test('watch filters require completion evidence and retain resume, removal, counts and update behavior', async () => {
  const h = fixture(); let updated, played, removed;
  let rows = [
    { series_id: 'done', series_title: '已到片尾', vid_index: 2, total: 2, completed: true },
    { series_id: 'partial', series_title: '末集未完', vid_index: 2, total: 2, completed: false },
    { series_id: 'legacy', series_title: '旧记录', vid_index: 2, total: 2 },
  ].map(row => ({ ...row, currentTime: 30, updatedAt: Date.now() }));
  h.window.electronAPI = {
    getWatchHistory: async () => ({ success: true, results: rows }),
    onWatchHistoryUpdated: fn => { updated = fn; return () => {}; },
    playSeries: async request => { played = request; return { success: true }; },
    acknowledgeWatchUpdates: async () => ({ success: true }),
    removeWatchHistory: async id => { removed = id; rows = rows.filter(row => row.series_id !== id); return { success: true }; },
  };
  const ui = h.mount('components/WatchHistory.jsx'); await ui.flush();
  const filter = label => ui.find(n => n.type === 'button' && n.children.join('') === label);
  const visible = () => ui.nodes().filter(n => n.props.className === 'history-name').map(n => n.children.filter(c => typeof c === 'string').join(''));
  assert.ok(filter('全部 3'), 'all filter and its total must be visible');
  assert.equal(filter('全部 3').props['aria-pressed'], true);
  filter('未看完 2').props.onClick(); await ui.flush();
  assert.deepEqual(visible(), ['末集未完', '旧记录']);
  filter('已看完 1').props.onClick(); await ui.flush();
  assert.deepEqual(visible(), ['已到片尾']);
  await ui.find(n => n.props.className === 'history-resume').props.onClick(); await ui.flush();
  assert.equal(JSON.stringify(played), JSON.stringify({ seriesId: 'done', vidIndex: 2, resume: true }));
  rows = rows.map(row => row.series_id === 'done' ? { ...row, total: 3, completed: false } : row);
  updated(); await ui.flush();
  assert.ok(filter('已看完 0'));
  assert.deepEqual(visible(), []);
  assert.ok(ui.find(n => n.type === 'h2' && n.children.includes('还没有已看完的短剧')));
  filter('查看全部').props.onClick(); await ui.flush();
  assert.equal(visible().length, 3);
  filter('未看完 3').props.onClick(); await ui.flush();
  await ui.find(n => n.props['aria-label'] === '从观看记录移除 旧记录').props.onClick(); await ui.flush();
  assert.equal(removed, undefined, 'filtering still requires a second click before removal');
  await ui.find(n => n.props['aria-label'] === '确认从观看记录移除 旧记录').props.onClick(); await ui.flush();
  assert.equal(removed, 'legacy');
  assert.ok(filter('全部 2')); assert.ok(filter('未看完 2'));
  rows = rows.map(row => ({ ...row, completed: true })); updated(); await ui.flush();
  assert.ok(ui.find(n => n.type === 'h2' && n.children.includes('没有未看完的短剧')));
});

test('calendar displays saved poster and removes only the selected entry', () => {
  const h = fixture(), library = h.load('localLibrary.js');
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true, cover: 'https://fixture.invalid/poster.jpg' });
  library.saveLocalSeries({ id: 'b', title: '乙', favorite: false });
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library });
  assert.equal(ui.find(n => n.type === 'img')?.props.src, 'https://fixture.invalid/poster.jpg');
  const remove = ui.find(n => n.props['aria-label'] === '移除《甲》');
  assert.ok(remove); remove.props.onClick(); ui.render();
  assert.equal(JSON.stringify(library.readLocalLibrary().items.map(item => item.id)), '["b"]');
});

test('favorites page: one newest-first list, no month picker, filter buttons by state and category', () => {
  const h = fixture(), library = h.load('localLibrary.js');
  const realNow = Date.now;
  try {
    let clock = Date.parse('2025-01-10T12:00:00+08:00');
    Date.now = () => clock;
    library.saveLocalSeries({ id: 'a', title: '一月真人', favorite: true, category: 'real' });
    clock = Date.parse('2025-06-10T12:00:00+08:00');
    library.saveLocalSeries({ id: 'b', title: '六月AI', favorite: true, category: 'ai' });
    clock = Date.parse('2026-03-10T12:00:00+08:00');
    library.saveLocalSeries({ id: 'c', title: '等上线', favorite: true, online_time: Date.parse('2027-01-01T00:00:00+08:00') });
    library.saveLocalSeries({ id: 'd', title: '不在清单', favorite: false });
    library.saveLocalSeries({ id: 'b', title: '六月AI', favorite: true, category: 'bogus' });
    assert.equal(library.readLocalLibrary().items.find(item => item.id === 'b').category, 'ai', 'an unknown label keeps the earlier category');
  } finally { Date.now = realNow; }
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library });
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(text).join('') || '';
  assert.equal(ui.nodes().some(n => n.type === 'select' && n.props.id !== 'favorite-folder'), false, 'no month dropdown');
  const titles = () => ui.nodes().filter(n => n.props.className === 'release-row').map(n => text(n.children[1].children[0]));
  assert.deepEqual(titles(), ['六月AI', '一月真人', '等上线']);
  const reserved = ui.find(n => n.type === 'details' && n.props.className === 'release-reserved');
  assert.ok(reserved); assert.notEqual(reserved.props.open, true, 'reservations start collapsed');
  assert.ok(text(reserved).includes('等上线'));
  const filter = label => ui.nodes().find(n => n.type === 'button' && text(n) === label);
  assert.ok(filter('全部 3')); assert.ok(filter('可播放 2')); assert.ok(filter('尚未上线 1')); assert.ok(filter('真人剧 1')); assert.ok(filter('AI 剧 1'));
  assert.ok(filter('漫剧 0'), 'the comic filter stays visible even with no categorized rows');
  filter('漫剧 0').props.onClick(); ui.render();
  assert.deepEqual(titles(), []);
  assert.ok(ui.nodes().some(n => text(n) === '这个筛选下没有收藏。'));
  filter('AI 剧 1').props.onClick(); ui.render();
  assert.deepEqual(titles(), ['六月AI']);
  assert.equal(filter('AI 剧 1').props['aria-pressed'], true);
  filter('尚未上线 1').props.onClick(); ui.render();
  assert.deepEqual(titles(), ['等上线']);
  ui.find(n => n.props['aria-label'] === '移除《等上线》').props.onClick(); ui.render();
  assert.ok(ui.nodes().some(n => text(n) === '这个筛选下没有收藏。'));
  filter('全部 2').props.onClick(); ui.render();
  assert.deepEqual(titles(), ['六月AI', '一月真人']);
});

test('legacy calendar uses local catalog posters without restoring removed rows', async () => {
  const h = fixture(), library = h.load('localLibrary.js');
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true });
  let resolve;
  h.window.electronAPI.getSeriesList = () => new Promise(done => { resolve = done; });
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library });
  assert.equal(typeof resolve, 'function');
  resolve([{ series_id: 'a', cover: 'https://fixture.invalid/old.jpg' }]); await ui.flush();
  assert.equal(ui.find(n => n.type === 'img')?.props.src, 'https://fixture.invalid/old.jpg');
  ui.find(n => n.props['aria-label'] === '移除《甲》').props.onClick(); await ui.flush();
  assert.equal(library.readLocalLibrary().items.length, 0);
  assert.ok(!ui.find(n => n.type === 'img'));
});

test('signed-in history: says it is the phone list, counts follow the account rows, removal says it includes the phone, phone-only rows resolve then resume', async () => {
  const h = fixture(); let played = [], resolved = [], sync = { mode: 'cloud', syncedAt: Date.now() };
  let rows = [
    { series_id: '7300000000000000001', series_title: '手机看过', vid_index: 5, total: 80, completed: false, currentTime: 12, updatedAt: Date.now(), synced: true },
    { series_id: '7300000000000000002', series_title: '手机看完', vid_index: 80, total: 80, completed: true, currentTime: 88, updatedAt: Date.now() - 1, synced: true },
    { series_id: '7300000000000000003', series_title: '刚播放', vid_index: 1, total: 10, completed: false, currentTime: 3, updatedAt: Date.now() - 2, synced: false },
  ];
  h.window.electronAPI = {
    getWatchHistory: async () => ({ success: true, results: rows, sync }),
    playSeries: async request => { played.push(request); return played.length === 1 ? { success: false, code: 'SERIES_NOT_FOUND', error: '未找到短剧档案' } : { success: true }; },
    searchResolve: async id => { resolved.push(id); return { success: true, data: { episodes: [] } }; },
    acknowledgeWatchUpdates: async () => ({ success: true }),
    removeWatchHistory: async id => { rows = rows.filter(row => row.series_id !== id); return { success: true, cloud: true }; },
  };
  const ui = h.mount('components/WatchHistory.jsx'); await ui.flush();
  const text = () => ui.nodes().flatMap(n => n.children || []).filter(c => typeof c === 'string').join('|');
  const filter = label => ui.find(n => n.type === 'button' && n.children.join('') === label);
  assert.ok(text().includes('已登录：与手机「历史」双向同步。'));
  assert.ok(filter('全部 3') && filter('未看完 2') && filter('已看完 1'));
  assert.ok(text().includes('等待同步到手机…'), 'a record not yet confirmed by the account is marked');
  await ui.find(n => n.props.className === 'history-resume').props.onClick(); await ui.flush();
  assert.deepEqual(resolved, ['7300000000000000001'], 'a phone-only drama loads its episodes first');
  assert.equal(JSON.stringify(played.at(-1)), JSON.stringify({ seriesId: '7300000000000000001', vidIndex: 5, resume: true }));
  await ui.find(n => n.props['aria-label'] === '从观看记录移除 手机看完').props.onClick(); await ui.flush();
  const confirm = ui.find(n => n.props['aria-label'] === '确认从观看记录移除 手机看完');
  assert.ok(confirm.children.includes('确认移除（含手机）'));
  await confirm.props.onClick(); await ui.flush();
  assert.ok(filter('全部 2') && filter('已看完 0'));
  assert.ok(text().includes('已從帳號歷史移除《手机看完》'));
});

test('history falls back to this computer with the reason when the account cannot be read', async () => {
  const h = fixture();
  h.window.electronAPI = {
    getWatchHistory: async () => ({ success: true, results: [{ series_id: 'a', series_title: '甲', vid_index: 1, total: 2, updatedAt: Date.now() }], sync: { mode: 'local', error: '手机历史暂时读不到，先显示这台电脑的记录（HTTP 500）' } }),
  };
  const ui = h.mount('components/WatchHistory.jsx'); await ui.flush();
  const text = ui.nodes().flatMap(n => n.children || []).filter(c => typeof c === 'string').join('|');
  assert.ok(text.includes('未同步：记录仅保存在这台电脑。'));
  assert.ok(text.includes('手机历史暂时读不到'));
  assert.ok(ui.find(n => n.type === 'button' && n.children.join('') === '全部 1'));
});

test('favorites with an account: merge once, follow phone removals, send local changes, keep not-yet-online here', async () => {
  const h = fixture(), library = h.load('localLibrary.js'), plan = h.load('favoriteSync.mjs');
  const U = '1234567890123456';
  library.saveLocalSeries({ id: '7300000000000000001', title: '本机', favorite: true });
  library.saveLocalSeries({ id: '7300000000000000005', title: '未上线', favorite: true, online_time: Date.now() + 86400000 });
  let cloud = ['7300000000000000002'];
  const sent = [];
  h.window.electronAPI = {
    cloudFavorites: async () => ({ success: true, mode: 'cloud', userId: U, rows: cloud.map(id => ({ id, favoritedAt: 1700000000000, title: `手机${id.slice(-1)}`, cover: '' })) }),
    cloudFavoriteSet: async (id, on) => { sent.push([id, on]); cloud = on ? [...new Set([...cloud, id])] : cloud.filter(x => x !== id); return { success: true, rows: cloud.map(x => ({ id: x })) }; },
  };
  const refs = [], effects = [];
  let refCursor = 0;
  const react = {
    useRef: initial => { const i = refCursor++; return refs[i] ||= { current: initial }; },
    useEffect: fn => { effects.push(fn); },
    useSyncExternalStore: (_s, get) => get(),
  };
  const hook = h.load('components/useFavoriteSync.js', { react, '../localLibrary': library, '../favoriteSync.mjs': plan });
  const cleanups = [];
  refCursor = 0; hook.default(true); effects.splice(0).forEach(fn => cleanups.push(fn()));
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
  try {
  await settle();
  const favs = () => [...library.readLocalLibrary().items].filter(i => i.favorite).map(i => i.id).sort();
  assert.deepEqual(favs(), ['7300000000000000001', '7300000000000000002', '7300000000000000005']);
  assert.deepEqual(sent, [['7300000000000000001', true]], 'only the playable local favorite goes up');
  assert.deepEqual(cloud.sort(), ['7300000000000000001', '7300000000000000002']);
  assert.equal(hook.favoriteSyncStatus().mode, 'cloud');
  assert.equal(library.readLocalLibrary().items.find(i => i.id === '7300000000000000002').title, '手机2');
  // Removed on the phone (seen on the next sync).
  cloud = ['7300000000000000001'];
  // Un-favorite here: recorded as a cancellation and sent.
  library.saveLocalSeries({ id: '7300000000000000001', title: '本机', favorite: false });
  await new Promise(r => setTimeout(r, 1700)); await settle();
  assert.deepEqual(sent.at(-1), ['7300000000000000001', false]);
  assert.ok(!cloud.includes('7300000000000000001'));
  assert.ok(favs().includes('7300000000000000005'), 'not-yet-online stays');
  assert.ok(!favs().includes('7300000000000000002'), 'the phone removal reached this computer');
  // Account unreadable: nothing is cleared, the reason is shown.
  h.window.electronAPI.cloudFavorites = async () => ({ success: true, mode: 'local', error: '手机收藏暂时读不到' });
  library.saveLocalSeries({ id: '7300000000000000007', title: '新', favorite: true });
  await new Promise(r => setTimeout(r, 1700)); await settle();
  assert.equal(hook.favoriteSyncStatus().mode, 'local');
  assert.match(hook.favoriteSyncStatus().error, /暫時無法同步/);
  assert.ok(favs().includes('7300000000000000007'));
  } finally { cleanups.forEach(fn => typeof fn === 'function' && fn()); }
});

test('history returns fresh counts immediately, orders completed first, and fades the removal toast with cleanup', async () => {
  const timers = new Map(); let nextTimer = 0;
  const h = fixture({ setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout: id => timers.delete(id) });
  let rows = [{ series_id: 'a', series_title: '甲', completed: true }, { series_id: 'b', series_title: '乙', completed: false }];
  const snapshot = () => ({ success: true, results: rows, sync: { mode: 'cloud', userId: '123456', notice: `帳號回報 ${rows.length + 1} 部，已讀取 ${rows.length} 部` } });
  h.window.electronAPI = { getWatchHistory: async () => snapshot(), removeWatchHistory: async () => { rows = rows.slice(1); return { success: true, cloud: true, history: snapshot() }; } };
  const ui = h.mount('components/WatchHistory.jsx'); await ui.flush();
  const labels = () => ui.nodes().filter(n => n.type === 'button' && n.props['aria-pressed'] !== undefined).map(n => n.children.join(''));
  assert.deepEqual(labels(), ['全部 2', '已看完 1', '未看完 1']);
  ui.find(n => n.props['aria-label'] === '从观看记录移除 甲').props.onClick(); ui.render();
  await ui.find(n => n.props['aria-label'] === '确认从观看记录移除 甲').props.onClick(); await ui.flush();
  const text = () => ui.nodes().flatMap(n => n.children || []).filter(x => typeof x === 'string').join('|');
  assert.ok(text().includes('帳號回報 2 部，已讀取 1 部'));
  assert.deepEqual(labels(), ['全部 1', '已看完 0', '未看完 1']);
  assert.ok(ui.find(n => n.props.className === 'record-toast' && n.props.role === 'status'));
  const timeout = [...timers.values()].find(timer => timer.ms === 4500);
  assert.ok(timeout); timeout.fn(); ui.render();
  assert.ok(!ui.find(n => n.props.className === 'record-toast'));
  ui.unmount(); assert.equal(timers.size, 0);
});

test('favorites show mobile folders, filter by membership, swap comic before AI, hide raw codes and update counts on removal', async () => {
  const h = fixture(), library = h.load('localLibrary.js');
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true, category: 'comic', cloud_user: '123456' });
  library.saveLocalSeries({ id: 'b', title: '乙', favorite: true, category: 'ai', cloud_user: '123456' });
  const sync = { mode: 'cloud', userId: '123456', error: 'CODE 101109', folders: [{ id: '999999', name: 'TEST', itemIds: ['a'] }] };
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library, './useFavoriteSync': { useFavoriteSyncStatus: () => sync } }); await ui.flush();
  const text = () => ui.nodes().flatMap(n => n.children || []).filter(x => typeof x === 'string').join('|');
  assert.doesNotMatch(text(), /101109|CODE/);
  const filters = ui.nodes().filter(n => n.type === 'button' && n.props['aria-pressed'] !== undefined).map(n => n.children.join(''));
  assert.ok(filters.indexOf('漫剧 1') < filters.indexOf('AI 剧 1'));
  ui.find(n => n.type === 'select').props.onChange({ target: { value: '999999' } }); ui.render();
  assert.equal(ui.nodes().filter(n => n.props.className === 'release-row').length, 1);
  ui.find(n => n.props['aria-label'] === '取消收藏《甲》').props.onClick(); ui.render();
  assert.ok(ui.find(n => n.props.className === 'release-coverage').children.join('').includes('收藏 1 部'));
  assert.equal(ui.nodes().filter(n => n.props.className === 'release-row').length, 0);
  assert.ok(ui.find(n => n.type === 'button' && n.children.join('') === '全部 0'));
  ui.unmount();
});

function mountSync(h, library) {
  const slots = [], effects = [], cleanups = new Map(), depsBySlot = new Map(); let cursor = 0;
  const react = {
    useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
    useEffect: (fn, deps) => { const i = cursor++, before = depsBySlot.get(i); if (!before || deps.some((value, index) => !Object.is(value, before[index]))) { depsBySlot.set(i, deps); effects.push(() => { cleanups.get(i)?.(); cleanups.set(i, fn()); }); } },
    useSyncExternalStore: (_subscribe, get) => get(),
  };
  const hook = h.load('components/useFavoriteSync.js', { react, '../localLibrary': library, '../favoriteSync.mjs': h.load('favoriteSync.mjs') });
  return { hook, render: loggedIn => { cursor = 0; hook.default(loggedIn); effects.splice(0).forEach(fn => fn()); }, unmount: () => { for (const cleanup of cleanups.values()) cleanup?.(); }, flush: async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); } };
}

test('deferred favorites stay local; offline cancellations persist; confirmed empty folders clear stale cache', async () => {
  let interval; const timeouts = [];
  const h = fixture({ setTimeout: fn => { timeouts.push(fn); return timeouts.length; }, clearTimeout() {}, setInterval: fn => { interval = fn; return 1; }, clearInterval() {} });
  const library = h.load('localLibrary.js'), U = '1234567890123456', A = '7300000000000000001', B = '7300000000000000002';
  const folder = { id: '7700000000000000001', name: 'TEST', itemIds: [A] };
  h.storage.set('hongguo:favorite-folders:v1', '{broken');
  library.saveLocalSeries({ id: B, title: '未確認上線', favorite: true, online_time: Date.now() - 1000 });
  let cloud = [A], folders = [folder], offline = false; const sent = [];
  h.window.electronAPI = {
    cloudFavorites: async () => offline ? { success: true, mode: 'local', userId: U, error: 'CODE 101109' } : { success: true, mode: 'cloud', userId: U, folders, rows: cloud.map(id => ({ id, favoritedAt: Date.now() })) },
    cloudFavoriteSet: async (id, on, userId) => { assert.equal(userId, U); sent.push([id, on]); if (on) return { success: true, userId: U, deferred: true }; cloud = cloud.filter(value => value !== id); return { success: true, userId: U, rows: [] }; },
  };
  const mounted = mountSync(h, library); mounted.render(true); await mounted.flush();
  try {
    assert.equal(library.readLocalLibrary().items.find(item => item.id === B).cloud_user, null);
    assert.equal(library.readLocalLibrary().items.find(item => item.id === B).favorite, true);
    assert.equal(mounted.hook.favoriteSyncStatus().folders.length, 1);
    assert.match(mounted.hook.favoriteSyncStatus().notice, /先保留/);
    folders = []; interval(); await mounted.flush(); assert.equal(mounted.hook.favoriteSyncStatus().folders.length, 0);
    offline = true; interval(); await mounted.flush();
    library.saveLocalSeries({ id: A, title: '甲', favorite: false });
    timeouts.at(-1)(); await mounted.flush();
    assert.ok(JSON.parse(h.storage.get('hongguo:favorite-cancels:v1')).ids.includes(A));
    assert.equal(mounted.hook.favoriteSyncStatus().folders.length, 0);
    assert.doesNotMatch(mounted.hook.favoriteSyncStatus().error, /101109|CODE/);
    offline = false; interval(); await mounted.flush();
    assert.ok(sent.some(([id, on]) => id === A && !on));
    assert.equal(library.readLocalLibrary().items.find(item => item.id === A).favorite, false);
  } finally { mounted.unmount(); }
});

test('late replies from a signed-out account cannot import records or folders into the next account', async () => {
  let resolveOld; const h = fixture({ setInterval: () => 1, clearInterval() {} }), library = h.load('localLibrary.js');
  h.window.electronAPI.cloudFavorites = () => new Promise(resolve => { resolveOld = resolve; });
  const mounted = mountSync(h, library); mounted.render(true);
  mounted.render(false);
  h.window.electronAPI.cloudFavorites = async () => ({ success: true, mode: 'cloud', userId: '222222', rows: [], folders: [] });
  mounted.render(true);
  resolveOld({ success: true, mode: 'cloud', userId: '111111', rows: [{ id: '7300000000000000001', favoritedAt: 1000 }], folders: [{ id: '7700000000000000001', name: 'Old', itemIds: [] }] });
  await mounted.flush();
  try {
    assert.equal(library.readLocalLibrary().items.length, 0);
    assert.equal(mounted.hook.favoriteSyncStatus().userId, '222222');
    assert.equal(mounted.hook.favoriteSyncStatus().folders.length, 0);
  } finally { mounted.unmount(); }
});

test('unfavorite during an in-flight first upload is queued for confirmed account cancellation', async () => {
  const h = fixture({ setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
  const library = h.load('localLibrary.js'), A = '7300000000000000001', U = '1234567890123456';
  library.saveLocalSeries({ id: A, title: '甲', favorite: true });
  let cloud = [], finishUpload; const sent = [];
  h.window.electronAPI = {
    cloudFavorites: async () => ({ success: true, mode: 'cloud', userId: U, rows: cloud.map(id => ({ id, favoritedAt: Date.now() })) }),
    cloudFavoriteSet: async (id, on) => {
      sent.push([id, on]);
      if (on) return new Promise(resolve => { finishUpload = () => { cloud = [A]; resolve({ success: true, userId: U, rows: [{ id: A }] }); }; });
      cloud = []; return { success: true, userId: U, rows: [] };
    },
  };
  const mounted = mountSync(h, library); mounted.render(true); await mounted.flush();
  library.saveLocalSeries({ id: A, title: '甲', favorite: false });
  finishUpload(); await mounted.flush();
  try {
    assert.deepEqual(sent, [[A, true], [A, false]]);
    assert.equal(library.readLocalLibrary().items.find(item => item.id === A).favorite, false);
    assert.deepEqual(cloud, []);
  } finally { mounted.unmount(); }
});

function folderSyncFixture() {
  let interval;
  const h = fixture({ setTimeout: () => 1, clearTimeout() {}, setInterval: fn => { interval = fn; return 1; }, clearInterval() {} });
  const library = h.load('localLibrary.js'), U = '1000000000000001', F = '7300000000000000101', A = '7300000000000000201';
  let folders = [{ id: F, name: '測試夾', revision: 'fixture-r1', itemCount: 1, itemIds: [A] }];
  const calls = [];
  h.window.electronAPI = {
    cloudFavorites: async () => ({ success: true, mode: 'cloud', userId: U, rows: [{ id: A }], folders }),
    cloudFolderList: async userId => ({ success: true, userId, folders }),
    cloudFolderChange: async input => { calls.push(input); return { success: true, userId: U, folders }; },
  };
  const mounted = mountSync(h, library);
  return { h, library, U, F, A, calls, mounted, start: async () => { mounted.render(true); await mounted.flush(); }, setFolders: value => { folders = value; }, tick: () => interval() };
}
test('folder actions bind to the current session, refuse logged-out and offline writes, and never queue them', async () => {
  const x = folderSyncFixture();
  try {
    assert.equal((await x.mounted.hook.changeFavoriteFolder({ operation: 'create', name: '新夾' })).success, false);
    await x.start();
    x.h.window.navigator = { onLine: false };
    assert.equal((await x.mounted.hook.changeFavoriteFolder({ operation: 'create', name: '新夾' })).success, false);
    assert.equal(x.calls.length, 0);
    x.h.window.navigator.onLine = true;
    await x.mounted.hook.changeFavoriteFolder({ operation: 'rename', folderId: x.F, name: '改名', userId: '2000000000000002' });
    assert.equal(x.calls[0].userId, x.U);
    assert.equal(x.calls.length, 1);
  } finally { x.mounted.unmount(); }
});
test('failed and incomplete folder replies preserve cache, but verified empty refresh and login clear it', async () => {
  const x = folderSyncFixture(); await x.start();
  try {
    x.h.window.electronAPI.cloudFolderList = async () => ({ success: false, userId: x.U, folders: [] });
    assert.equal((await x.mounted.hook.refreshFavoriteFolders()).success, false);
    assert.equal(x.mounted.hook.favoriteSyncStatus().folders.length, 1);
    assert.equal(x.mounted.hook.favoriteSyncStatus().foldersStale, true);
    x.h.window.electronAPI.cloudFolderList = async () => ({ success: true, userId: x.U });
    assert.equal((await x.mounted.hook.refreshFavoriteFolders()).success, false);
    assert.equal(x.mounted.hook.favoriteSyncStatus().folders.length, 1);
    x.h.window.electronAPI.cloudFolderList = async () => ({ success: true, userId: x.U, folders: [] });
    assert.equal((await x.mounted.hook.refreshFavoriteFolders()).success, true);
    assert.equal(x.mounted.hook.favoriteSyncStatus().folders.length, 0);
    assert.equal(x.mounted.hook.favoriteSyncStatus().foldersStale, false);
    assert.equal(x.mounted.hook.favoriteSyncStatus().folderBusy, false);
    assert.match(x.mounted.hook.favoriteSyncStatus().folderNotice, /共 0 個/);
    const firstNotice = x.mounted.hook.favoriteSyncStatus().folderNoticeId;
    assert.ok(x.mounted.hook.favoriteSyncStatus().folderNoticeUntil > Date.now());
    await x.mounted.hook.refreshFavoriteFolders();
    assert.ok(x.mounted.hook.favoriteSyncStatus().folderNoticeId > firstNotice, 'repeated identical results get a fresh dismissal lifetime');
    assert.equal(JSON.parse(x.h.storage.get('hongguo:favorite-folders:v1')).folders.length, 0);
    x.setFolders([]);
    x.mounted.render(false); await x.mounted.flush();
    x.mounted.render(true); await x.mounted.flush();
    assert.equal(x.mounted.hook.favoriteSyncStatus().folders.length, 0);
    assert.equal(x.mounted.hook.favoriteSyncStatus().foldersError, '');
    assert.equal(x.library.readLocalLibrary().items.filter(item => item.favorite).length, 1);
  } finally { x.mounted.unmount(); }
});
test('folder refresh shows busy state, rejects duplicate reads and writes, and ignores a late old-account reply', async () => {
  const x = folderSyncFixture(); await x.start(); let finish;
  try {
    let reads = 0;
    x.h.window.electronAPI.cloudFolderList = () => { reads++; return new Promise(resolve => finish = resolve); };
    const pending = x.mounted.hook.refreshFavoriteFolders();
    assert.equal(x.mounted.hook.favoriteSyncStatus().folderBusy, true);
    assert.match(x.mounted.hook.favoriteSyncStatus().folderNotice, /正在重新整理/);
    assert.equal((await x.mounted.hook.refreshFavoriteFolders()).success, false);
    assert.equal((await x.mounted.hook.changeFavoriteFolder({ operation: 'create', name: '測試' })).success, false);
    assert.equal(reads, 1);
    x.mounted.render(false); await x.mounted.flush();
    x.h.window.electronAPI.cloudFavorites = async () => ({ success: true, mode: 'cloud', userId: '2000000000000002', rows: [], folders: [] });
    x.mounted.render(true); await x.mounted.flush();
    finish({ success: true, userId: x.U, folders: [{ id: x.F, name: '舊帳號', itemIds: [] }] });
    assert.equal((await pending).success, false);
    assert.equal(x.mounted.hook.favoriteSyncStatus().folders.length, 0);
    assert.equal(Boolean(x.mounted.hook.favoriteSyncStatus().folderBusy), false);
  } finally { x.mounted.unmount(); }
});
test('a late folder mutation cannot import old-account data or leave the next account busy', async () => {
  const x = folderSyncFixture(); await x.start(); let finish;
  try {
    x.h.window.electronAPI.cloudFolderChange = () => new Promise(resolve => finish = resolve);
    const pending = x.mounted.hook.changeFavoriteFolder({ operation: 'rename', folderId: x.F, name: '舊帳號改名' });
    x.mounted.render(false);
    x.h.window.electronAPI.cloudFavorites = async () => ({ success: true, mode: 'cloud', userId: '2000000000000002', rows: [], folders: [] });
    x.mounted.render(true); await x.mounted.flush();
    finish({ success: true, userId: x.U, folders: [{ id: x.F, name: '不該出現', itemIds: [x.A] }] });
    assert.equal((await pending).success, false);
    const status = x.mounted.hook.favoriteSyncStatus();
    assert.equal(status.userId, '2000000000000002');
    assert.equal(status.folders.length, 0);
    assert.equal(Boolean(status.folderBusy), false);
    assert.equal(x.library.readLocalLibrary().items.some(item => item.cloud_user === '2000000000000002'), false);
  } finally { x.mounted.unmount(); }
});
test('an older full sync cannot roll back a verified newer folder mutation', async () => {
  const x = folderSyncFixture(); await x.start(); let finish;
  try {
    x.h.window.electronAPI.cloudFavorites = () => new Promise(resolve => finish = resolve);
    x.tick();
    x.h.window.electronAPI.cloudFolderChange = async () => ({ success: true, userId: x.U, folderId: x.F, folders: [{ id: x.F, name: '新名稱', revision: 'fixture-r2', itemIds: [x.A] }] });
    assert.equal((await x.mounted.hook.changeFavoriteFolder({ operation: 'rename', folderId: x.F, name: '新名稱' })).success, true);
    finish({ success: true, mode: 'cloud', userId: x.U, rows: [{ id: x.A }], folders: [{ id: x.F, name: '舊名稱', revision: 'fixture-r1', itemIds: [x.A] }] });
    await x.mounted.flush();
    assert.equal(x.mounted.hook.favoriteSyncStatus().folders[0].name, '新名稱');
    assert.equal(JSON.parse(x.h.storage.get('hongguo:favorite-folders:v1')).folders[0].name, '新名稱');
  } finally { x.mounted.unmount(); }
});
test('the folder editor validates names and implements all five actions with separate confirmation and no favorite removal', async () => {
  const h = fixture(), library = h.load('localLibrary.js'), A = '7300000000000000201', F = '7300000000000000101', U = '1000000000000001', writes = [];
  library.saveLocalSeries({ id: A, title: '短劇甲', favorite: true });
  library.replaceLocalLibrary(library.readLocalLibrary().items.map(item => ({ ...item, cloud_user: U })));
  const sync = { mode: 'cloud', userId: U, folders: [] };
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library, './useFavoriteSync': {
    useFavoriteSyncStatus: () => sync,
    refreshFavoriteFolders: async () => ({ success: true }),
    changeFavoriteFolder: async input => {
      writes.push(input);
      if (input.operation === 'create') sync.folders = [{ id: F, name: input.name, itemIds: [], revision: 'fixture-r1' }];
      if (input.operation === 'rename') sync.folders[0] = { ...sync.folders[0], name: input.name };
      if (input.operation === 'add') sync.folders[0] = { ...sync.folders[0], itemIds: [A] };
      if (input.operation === 'remove') sync.folders[0] = { ...sync.folders[0], itemIds: [] };
      if (input.operation === 'delete') sync.folders = [];
      return { success: true, folderId: input.operation === 'delete' ? '' : F };
    },
  } }); await ui.flush();
  const button = label => ui.find(n => n.type === 'button' && n.props['aria-label'] === label);
  const submit = async label => { await ui.find(n => n.type === 'form' && n.props['aria-label'] === label).props.onSubmit({ preventDefault() {} }); await ui.flush(); };
  const name = value => { ui.find(n => n.props.id === 'folder-name-input').props.onChange({ target: { value } }); ui.render(); };
  try {
    button('新增收藏夾').props.onClick(); ui.render();
    assert.equal(ui.find(n => n.props.id === 'folder-name-input').props.maxLength, 15);
    await submit('新增收藏夾名稱'); assert.equal(writes.length, 0);
    name('桌面夾'); await submit('新增收藏夾名稱');
    button('重新命名收藏夾').props.onClick(); ui.render(); name('桌面改名'); await submit('修改收藏夾名稱');
    button('加入短劇到目前收藏夾').props.onClick(); ui.render(); await submit('加入短劇到收藏夾');
    button('將《短劇甲》移出收藏夾').props.onClick(); ui.render();
    assert.equal(writes.length, 3);
    await ui.find(n => n.type === 'button' && n.children.includes('確認移出收藏夾')).props.onClick(); await ui.flush();
    assert.equal(library.readLocalLibrary().items[0].favorite, true);
    button('刪除收藏夾').props.onClick(); ui.render(); assert.equal(writes.length, 4);
    await ui.find(n => n.type === 'button' && n.children.includes('確認刪除收藏夾')).props.onClick(); await ui.flush();
    assert.deepEqual(writes.map(row => row.operation), ['create', 'rename', 'add', 'remove', 'delete']);
    assert.equal(writes[4].confirmed, true);
    assert.equal(library.readLocalLibrary().items[0].favorite, true);
    assert.equal(sync.folders.length, 0);
  } finally { ui.unmount(); }
});
test('folder UI blocks logged-out, offline or busy actions, keeps stale edits protected and clears old-account dialogs', async () => {
  const h = fixture(), sync = { mode: 'local' }, library = h.load('localLibrary.js');
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library, './useFavoriteSync': { useFavoriteSyncStatus: () => sync } }); await ui.flush();
  const create = () => ui.find(n => n.props['aria-label'] === '新增收藏夾');
  try {
    assert.equal(create().props.disabled, true);
    Object.assign(sync, { mode: 'cloud', userId: '1000000000000001', folders: [] }); ui.render(); await ui.flush();
    h.window.navigator = { onLine: false }; ui.render(); assert.equal(create().props.disabled, true);
    h.window.navigator.onLine = true; sync.foldersStale = true; ui.render(); assert.equal(create().props.disabled, false, 'creation still performs a fresh server preflight and must remain available after mobile deleted all folders');
    sync.foldersStale = false; sync.folderBusy = true; ui.render(); assert.equal(create().props.disabled, true);
    sync.folderBusy = false; ui.render(); create().props.onClick(); ui.render();
    assert.ok(ui.find(n => n.props.id === 'folder-name-input'));
    sync.userId = '2000000000000002'; ui.render(); await ui.flush();
    assert.equal(Boolean(ui.find(n => n.props.id === 'folder-name-input')), false);
  } finally { ui.unmount(); }
});

test('reservation polling promotes a confirmed release without changing favorites, preserves unknown results and stops when inactive', async () => {
  const timers = new Map(); let sequence = 0, answer = false;
  const h = fixture({ setInterval: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearInterval: id => timers.delete(id) });
  const library = h.load('localLibrary.js');
  library.saveLocalSeries({ id: 'reserved-fixture', title: '预约剧', favorite: true, online_time: Date.now() - 1000 });
  h.window.electronAPI.inspectRelease = async entries => ({ success: true, results: entries.map(entry => ({ id: entry.id, playable: answer })) });
  const props = { active: true }, ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library }, props);
  const reserved = () => ui.find(n => n.type === 'details' && n.props.className === 'release-reserved');
  try {
    await ui.flush(); assert.ok(reserved());
    answer = true; await [...timers.values()].find(timer => timer.ms === 60000).fn(); await ui.flush();
    assert.equal(reserved(), undefined);
    assert.equal(library.readLocalLibrary().items[0].favorite, true);
    answer = 'error'; await [...timers.values()].find(timer => timer.ms === 60000).fn(); await ui.flush();
    assert.equal(reserved(), undefined, 'an unknown response cannot undo a confirmed release');
    props.active = false; ui.render(); assert.equal(timers.size, 0);
  } finally { ui.unmount(); }
});

test('a stale cached folder cannot block safe creation or be silently renamed or deleted', async () => {
  const h = fixture(), library = h.load('localLibrary.js'), writes = [];
  const sync = { mode: 'cloud', userId: '1000000000000001', foldersStale: true, foldersError: '手機回傳空清單', folders: [{ id: '7300000000000000101', name: '已移除的夾', revision: 'old', itemIds: [] }] };
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library, './useFavoriteSync': {
    useFavoriteSyncStatus: () => sync,
    changeFavoriteFolder: async input => { writes.push(input); return { success: true }; },
  } });
  try {
    await ui.flush();
    ui.find(n => n.props.id === 'favorite-folder').props.onChange({ target: { value: sync.folders[0].id } }); ui.render();
    assert.equal(ui.find(n => n.props['aria-label'] === '重新命名收藏夾').props.disabled, true);
    assert.equal(ui.find(n => n.props['aria-label'] === '刪除收藏夾').props.disabled, true);
    const create = ui.find(n => n.props['aria-label'] === '新增收藏夾'); assert.equal(create.props.disabled, false);
    create.props.onClick(); ui.render();
    assert.equal(ui.find(n => n.props.id === 'folder-name-input').props.disabled, false);
    ui.find(n => n.props.id === 'folder-name-input').props.onChange({ target: { value: '已移除的夾' } }); ui.render();
    assert.equal(ui.find(n => n.type === 'button' && n.props.type === 'submit').props.disabled, false);
    await ui.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); await ui.flush();
    assert.equal(writes.length, 1); assert.equal(writes[0].operation, 'create');
    assert.equal(sync.folders.length, 1, 'a cached snapshot is not cleared by opening or submitting the editor');
  } finally { ui.unmount(); }
});


test('expanded create and reservation sections expose explicit collapse controls', async () => {
  const h = fixture(), library = h.load('localLibrary.js');
  library.saveLocalSeries({ id: '7300000000000000001', title: '等待', favorite: true, online_time: Date.now() + 86400000 });
  const sync = { mode: 'cloud', userId: '1000000000000001', folders: [] };
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library, './useFavoriteSync': { useFavoriteSyncStatus: () => sync } });
  try {
    const create = () => ui.find(n => n.props['aria-label'] === '新增收藏夾');
    create().props.onClick(); ui.render();
    assert.equal(create().props['aria-expanded'], true);
    assert.ok(ui.find(n => n.props.id === 'folder-name-input'));
    create().props.onClick(); ui.render();
    assert.equal(create().props['aria-expanded'], false);
    assert.equal(Boolean(ui.find(n => n.props.id === 'folder-name-input')), false);
    let reserved = ui.find(n => n.type === 'details');
    assert.equal(reserved.props.open, false);
    reserved.props.onToggle({ currentTarget: { open: true } }); ui.render();
    reserved = ui.find(n => n.type === 'details');
    assert.equal(reserved.props.open, true);
    const collapse = ui.find(n => n.type === 'button' && n.children.some(value => typeof value === 'string' && value.includes('收起尚未上線')));
    assert.ok(collapse);
    collapse.props.onClick(); ui.render();
    assert.equal(ui.find(n => n.type === 'details').props.open, false);
    assert.equal(library.readLocalLibrary().items.filter(item => item.favorite).length, 1);
  } finally { ui.unmount(); }
});

test('action notices auto-dismiss success and error, close manually and clear replaced timers', () => {
  const timers = new Map(); let sequence = 0;
  const h = fixture({ setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  const props = { message: '已新增收藏夾。' };
  const ui = h.mount('components/ActionNotice.jsx', {}, props);
  assert.ok(ui.find(node => node.props.role === 'status'));
  assert.equal([...timers.values()][0].ms, 3200);
  props.message = '已改名收藏夾。'; ui.render();
  assert.equal(timers.size, 1);
  [...timers.values()][0].fn(); ui.render();
  assert.equal(ui.nodes().length, 0);
  ui.unmount(); assert.equal(timers.size, 0);
  const failure = h.mount('components/ActionNotice.jsx', {}, { message: '請重新整理後重試。', error: true });
  assert.ok(failure.find(node => node.props.role === 'alert'));
  assert.equal([...timers.values()][0].ms, 7000);
  failure.find(node => node.props['aria-label'] === '關閉提示').props.onClick(); failure.render();
  assert.equal(failure.nodes().length, 0); failure.unmount();
  const expired = h.mount('components/ActionNotice.jsx', {}, { message: '先前的重整結果', expiresAt: Date.now() - 100 });
  assert.equal(expired.nodes().length, 0); expired.unmount();
  const css = fs.readFileSync(path.join(__dirname, '../src/components/ActionNotice.css'), 'utf8');
  assert.match(css, /position: fixed/);
  assert.match(css, /max-width: calc\(100vw - 40px\)/);
});

test('a failed favorite removal never leaves an earlier success notice on screen', () => {
  const h = fixture(), library = h.load('localLibrary.js');
  library.saveLocalSeries({ id: 'a', title: '甲', favorite: true });
  library.saveLocalSeries({ id: 'b', title: '乙', favorite: true });
  const ui = h.mount('components/ReleaseCalendar.jsx', { '../localLibrary': library });
  ui.find(node => node.props['aria-label'] === '取消收藏《甲》').props.onClick(); ui.render();
  assert.ok(ui.find(node => node.props.message === '已取消收藏，下載影片仍會保留。'));
  h.window.localStorage.setItem = () => { throw new Error('儲存空間不足'); };
  ui.find(node => node.props['aria-label'] === '移除《乙》').props.onClick(); ui.render();
  assert.equal(ui.find(node => node.props.message === '已取消收藏，下載影片仍會保留。'), undefined);
  assert.ok(ui.find(node => node.props.role === 'alert'));
  assert.ok(library.readLocalLibrary().items.find(item => item.id === 'b')?.favorite);
  ui.unmount();
});
