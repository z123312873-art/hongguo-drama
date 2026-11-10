const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchFolders, changeFolder, LIST_PATH, UPDATE_PATH, ITEM_PATH } = require('./favorite-folders');
const { MAX_NAME_LENGTH, validateName, publicError } = require('./folder-rules');
const F = '7300000000000000101', G = '7300000000000000102', H = '7300000000000000103';
const A = '7300000000000000201', B = '7300000000000000202', U = '1000000000000001';
const parse = body => JSON.parse(body.replace(/([:,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
function server() {
  const state = { folders: [{ folder_id: F, folder_name: '甲', is_publish: true, item_count: 1, items: [{ item_id: A, book_type: 2, content_type: 1 }] }, { folder_id: G, folder_name: '乙', is_publish: false, item_count: 0, items: [] }], favorites: [{ series_id: A, content_type: 1 }, { series_id: B, content_type: 1004 }], calls: [], failure: '', ignore: false, afterWrite: null };
  const request = async (method, path, query, body) => {
    state.calls.push({ method, path, query, body });
    if (state.failure === path) throw new Error('CODE 101109');
    if (path === LIST_PATH) return { code: 0, data: { has_more: false, folder_count: state.folders.length, folders: structuredClone(state.folders) } };
    if (method === 'GET') { assert.equal(query.target_user_id, U); return { code: 0, data: { video_shelf_info: structuredClone(state.favorites) } }; }
    const change = parse(body);
    if (!state.ignore) {
      if (path === UPDATE_PATH) {
        const row = change.operate_data[0];
        assert.equal(change.operate_data.length, 1);
        if (row.operate_type === 1) state.folders.push({ folder_id: H, folder_name: row.folder_name, is_publish: row.is_publish, item_count: 0, items: [] });
        else if (row.operate_type === 3) Object.assign(state.folders.find(folder => folder.folder_id === row.folder_id), { folder_name: row.folder_name, is_publish: row.is_publish });
        else if (row.operate_type === 2) state.folders = state.folders.filter(folder => folder.folder_id !== row.folder_id);
        else assert.fail('unknown operation');
      } else {
        assert.equal(path, ITEM_PATH);
        const row = change.operators[0];
        assert.equal(change.operators.length, 1);
        assert.equal(row.origin_folder_id, 0);
        assert.equal(row.book_type, 2);
        const target = state.folders.find(folder => folder.folder_id === row.folder_id);
        if (row.operate_type === 1) target.items.push({ item_id: row.item_id, book_type: row.book_type, content_type: row.content_type });
        else if (row.operate_type === 2) target.items = target.items.filter(item => item.item_id !== row.item_id);
        else assert.fail('unknown operation');
        target.item_count = target.items.length;
      }
    }
    state.afterWrite?.(state);
    return state.emptyReply ? undefined : { code: 0, data: {} };
  };
  return { state, request, snapshot: async id => (await fetchFolders(request)).find(folder => folder.id === id), writes: () => state.calls.filter(call => call.path === UPDATE_PATH || call.path === ITEM_PATH) };
}
const input = (operation, folder, extra = {}) => ({ userId: U, operation, folderId: folder?.id, revision: folder?.revision, ...extra });
test('all five folder operations are narrow, verified and preserve unrelated folders and main favorites', async () => {
  const h = server(), original = structuredClone(h.state.folders[0]), favoriteIds = JSON.stringify(h.state.favorites);
  const created = await changeFolder(h.request, input('create', null, { name: ' 新收藏夾 ' }));
  assert.equal(created.folderId, H);
  let own = await h.snapshot(H);
  const renamed = await changeFolder(h.request, input('rename', own, { name: '改名' }));
  assert.equal(renamed.folders.find(folder => folder.id === H).name, '改名');
  own = await h.snapshot(H);
  const added = await changeFolder(h.request, input('add', own, { itemId: B }), { now: () => 1700000000123 });
  assert.deepEqual(added.folders.find(folder => folder.id === H).itemIds, [B]);
  assert.equal(parse(h.writes().at(-1).body).operators[0].content_type, 1004);
  assert.equal(parse(h.writes().at(-1).body).operators[0].modify_time, 1700000000123);
  own = await h.snapshot(H);
  await changeFolder(h.request, input('remove', own, { itemId: B }));
  own = await h.snapshot(H);
  assert.equal(own.itemCount, 0);
  const deleted = await changeFolder(h.request, input('delete', own, { confirmed: true }));
  assert.equal(deleted.deletedId, H);
  assert.equal(h.state.folders.length, 2);
  assert.deepEqual(h.state.folders[0], original);
  assert.equal(JSON.stringify(h.state.favorites), favoriteIds);
  assert.equal(h.writes().length, 5);
  for (const call of h.writes().slice(1)) assert.ok(call.body.includes(`"folder_id":${H}`));
  assert.ok(!h.writes().some(call => call.body.includes(`"folder_id":"${H}"`)));
});
test('name validation handles empty, normalized duplicates, controls, boundaries and surrogate pairs without truncation', () => {
  assert.equal(MAX_NAME_LENGTH, 15);
  assert.equal(validateName('  甲  '), '甲');
  assert.equal(validateName('甲'.repeat(15)).length, 15);
  assert.equal(validateName('😀'.repeat(7) + '甲').length, 15);
  for (const value of ['', '  ', '\u200B', '甲'.repeat(16), '😀'.repeat(8), 'a\nb', 'a\u0000b', '\uD800']) assert.throws(() => validateName(value));
  assert.throws(() => validateName('ＡＢＣ', [{ id: F, name: 'abc' }]), /同名/);
  assert.equal(validateName('甲', [{ id: F, name: '甲' }], F), '甲');
  assert.doesNotMatch(publicError(new Error('CODE 101109 token secret')), /101109|CODE|secret/);
});
test('stale names, membership and privacy never overwrite mobile changes', async () => {
  for (const change of [row => row.folder_name = '手機改名', row => row.items.push({ item_id: B, book_type: 2, content_type: 1 }), row => row.is_publish = false]) {
    const h = server(), view = await h.snapshot(F);
    change(h.state.folders[0]); h.state.folders[0].item_count = h.state.folders[0].items.length;
    await assert.rejects(changeFolder(h.request, input('rename', view, { name: '桌面改名' })), error => error.code === 'FOLDER_CHANGED');
    assert.equal(h.writes().length, 0);
  }
});
test('fresh privacy is preserved on rename and a missing folder is not recreated', async () => {
  const h = server(), view = await h.snapshot(F);
  await changeFolder(h.request, input('rename', view, { name: '公開夾' }));
  assert.equal(h.state.folders[0].is_publish, true);
  assert.equal(parse(h.writes()[0].body).operate_data[0].is_publish, true);
  const removed = await h.snapshot(G); h.state.folders = h.state.folders.filter(row => row.folder_id !== G);
  await assert.rejects(changeFolder(h.request, input('add', removed, { itemId: B })), error => error.code === 'FOLDER_GONE');
  assert.equal(h.writes().length, 1);
});
test('duplicate names and unconfirmed deletes are refused without mutations', async () => {
  const h = server(), view = await h.snapshot(G);
  await assert.rejects(changeFolder(h.request, input('create', null, { name: '甲' })), /同名/);
  await assert.rejects(changeFolder(h.request, input('rename', view, { name: '甲' })), /同名/);
  await assert.rejects(changeFolder(h.request, input('delete', view)), /確認/);
  assert.equal(h.writes().length, 0);
});
test('items are already-favorited dramas; add and remove are idempotent and never send main-favorite updates', async () => {
  const h = server(), one = await h.snapshot(F), two = await h.snapshot(G);
  await changeFolder(h.request, input('add', one, { itemId: A }));
  await changeFolder(h.request, input('remove', two, { itemId: A }));
  await assert.rejects(changeFolder(h.request, input('add', two, { itemId: '7300000000000000999' })), /手機收藏/);
  assert.equal(h.writes().length, 0);
  assert.ok(!h.state.calls.some(call => call.method === 'POST' && call.path.includes('bookshelf/video')));
});
test('empty, failed and ignored responses are uncertain, not successes or automatic write retries', async () => {
  for (const mode of ['emptyReply', 'ignore', 'failedRead']) {
    const h = server(), view = await h.snapshot(G);
    if (mode === 'failedRead') h.state.afterWrite = state => state.failure = LIST_PATH;
    else h.state[mode] = true;
    await assert.rejects(changeFolder(h.request, input('rename', view, { name: '新名' })), error => error.code === 'FOLDER_UNCONFIRMED' && error.uncertain);
    assert.equal(h.writes().length, 1);
  }
});
test('an item operation that changes main favorites is reported without a compensating write', async () => {
  const h = server(), view = await h.snapshot(F);
  h.state.afterWrite = state => state.favorites = state.favorites.filter(row => row.series_id !== A);
  await assert.rejects(changeFolder(h.request, input('remove', view, { itemId: A })), error => error.code === 'FOLDER_SIDE_EFFECT');
  assert.equal(h.writes().length, 1);
});
test('folder deletion checks main favorites and never clears or restores other mobile data', async () => {
  const h = server(), view = await h.snapshot(F);
  await changeFolder(h.request, input('delete', view, { confirmed: true }));
  assert.equal(h.state.folders.length, 1);
  assert.deepEqual(h.state.favorites.map(row => row.series_id), [A, B]);
  assert.equal(h.writes().length, 1);
});
test('bad or incomplete preflight responses never authorize a mutation', async () => {
  for (const response of [null, {}, { code: 0, data: { has_more: false, folders: [], folder_count: 2 } }, { code: 0, data: { has_more: true, folders: [], folder_count: 0 } }]) {
    const paths = [];
    await assert.rejects(changeFolder(async (_method, path) => { paths.push(path); return response; }, input('create', null, { name: '新夾' })));
    assert.ok(paths.every(path => path === LIST_PATH));
  }
});
