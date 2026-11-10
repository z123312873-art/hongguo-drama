const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchFolders, folderItems, LIST_PATH, DETAIL_PATH } = require('./favorite-folders');
const A = '7706501221947000001', B = '7706501221947000002', F = '7706501221947000003';
const item = id => ({ item_id: id, book_type: 2 });
const folder = (extra = {}) => ({ folder_id: F, folder_name: 'TEST', item_count: 1, items: [item(A)], ...extra });
const reply = data => ({ code: 0, data: { has_more: false, ...data } });

test('folders retain exact ids and empty folders; only drama membership is selected', async () => {
  const calls = [];
  const rows = await fetchFolders(async (method, path, query, body) => {
    calls.push({ method, path, body });
    return reply({ folders: [folder(), folder({ folder_id: B, folder_name: 'Empty', item_count: 0, items: undefined })], folder_count: 2 });
  });
  assert.deepEqual(rows, [{ id: F, name: 'TEST', itemIds: [A] }, { id: B, name: 'Empty', itemIds: [] }]);
  assert.equal(calls[0].path, LIST_PATH);
  assert.deepEqual(calls[0].body, { offset: 0, count: 50, preview_items_limit: 50, target_id: '', has_detail: true });
  assert.deepEqual(folderItems([item(A), { item_id: B, book_type: 1 }]), [A]);
});

test('folders and details paginate completely, with lossless folder request ids', async () => {
  const calls = [];
  const rows = await fetchFolders(async (method, path, query, body) => {
    calls.push([path, body]);
    if (path === LIST_PATH) return body.offset === 0 ? reply({ folders: [folder({ item_count: 2 })], has_more: true }) : reply({ folders: [folder({ folder_id: B })], folder_count: 2 });
    assert.equal(path, DETAIL_PATH);
    assert.ok(body.includes(`"folder_id":${F}`));
    const offset = JSON.parse(body).offset;
    return reply({ folder_id: F, folder_name: 'Renamed', item_count: 2, items: [item(offset ? B : A)], has_more: offset === 0 });
  });
  assert.deepEqual(rows[0], { id: F, name: 'Renamed', itemIds: [A, B] });
  assert.equal(calls.length, 4);
});

test('folder failures, malformed and incomplete responses never become empty success', async () => {
  for (const response of [{ code: 1 }, reply({}), reply({ folders: [], folder_count: 1 }), reply({ folders: [], has_more: true }), reply({ folders: [folder({ folder_id: Number(F) })] }), reply({ folders: [folder({ items: [item('hema:1')] })] }), reply({ folders: [folder(), folder()] })]) {
    await assert.rejects(fetchFolders(async () => response));
  }
  await assert.rejects(fetchFolders(async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(await fetchFolders(async () => reply({ folders: [], folder_count: 0 })), []);
});

test('incomplete or repeated detail pages are refused', async () => {
  for (const detail of [reply({ folder_id: F, item_count: 2, items: [item(A)] }), reply({ folder_id: B, item_count: 2, items: [item(A), item(B)] }), reply({ folder_id: F, item_count: 2, items: [] , has_more: true })]) {
    await assert.rejects(fetchFolders(async (method, path) => path === LIST_PATH ? reply({ folders: [folder({ item_count: 2 })] }) : detail));
  }
});
