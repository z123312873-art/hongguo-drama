const assert = require('node:assert/strict');
const test = require('node:test');
const { immediateNextSeason, seasonFinaleIndex, COUNTDOWN_SECONDS } = require('./next-season');
const cjsSeason = require('./season-title');
const esmSeason = require('./season-title.mjs');

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

test('main-process and renderer season parsers stay aligned', () => {
  for (const title of ['誰讓這個文盲修仙的', '谁让这个文盲修仙的第二季', '從雜役到符仙人第十一季', '年轮（2024）', '双子房客第十季', '青铜门后Ⅰ', '老千2', '炼气3000层2', '剧名100', '开局青云宗主召唤大帝境老祖（第一季）', '開局青雲宗主召喚大帝境老祖（第二季）']) {
    assert.deepEqual(cjsSeason.seasonTitle(title), esmSeason.seasonTitle(title), title);
    assert.equal(cjsSeason.sourceOf('10000011'), esmSeason.sourceOf('10000011'));
  }
  assert.equal(cjsSeason.seasonTitle('青铜门后Ⅰ').season, 2);
  assert.equal(cjsSeason.seasonTitle('青铜门后Ⅱ').season, 3);
  assert.equal(cjsSeason.seasonTitle('剧名100').explicit, false);
  assert.equal(cjsSeason.seasonTitle('年轮（2024）').explicit, false);
  const wrapped = cjsSeason.seasonTitle('开局青云宗主召唤大帝境老祖（第一季）');
  assert.equal(wrapped.explicit, true);
  assert.equal(wrapped.season, 1);
  assert.equal(wrapped.base, cjsSeason.seasonTitle('开局青云宗主召唤大帝境老祖').base);
  assert.equal(cjsSeason.seasonTitle('開局青雲宗主召喚大帝境老祖（第十季）').season, 10);
  assert.equal(cjsSeason.seasonTitle('开局青云宗主召唤大帝境老祖(第二季)').season, 2);
  const sequel = immediateNextSeason(
    { series_id: '10000041', series_title: '开局青云宗主召唤大帝境老祖（第一季）' },
    [
      { series_id: '10000050', series_title: '开局青云宗主召唤大帝境老祖（第十季）' },
      { series_id: '10000042', series_title: '开局青云宗主召唤大帝境老祖（第二季）', cover: 'https://img.example/s2.jpg' },
      { series_id: 'xifan:room:2', series_title: '开局青云宗主召唤大帝境老祖（第二季）' },
    ],
  );
  assert.equal(sequel.series_id, '10000042');
  assert.equal(sequel.season, 2);
  assert.equal(sequel.cover, 'https://img.example/s2.jpg');
  assert.equal(immediateNextSeason(
    { series_id: '10000041', series_title: '开局青云宗主召唤大帝境老祖（第一季）' },
    [{ series_id: '10000050', series_title: '开局青云宗主召唤大帝境老祖（第十季）' }],
  ), null);
});

test('the next installment is the immediate one and stays on the same source', () => {
  const current = { series_id: '7675302847793089560', series_title: '青铜门' };
  const first = { series_id: '7660777963603889177', series_title: '青铜门后Ⅰ' };
  const fourth = { series_id: '7680917056362925118', series_title: '青铜门后Ⅳ' };
  const picked = immediateNextSeason(current, [fourth, { series_id: 'xifan:room:1', series_title: '青铜门后Ⅰ' }, first, { series_id: 'hema:9', series_title: '青铜门后Ⅰ' }]);
  assert.equal(picked.series_id, first.series_id);
  assert.equal(picked.season, 2);
  assert.equal(immediateNextSeason(current, [fourth]), null);
  const numbered = immediateNextSeason({ series_id: '10000031', series_title: '老千' }, [
    { series_id: '10000035', series_title: '老千5' },
    { series_id: '10000032', series_title: '老千2' },
  ]);
  assert.equal(numbered.series_id, '10000032');
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

test('punctuation around a title never hides the next season', () => {
  const { findSequels } = require('./watch-history');
  const season2 = { series_id: '7663395668320324632', series_title: '大学没毕业，你怎么登上福布斯了第二季' };
  const season3 = { series_id: '7681249492561054744', series_title: '大学没毕业，你怎么登上福布斯了第三季' };
  const unrelated = { series_id: '7645153739656924184', series_title: '大学没毕业：你怎么登上福布斯了' };
  for (const title of [
    '大学没毕业，你怎么登上福布斯了！',
    '大学没毕业，你怎么登上福布斯了!',
    '大学没毕业,你怎么登上福布斯了？！',
    '大學沒畢業，你怎麼登上福布斯了！',
    '大学没毕业：你怎么登上福布斯了',
  ]) {
    const current = { series_id: '7654950385206971417', series_title: title };
    for (const lookup of [
      candidates => immediateNextSeason(current, candidates),
      candidates => findSequels(current, candidates)[0],
    ]) {
      assert.equal(lookup([season3, unrelated, season2]).series_id, season2.series_id, title);
    }
    assert.equal(immediateNextSeason(current, [season3]), null, `${title}: season 3 must not stand in for season 2`);
  }
  const colon = immediateNextSeason({ series_id: '10000061', series_title: '名称！' }, [{ series_id: '10000062', series_title: '名称：第二季！' }]);
  assert.equal(colon.series_id, '10000062');
  assert.equal(immediateNextSeason({ series_id: '10000061', series_title: '名称甲！' }, [{ series_id: '10000062', series_title: '名称乙第二季' }]), null);
  assert.equal(immediateNextSeason({ series_id: '10000063', series_title: '！！！' }, [{ series_id: '10000064', series_title: '！！！第二季' }]), null);
});

test('the same title with different punctuation shares one season key in both parsers', () => {
  for (const title of ['大学没毕业，你怎么登上福布斯了！', '名称：第二季！', '《老千》第三部。', '剧名（第二季）！', '剧名2！', 'A～B…']) {
    assert.deepEqual(cjsSeason.seasonTitle(title), esmSeason.seasonTitle(title), title);
  }
  assert.equal(cjsSeason.seasonTitle('名称：副标题！').key, cjsSeason.seasonTitle('名称，副标题第二季').key);
  assert.equal(cjsSeason.seasonTitle('剧名（第二季）！').season, 2);
  assert.equal(cjsSeason.seasonTitle('名称：第二季！').base, '名称');
});
