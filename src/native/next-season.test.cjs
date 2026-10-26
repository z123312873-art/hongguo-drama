const assert = require('node:assert/strict');
const test = require('node:test');
const { immediateNextSeason, seasonFinaleIndex, COUNTDOWN_SECONDS } = require('./next-season');

test('autoplay selects only the next season and keeps its poster', () => {
  const current = { series_id: '10000011', series_title: '誰讓這個文盲修仙的' };
  const season2 = { series_id: '10000012', series_title: '谁让这个文盲修仙的第二季', cover: 'https://img.example/2.jpg' };
  const season5 = { series_id: '10000015', series_title: '谁让这个文盲修仙的第五季', cover: 'https://img.example/5.jpg' };
  const picked = immediateNextSeason(current, [season5, season2, { series_id: '99', series_title: '另一部剧第二季' }]);
  assert.equal(picked.series_id, '10000012');
  assert.equal(picked.series_title, season2.series_title);
  assert.equal(picked.cover, 'https://img.example/2.jpg');
  assert.equal(picked.season, 2);
  assert.equal(picked.seconds, COUNTDOWN_SECONDS);
  assert.equal(immediateNextSeason(current, [season5]), null);
});

test('traditional and simplified season titles stay in order across ten', () => {
  const current = { series_id: '10000021', series_title: '从杂役到符仙人第十季' };
  const next = immediateNextSeason(current, [
    { series_id: '10000029', series_title: '從雜役到符仙人第十五季' },
    { series_id: '10000022', series_title: '從雜役到符仙人第十一季' },
  ]);
  assert.equal(next.series_id, '10000022');
  assert.equal(next.season, 11);
  assert.equal(immediateNextSeason({ series_id: '10000021', series_title: '从杂役到符仙人第十季' }, [
    { series_id: '10000030', series_title: '从杂役到符仙人外传第十一季' },
  ]), null);
});

test('a season finale is the highest episode, including a locked later episode', () => {
  assert.equal(seasonFinaleIndex([{ vid_index: 1 }, { vid_index: 144 }, { vid_index: 143 }]), 144);
  assert.equal(seasonFinaleIndex([]), 0);
  assert.equal(immediateNextSeason({ series_id: 'hema:1', series_title: '河马剧' }, [
    { series_id: 'hema:2', series_title: '河马剧第二季' },
  ]).series_id, 'hema:2');
  assert.equal(immediateNextSeason({ series_id: '10000011', series_title: '谁让这个文盲修仙的' }, [
    { series_id: 'xifan:1:2', series_title: '谁让这个文盲修仙的第二季' },
  ]), null);
});
