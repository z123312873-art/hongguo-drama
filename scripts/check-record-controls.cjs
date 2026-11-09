// In-memory records only. Never reads the user's local storage or Electron profile.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function fixture() {
  const storage = new Map(), events = new Map();
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    dispatchEvent: event => events.get(event.type)?.(event), electronAPI: {},
  };
  const load = (file, imports = {}) => {
    const module = { exports: {} };
    const code = transformSync(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs' }).code;
    vm.runInNewContext(code, { module, exports: module.exports, require: name => imports[name] || {}, window, Event, setTimeout, clearTimeout, setInterval, clearInterval });
    return module.exports;
  };
  const mount = (file, imports = {}, props = {}) => {
    let cursor = 0, tree;
    const slots = [], effects = [];
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
      useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useRef: initial => { const i = cursor++; return slots[i] ||= { current: initial }; },
      useMemo: fn => { cursor++; return fn(); },
      useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i][j]))) { slots[i] = deps; effects.push(fn); } },
    };
    react.useLayoutEffect = react.useEffect;
    const component = load(file, { './useFavoriteSync': { useFavoriteSyncStatus: () => ({ mode: 'local' }) }, '../favoriteView.mjs': load('favoriteView.mjs'), ...imports, react }).default;
    const render = () => { cursor = 0; tree = component(props); effects.splice(0).forEach(fn => fn()); };
    const nodes = () => { const result = []; const visit = n => { if (!n || typeof n !== 'object') return; result.push(n); n.children?.forEach(visit); }; visit(tree); return result; };
    render();
    return { render, nodes, find: fn => nodes().find(fn), flush: async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } } };
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
  assert.equal(ui.nodes().some(n => n.type === 'select'), false, 'no month dropdown');
  const titles = () => ui.nodes().filter(n => n.props.className === 'release-row').map(n => text(n.children[1].children[0]));
  assert.deepEqual(titles(), ['等上线', '六月AI', '一月真人']);
  const filter = label => ui.nodes().find(n => n.type === 'button' && text(n) === label);
  assert.ok(filter('全部 3')); assert.ok(filter('可播放 2')); assert.ok(filter('尚未上线 1')); assert.ok(filter('真人剧 1')); assert.ok(filter('AI 剧 1'));
  assert.equal(filter('漫剧 0'), undefined, 'no button for a category nobody has');
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
  assert.ok(text().includes('已从帐号历史移除《手机看完》'));
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
  assert.match(hook.favoriteSyncStatus().error, /读不到/);
  assert.ok(favs().includes('7300000000000000007'));
  } finally { cleanups.forEach(fn => typeof fn === 'function' && fn()); }
});
