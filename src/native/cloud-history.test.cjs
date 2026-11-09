'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cloudRow, fetchHistory, uploadEntry, deleteEntry, mergeHistory, updateBody, finished, LIST_PATH, UPDATE_PATH } = require('./cloud-history');

const raw = (id, extra = {}) => ({
  book_id_str: id, book_name: `剧${id}`, thumb_url: 'https://p3-sign.fqnovelpic.com/novel-pic/x~tplv-a.heic?x-signature=1',
  episode_cnt: 80, vid_index: 3, vid: '7400000000000000001', current_play_position: 12500, duration: 90000,
  read_timestamp_ms: 1_700_000_000_000, is_delete: false, ...extra,
});
const page = (list, hasMore = false, next = 0) => ({ code: 0, data: { data_list: list, has_more: hasMore, next_offset: next } });

function server(pages) {
  const calls = [];
  const request = async (method, path, query, body) => {
    calls.push({ method, path, query, body });
    const reply = pages[Math.min(calls.filter(c => c.path === LIST_PATH).length - 1, pages.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { request, calls };
}

test('rows: seconds, cover, deleted and malformed entries', () => {
  const row = cloudRow(raw('7300000000000000001'));
  assert.equal(row.series_id, '7300000000000000001');
  assert.equal(row.currentTime, 12.5);
  assert.equal(row.duration, 90);
  assert.equal(row.total, 80);
  assert.equal(row.completed, false);
  assert.equal(row.cover, 'https://p3-novel.byteimg.com/novel-pic/x~tplv-shrink:640:0.image', 'a signed HEIC poster becomes a drawable unsigned rendition');
  assert.equal(cloudRow(raw('7300000000000000001', { is_delete: true })), null);
  assert.equal(cloudRow(raw('7300000000000000001', { is_delete: 1 })), null);
  assert.equal(cloudRow(raw('abc')), null);
  assert.equal(cloudRow(raw('7300000000000000001', { vid_index: 0 })), null);
  assert.equal(cloudRow(raw('7300000000000000001', { read_timestamp_ms: 0 })), null);
  assert.equal(cloudRow(null), null);
  assert.equal(cloudRow([]), null);
  assert.equal(cloudRow(raw('7300000000000000001', { book_name: '' })).series_title, '短剧 000001');
  assert.equal(cloudRow(raw('7300000000000000001', { vid_index: 90, episode_cnt: 80 })).total, 90, 'never shows more watched than total');
});

test('finished: last episode near its end only; unknown duration or total never counts', () => {
  assert.equal(finished(80, 80, 89, 90), true);
  assert.equal(finished(80, 80, 60, 90), false);
  assert.equal(finished(79, 80, 90, 90), false);
  assert.equal(finished(80, 80, 90, 0), false);
  assert.equal(finished(80, 0, 90, 90), false);
  assert.equal(cloudRow(raw('7300000000000000001', { vid_index: 80, current_play_position: 89000 })).completed, true);
});

test('fetch: walks every page with next_offset, newest row per drama, sorted newest first', async () => {
  const s = server([
    page([raw('7300000000000000001'), raw('7300000000000000002', { read_timestamp_ms: 1_700_000_000_500 })], true, 2),
    page([raw('7300000000000000001', { read_timestamp_ms: 1_700_000_001_000, vid_index: 9 })], false),
  ]);
  const rows = await fetchHistory(s.request);
  assert.deepEqual(rows.map(r => [r.series_id, r.vid_index]), [['7300000000000000001', 9], ['7300000000000000002', 3]]);
  assert.equal(s.calls[0].query.offset, '0');
  assert.equal(s.calls[0].query.is_first_load, 'true');
  assert.equal(s.calls[1].query.offset, '2');
  assert.equal(s.calls[1].query.is_first_load, 'false');
  assert.equal(s.calls[0].query.query_soft_deleted, 'false');
});

test('fetch: an empty account is an empty list, not an error', async () => {
  assert.deepEqual(await fetchHistory(server([page([])]).request), []);
});

test('fetch: missing next_offset steps forward; incomplete lists are errors, never a shorter list', async () => {
  const stride = server([page([raw('7300000000000000001')], true), page([raw('7300000000000000002')], false)]);
  await fetchHistory(stride.request);
  assert.equal(stride.calls[1].query.offset, '500');
  await assert.rejects(fetchHistory(server([page([raw('7300000000000000001')], true, 1)]).request), /重复/);
  await assert.rejects(fetchHistory(server([page([], true, 5)]).request), /没有读完/);
  let n = 0;
  const endless = async () => page([raw(String(7300000000000000000n + BigInt(++n)))], true, n * 10);
  await assert.rejects(fetchHistory(endless, { maxPages: 3 }), /太多页/);
  await assert.rejects(fetchHistory(server([{ code: 0, data: {} }]).request), /格式/);
  await assert.rejects(fetchHistory(server([new Error('HTTP 500')]).request), /HTTP 500/);
});

test('update body keeps 19-digit ids exact as JSON numbers', () => {
  const body = updateBody({ series_id: '7300000000000000123', vid_index: 4, currentTime: 61.2, updatedAt: 1_700_000_000_000, total: 80, cloudVid: '7400000000000000999', duration: 90 }, 1_700_000_100_000, false);
  assert.match(body, /"book_id":7300000000000000123,/);
  assert.match(body, /"vid":7400000000000000999/);
  assert.match(body, /"current_play_position":61200/);
  assert.match(body, /"is_delete":false/);
  assert.doesNotMatch(body, /\\u0000|"7300000000000000123"/);
  const removed = updateBody({ series_id: '7300000000000000123', vid_index: 4 }, 1_700_000_100_000, true);
  assert.match(removed, /"is_delete":true/);
  assert.doesNotMatch(removed, /"vid":/, 'no vid without a known one');
});

test('upload validates before sending', async () => {
  const s = server([page([])]);
  await uploadEntry(s.request, { series_id: '7300000000000000001', vid_index: 2, currentTime: 3 });
  assert.equal(s.calls[0].method, 'POST');
  assert.equal(s.calls[0].path, UPDATE_PATH);
  await assert.rejects(uploadEntry(s.request, { series_id: 'hema:12', vid_index: 2 }));
  await assert.rejects(uploadEntry(s.request, { series_id: '7300000000000000001', vid_index: 0 }));
});

test('delete is confirmed by reading the list again', async () => {
  const gone = server([page([raw('7300000000000000002')])]);
  const after = await deleteEntry(gone.request, { series_id: '7300000000000000001', vid_index: 3 });
  assert.deepEqual(after.map(r => r.series_id), ['7300000000000000002']);
  assert.equal(gone.calls[0].path, UPDATE_PATH);
  const stays = server([page([raw('7300000000000000001')])]);
  await assert.rejects(deleteEntry(stays.request, { series_id: '7300000000000000001', vid_index: 3 }), (error) => error.code === 'CLOUD_DELETE_UNCONFIRMED' && error.rows.length === 1);
  await assert.rejects(deleteEntry(stays.request, { series_id: '' }));
});

test('merge: the account decides the list; local progress wins only when newer; pending plays are added once', () => {
  const cloud = [cloudRow(raw('7300000000000000001', { read_timestamp_ms: 2000 })), cloudRow(raw('7300000000000000002', { read_timestamp_ms: 1000 }))];
  const local = [
    { series_id: '7300000000000000001', series_title: '本地名', total: 82, vid_index: 7, currentTime: 5, updatedAt: 3000, completed: false, sequels: [{ series_id: '7300000000000000009' }], hasUpdates: true, unreadEpisodes: 2 },
    { series_id: '7300000000000000002', series_title: 'b', total: 80, vid_index: 1, currentTime: 1, updatedAt: 500, completed: false },
    { series_id: '7300000000000000003', series_title: 'pending', total: 10, vid_index: 1, currentTime: 1, updatedAt: 4000 },
    { series_id: '7300000000000000004', series_title: 'old local only', total: 10, vid_index: 1, currentTime: 1, updatedAt: 100 },
    { series_id: 'hema:12', series_title: 'other source', total: 10, vid_index: 1, currentTime: 1, updatedAt: 5000 },
  ];
  const rows = mergeHistory(cloud, local, new Set(['7300000000000000003']));
  assert.deepEqual(rows.map(r => r.series_id), ['7300000000000000003', '7300000000000000001', '7300000000000000002']);
  const first = rows.find(r => r.series_id === '7300000000000000001');
  assert.equal(first.vid_index, 7, 'newer local progress');
  assert.equal(first.total, 82);
  assert.equal(first.sequels.length, 1, '疑似续作 stays');
  assert.equal(first.hasUpdates, true);
  const second = rows.find(r => r.series_id === '7300000000000000002');
  assert.equal(second.vid_index, 3, 'newer phone progress');
  assert.equal(rows.find(r => r.series_id === '7300000000000000003').synced, false);
  assert.deepEqual(mergeHistory([], local, new Set()), [], 'an empty account shows an empty list');
  assert.equal(mergeHistory(cloud, [], new Set()).length, 2);
  assert.deepEqual(mergeHistory(cloud, null).map(r => r.sequels), [[], []]);
});
