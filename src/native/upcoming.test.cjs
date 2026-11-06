const assert = require('node:assert/strict');
const test = require('node:test');
const { reservationCount, selectUpcoming, absorbUpcoming, fetchUpcomingPage, UPCOMING_PATH } = require('./upcoming');

const now = Date.parse('2026-11-06T12:00:00+08:00');
const stamp = (iso) => Math.floor(Date.parse(iso) / 1000);
const cover = 'https://p3-novel.byteimg.com/novel-pic/0123456789abcdef0123456789abcdef~tplv-origin.heic';

function row(extra) {
  return {
    name: '甲剧',
    item_id: '7100000000000000001',
    cover,
    is_online: false,
    sub_info: '预计11月7日上线',
    expected_rec_text: '1万预约',
    expected_publish_time: stamp('2026-11-07T00:00:00+08:00'),
    ...extra,
  };
}

test('reservation counts accept both scripts and ignore unrelated words', () => {
  assert.equal(reservationCount('844.3万人预约'), 8443000);
  assert.equal(reservationCount('10萬人已預約'), 100000);
  assert.equal(reservationCount('1.5亿'), 150000000);
  assert.equal(reservationCount('沒有數字'), 0);
  assert.equal(reservationCount(''), 0);
  assert.equal(reservationCount('预计11月7日上线，844.3万人预约'), 8443000);
  assert.equal(reservationCount('1,059.2万人预约'), 10592000);
});

test('upcoming keeps a future timestamp and drops vague or expired rows', () => {
  const selected = selectUpcoming([
    row({ name: '有日子', expected_rec_text: '2万' }),
    row({ name: '只有月份但有日子戳', item_id: '7100000000000000002', sub_info: '预计12月上线', expected_publish_time: stamp('2026-12-06T00:00:00+08:00'), expected_rec_text: '3万' }),
    row({ name: '只有月份', item_id: '7100000000000000003', sub_info: '预计2月上线', expected_publish_time: 0, expected_rec_text: '500万' }),
    row({ name: '已经过期', item_id: '7100000000000000004', sub_info: '预计10月24日上线', expected_publish_time: stamp('2026-10-24T00:00:00+08:00'), expected_rec_text: '9万' }),
    row({ name: '空白', item_id: '7100000000000000005', sub_info: '', expected_publish_time: 0 }),
    row({ name: '季度', item_id: '7100000000000000006', sub_info: '预计春季上线', expected_publish_time: 0, expected_rec_text: '8万' }),
    row({ name: '已经上线', item_id: '7100000000000000007', is_online: true, expected_rec_text: '100万' }),
    row({ name: '字串不算上线', item_id: '7100000000000000008', is_online: 'true', expected_rec_text: '4万' }),
    row({ name: '备用时刻不算', item_id: '7100000000000000009', sub_info: '预计2月上线', expected_publish_time: 0, schedule_publish_time: stamp('2026-12-01T00:00:00+08:00'), expected_rec_text: '900万' }),
    row({ name: '句子里的日子不是人数', item_id: '7100000000000000010', sub_info: '预计11月22日上线，38.5万人预约', expected_rec_text: '', expected_publish_time: stamp('2026-11-22T00:00:00+08:00') }),
  ], now);
  assert.deepEqual(selected.map(item => item.series_title), ['句子里的日子不是人数', '字串不算上线', '只有月份但有日子戳', '有日子']);
  assert.equal(selected.find(item => item.series_title === '句子里的日子不是人数').reservations, 385000);
  assert.equal(selected.find(item => item.series_title === '有日子').online_label, '11月7日');
  assert.equal(selected.find(item => item.series_title === '只有月份但有日子戳').online_label, '12月6日');
  assert.equal(selected[0].cover.includes('tplv-resize:320:0.webp'), true);
  assert.equal(selected[0].cover.includes('640'), false);
});

test('equal reservations break ties by release time and then title', () => {
  const selected = selectUpcoming([
    row({ name: '乙', item_id: '2', expected_rec_text: '1万', expected_publish_time: stamp('2026-11-09T00:00:00+08:00') }),
    row({ name: '甲', item_id: '1', expected_rec_text: '1万', expected_publish_time: stamp('2026-11-08T00:00:00+08:00') }),
    row({ name: '丙', item_id: '3', expected_rec_text: '1万', sub_info: '预计11月8日上线', expected_publish_time: stamp('2026-11-08T00:10:00+08:00') }),
  ], now);
  assert.deepEqual(selected.map(item => item.series_title), ['甲', '丙', '乙']);
});

test('later pages re-sort and a stuck offset stops the walk', () => {
  const first = absorbUpcoming({ raw: [], offset: 0, sessionId: '' }, {
    items: [row({ name: '较少', expected_rec_text: '2万' })],
    hasMore: true,
    nextOffset: 50,
    sessionId: 's2',
  }, now);
  assert.equal(first.done, false);
  assert.equal(first.offset, 50);
  assert.equal(first.sessionId, 's2');
  const second = absorbUpcoming(first, {
    items: [row({ name: '较多', item_id: '7100000000000000099', expected_rec_text: '80万' })],
    hasMore: true,
    nextOffset: 50,
    sessionId: 's2',
  }, now);
  assert.deepEqual(second.items.map(item => item.series_title), ['较多', '较少']);
  assert.equal(second.done, true);
  assert.equal(second.items.length, 2);
});

test('the first page is requested before a session id exists', async () => {
  const seen = [];
  const page = await fetchUpcomingPage({ offset: 0 }, async (apiPath, values) => {
    seen.push({ apiPath, values });
    return { data: { subscribe_items: [row()], has_more: true, next_offset: 50, session_id: 'next' } };
  });
  assert.equal(seen[0].apiPath, UPCOMING_PATH);
  assert.equal(seen[0].values.session_id, undefined);
  assert.deepEqual(seen[0].values, { is_online: '0', tab_type: '2', limit: '50', offset: '0', version: '1' });
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 50);
  assert.equal(page.sessionId, 'next');
  const second = await fetchUpcomingPage({ offset: 50, sessionId: 'next' }, async (_path, values) => {
    assert.equal(values.session_id, 'next');
    assert.equal(values.offset, '50');
    return { data: { subscribe_items: [], has_more: false, next_offset: 50, session_id: 'next' } };
  });
  assert.equal(second.hasMore, false);
});
