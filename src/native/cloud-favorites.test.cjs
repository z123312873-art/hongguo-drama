'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFavorites, fetchFavorites, setFavorite, updateBody, LIST_PATH, UPDATE_PATH } = require('./cloud-favorites');

const A = '7690163276214176792', B = '7690163276214176794';
const list = rows => ({ code: 0, data: { video_shelf_info: rows } });

test('parse: ids, seconds or milliseconds, duplicates, bad rows; a missing list is an error', () => {
  const rows = parseFavorites(list([{ series_id: A, collect_time: 1700000000 }, { series_id: B, collect_time: 1700000100000 }, { series_id: A, collect_time: 1600000000 }, { series_id: 'x' }, null, { book_id: 12 }]));
  assert.deepEqual(rows, [{ id: B, favoritedAt: 1700000100000 }, { id: A, favoritedAt: 1700000000000 }]);
  assert.deepEqual(parseFavorites(list([{ series_id: A }])), [{ id: A, favoritedAt: 0 }], 'an unknown time stays unknown');
  assert.deepEqual(parseFavorites(list([])), [], 'an empty account is an empty list');
  for (const bad of [null, {}, { data: {} }, { data: { video_shelf_info: {} } }, { data: [] }]) assert.throws(() => parseFavorites(bad), /格式/);
});

test('fetch asks for the signed-in account', async () => {
  const calls = [];
  await fetchFavorites(async (method, path, query) => { calls.push({ method, path, query }); return list([]); }, '1234567890123456');
  assert.deepEqual(calls, [{ method: 'GET', path: LIST_PATH, query: { target_user_id: '1234567890123456' } }]);
  await assert.rejects(fetchFavorites(async () => list([]), ''), /帐号/);
});

test('update body: one drama, add is 0 and cancel is 1', () => {
  const add = JSON.parse(updateBody(A, true, 5));
  assert.deepEqual(add.update_bookshelf_video_list, [{ book_id: A, book_type: 2, modify_time: 5, video_shelf_operate_type: 0 }]);
  assert.equal(JSON.parse(updateBody(A, false, 5)).update_bookshelf_video_list[0].video_shelf_operate_type, 1);
});

function server(initial, { ignore = false, fail = '' } = {}) {
  let rows = [...initial];
  const calls = [];
  const request = async (method, path, query, body) => {
    calls.push({ method, path, body });
    if (fail) throw new Error(fail);
    if (method === 'GET') return list(rows.map(id => ({ series_id: id, collect_time: 1700000000 })));
    const change = JSON.parse(body).update_bookshelf_video_list[0];
    if (!ignore) rows = change.video_shelf_operate_type === 0 ? [...new Set([...rows, change.book_id])] : rows.filter(id => id !== change.book_id);
    return { code: 0, data: {} };
  };
  return { request, calls };
}

test('set is confirmed by reading the list again', async () => {
  const s = server([A]);
  assert.deepEqual((await setFavorite(s.request, '1', B, true)).map(r => r.id).sort(), [A, B]);
  assert.equal(s.calls[0].path, UPDATE_PATH);
  assert.deepEqual((await setFavorite(s.request, '1', A, false)).map(r => r.id), [B]);
  const stuck = server([A], { ignore: true });
  await assert.rejects(setFavorite(stuck.request, '1', A, false), error => error.code === 'CLOUD_FAVORITE_UNCONFIRMED');
  await assert.rejects(setFavorite(stuck.request, '1', B, true), /没有确认加入/);
  await assert.rejects(setFavorite(server([], { fail: 'HTTP 500' }).request, '1', A, true), /HTTP 500/);
  await assert.rejects(setFavorite(stuck.request, '1', 'hema:1', true), /无法同步/);
  assert.equal(stuck.calls.filter(c => c.method === 'POST').length, 2, 'an invalid id sends nothing');
});
