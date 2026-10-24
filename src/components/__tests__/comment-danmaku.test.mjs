import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../danmakuModel.mjs';
import { planDanmakuWarmup } from '../danmakuWarmup.mjs';
import { DEFAULT_DANMAKU_SETTINGS, normalizeDanmakuSettings, advanceDanmaku, danmakuSeed } from '../danmakuModel.mjs';
import { presentDanmakuText } from '../danmakuEmoji.mjs';

test('settings reject malformed storage and clamp supported numeric values', () => {
  assert.deepEqual(normalizeDanmakuSettings(null), DEFAULT_DANMAKU_SETTINGS);
  assert.deepEqual(normalizeDanmakuSettings({ opacity: -1, fontSize: 200, speed: NaN, area: 'unsafe', density: 'many' }),
    { opacity: 20, fontSize: 32, speed: 1, area: 'half', density: 'normal', sensitiveFilter: true, blockedWords: '' });
  assert.equal(normalizeDanmakuSettings({ opacity: '80' }).opacity, 80);
  assert.equal(normalizeDanmakuSettings({ opacity: null }).opacity, 80);
});

test('表情代码显示成 emoji，不认识的方括号保留', () => {
  assert.equal(presentDanmakuText('为剧组点赞[赞][赞][贊]更新真快[送花][送花]'), '为剧组点赞👍👍👍更新真快🌹🌹');
  assert.equal(presentDanmakuText('保留[不存在]和普通文字'), '保留[不存在]和普通文字');
  assert.equal(presentDanmakuText('已经是🌹'), '已经是🌹');
});

test('本集评论从画面外进入，开播时不会整排铺满', () => {
  const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
  const options = { width: 800, height: 450, settings: { ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', area: 'full' }, reducedMotion: false, seed: 9 };
  const comments = Array.from({ length: 15 }, (_, index) => `这是一条很长的本集评论${index}`.repeat(2));
  for (let frame = 0; frame < 20; frame++) advanceDanmaku(state, comments, 0.05, options);
  assert.ok(state.items.length >= 1 && state.items.length <= 4);
  assert.ok(state.items.every(item => item.x > options.width - 120));
  assert.ok(state.items.some(item => item.text.includes('👍') || !item.text.includes('[赞]')));
});

test('十五则本集评论会在这一集里分散飞完，换集节奏不同', () => {
  const comments = Array.from({ length: 15 }, (_, index) => `评论${index}[送花]`);
  const run = seed => {
    const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
    const options = { width: 960, height: 540, settings: { ...DEFAULT_DANMAKU_SETTINGS, area: 'full' }, reducedMotion: false, seed };
    let busiest = 0;
    const trace = [];
    for (let frame = 0; frame < 900; frame++) {
      advanceDanmaku(state, comments, 0.1, options);
      busiest = Math.max(busiest, state.items.length);
      if (state.items[0] && trace.length < 6) trace.push(`${state.items[0].lane}:${state.items[0].speed}`);
    }
    return { cursor: state.cursor, busiest, trace: trace.join('|'), shown: state.nextId };
  };
  const first = run(danmakuSeed('1000001', '2000001'));
  const same = run(danmakuSeed('1000001', '2000001'));
  const other = run(danmakuSeed('1000001', '2000002'));
  assert.equal(first.cursor, 15);
  assert.ok(first.shown >= 15);
  assert.ok(first.busiest >= 2 && first.busiest < 15);
  assert.equal(first.trace, same.trace);
  assert.notEqual(first.trace, other.trace);
});

test('较快的后发弹幕不会盖住同道上的前一条', () => {
  const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
  const options = { width: 900, height: 520, settings: { ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', area: 'full', speed: 2 }, reducedMotion: false, seed: 11 };
  const comments = Array.from({ length: 24 }, (_, index) => `第${index}条评论`);
  for (let frame = 0; frame < 500; frame++) {
    advanceDanmaku(state, comments, 0.05, options);
    const lanes = new Map();
    for (const item of state.items) {
      const list = lanes.get(item.lane) || [];
      list.push(item);
      lanes.set(item.lane, list);
    }
    for (const list of lanes.values()) {
      list.sort((a, b) => a.x - b.x);
      for (let index = 1; index < list.length; index++) {
        const ahead = list[index - 1];
        const behind = list[index];
        assert.ok(behind.x + 1 >= ahead.x + ahead.width + 24, `${behind.text} 盖住了 ${ahead.text}`);
        assert.ok((behind.speed || 1) <= (ahead.speed || 1) + 0.001);
      }
    }
  }
});

test('本集评论让开时间轴弹幕，并且不会比它更快', () => {
  const obstacle = { x: 300, y: 12, width: 100, speed: 1 };
  const state = {
    items: [{ id: 1, text: '评论', content: '评论', lane: 0, x: 360, y: 12, width: 80, age: 0, speed: 1.2 }],
    cursor: 1, nextId: 2, cooldown: 0, scheduleSeed: 9, randState: 9, clock: 5, nextGap: 100,
  };
  advanceDanmaku(state, ['评论'], 0.05, {
    width: 800, height: 400, settings: DEFAULT_DANMAKU_SETTINGS, reducedMotion: false, seed: 9, obstacles: [obstacle],
  });
  assert.ok(state.items[0].x >= obstacle.x + obstacle.width + 24 - 1);
  assert.ok(state.items[0].speed <= 1);
});

test('较慢的评论改成和时间轴同速，后面的时间轴不会盖上来', () => {
  const obstacle = { x: 420, y: 12, width: 90, speed: 1 };
  const state = {
    items: [{ id: 1, text: '评论', content: '评论', lane: 0, x: 200, y: 12, width: 80, age: 0, speed: 0.84 }],
    cursor: 1, nextId: 2, cooldown: 0, scheduleSeed: 3, randState: 3, clock: 5, nextGap: 100,
  };
  const options = { width: 800, height: 400, settings: DEFAULT_DANMAKU_SETTINGS, reducedMotion: false, seed: 3, obstacles: [obstacle] };
  for (let frame = 0; frame < 180; frame++) {
    advanceDanmaku(state, ['评论'], 1 / 60, options);
    obstacle.x -= 85 * (1 / 60);
    const item = state.items[0];
    const separated = item.x + 0.01 >= obstacle.x + obstacle.width + 24 || obstacle.x + 0.01 >= item.x + item.width + 24;
    assert.ok(separated, `第 ${frame} 帧互相覆盖 item=${item.x} obstacle=${obstacle.x}`);
    assert.ok(Math.abs(item.speed - 1) < 0.001);
  }
});

test('同一行已有时间轴时，新评论用相同速度，不从后面追上', () => {
  const obstacle = { x: 120, y: 12, width: 80, speed: 1 };
  const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
  const options = { width: 800, height: 140, settings: { ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', area: 'full' }, reducedMotion: false, seed: 9, obstacles: [obstacle] };
  for (let frame = 0; frame < 30; frame++) advanceDanmaku(state, ['新评论'], 0.05, options);
  assert.ok(state.items.length >= 1);
  assert.ok(state.items.every(item => item.y !== 12 || Math.abs(item.speed - 1) < 0.001));
  const shared = state.items.filter(item => item.y === 12);
  assert.ok(shared.length >= 1);
  assert.ok(shared.every(item => item.x >= obstacle.x + obstacle.width + 24 - 1 || obstacle.x >= item.x + item.width + 24 - 1));
});

test('scheduler bounds lanes, avoids overlaps, pauses and clamps long frame gaps', () => {
  const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
  const options = { width: 500, height: 300, settings: DEFAULT_DANMAKU_SETTINGS, reducedMotion: false };
  for (let i = 0; i < 600; i++) {
    advanceDanmaku(state, ['短评论', '长'.repeat(79)], 0.1, options);
    assert.ok(state.items.length <= 8);
    for (let left = 0; left < state.items.length; left++) for (let right = left + 1; right < state.items.length; right++) {
      const a = state.items[left], b = state.items[right];
      if (a.lane === b.lane) assert.ok(a.x >= b.x + b.width + 24 || b.x >= a.x + a.width + 24);
    }
  }
  const fresh = Array.from({ length: 100 }, (_, index) => String(index));
  advanceDanmaku(state, fresh, 0.1, options);
  const x = state.items[0].x;
  advanceDanmaku(state, fresh, 0, options);
  assert.equal(state.items[0].x, x);
  advanceDanmaku(state, fresh, 100, options);
  assert.ok(x - state.items[0].x <= 34);
});

test('reduced motion keeps one stationary comment and replaces it after reading time', () => {
  const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
  const options = { width: 500, height: 300, settings: DEFAULT_DANMAKU_SETTINGS, reducedMotion: true };
  advanceDanmaku(state, ['一', '二'], 0.1, options);
  const firstId = state.items[0].id;
  for (let i = 0; i < 70; i++) advanceDanmaku(state, ['一', '二'], 0.1, options);
  assert.equal(state.items.length, 1);
  assert.notEqual(state.items[0].id, firstId);
  assert.equal(state.items[0].x, 12);
});

test('缩小播放器保留可见弹幕并重排，不能压行或重播已消费内容', () => {
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, area: 'full', density: 'dense' };
  const large = { width: 1987, height: 1248, settings, reducedMotion: false };
  const small = { ...large, width: 500, height: 300 };
  const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
  for (let i = 0; i < 200; i++) advanceDanmaku(state, Array(40).fill('长'.repeat(60)), 0.1, large);
  const cursor = state.cursor;
  assert.ok(state.items.length >= 1 && state.items.length <= 16);
  assert.equal(model.resizeDanmaku(state, large, { ...small, width: 0 }), false);
  model.resizeDanmaku(state, large, small);
  assert.ok(state.items.length > 0);
  assert.equal(state.cursor, cursor);
  for (const item of state.items) {
    assert.ok(item.y + settings.fontSize * 1.25 <= small.height - 76);
    assert.ok(item.x < small.width && item.x + item.width > 0);
  }
  for (let i = 0; i < state.items.length; i++) for (let j = i + 1; j < state.items.length; j++) {
    const a = state.items[i], b = state.items[j];
    assert.ok(a.lane !== b.lane || a.x >= b.x + b.width + 24 || b.x >= a.x + a.width + 24);
  }
});


test('consumed comments never loop and appended pages continue from current position', () => {
  const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
  const options = { width: 500, height: 300, settings: DEFAULT_DANMAKU_SETTINGS, reducedMotion: true };
  for (let i = 0; i < 200; i++) advanceDanmaku(state, ['first', 'second'], 0.1, options);
  assert.equal(state.cursor, 2);
  assert.equal(state.items.length, 0);
  advanceDanmaku(state, ['first', 'second', 'third'], 0.1, options);
  assert.equal(state.items[0].text, 'third');
});

test('paged feed deduplicates IDs and stops on unchanged or cycling cursors', () => {
  assert.equal(typeof model.createCommentFeed, 'function');
  const feed = model.createCommentFeed('123456', '654321');
  const page = (items, next_cursor, has_more = true) => ({ success: true, series_id: '123456', episode_id: '654321', items, next_cursor, has_more });
  model.appendCommentPage(feed, page([{ id: '1', content: 'one' }], 'next'), DEFAULT_DANMAKU_SETTINGS);
  model.appendCommentPage(feed, page([{ id: '1', content: 'one' }, { id: '2', content: 'two' }], 'next'), DEFAULT_DANMAKU_SETTINGS);
  assert.equal(feed.comments.length, 2);
  assert.equal(feed.hasMore, false);
  assert.match(feed.notice, /游标/);
  const other = model.createCommentFeed('123456', '654321');
  assert.throws(() => model.appendCommentPage(other, { ...page([], null, false), episode_id: '999999' }, DEFAULT_DANMAKU_SETTINGS));
  assert.equal(other.comments.length, 0);
  model.appendCommentPage(other, page([], 'a'), DEFAULT_DANMAKU_SETTINGS);
  model.appendCommentPage(other, page([], 'b'), DEFAULT_DANMAKU_SETTINGS);
  model.appendCommentPage(other, page([], 'a'), DEFAULT_DANMAKU_SETTINGS);
  assert.equal(other.hasMore, false);
});

test('filter checks full comment before shortening; custom words work with built-in filter disabled', () => {
  assert.equal(typeof model.commentIsBlocked, 'function');
  assert.equal(model.commentIsBlocked('普通内容'.repeat(30) + '台独', DEFAULT_DANMAKU_SETTINGS), true);
  const settings = normalizeDanmakuSettings({ sensitiveFilter: false, blockedWords: '  MyWORD\n自定义词  ' });
  assert.equal(model.commentIsBlocked('含有 myword 的评论', settings), true);
  assert.equal(model.commentIsBlocked('含有台独的评论', settings), false);
  const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
  advanceDanmaku(state, [{ content: '普通内容'.repeat(30) + '台独' }, { content: '正常评论' }], 0.1,
    { width: 500, height: 300, settings: DEFAULT_DANMAKU_SETTINGS, reducedMotion: true });
  assert.equal(state.items[0].text, '正常评论');
  assert.equal(state.cursor, 2);
});

test('fully filtered pages can advance, but five empty pages stop until user continues', () => {
  assert.equal(typeof model.createCommentFeed, 'function');
  const feed = model.createCommentFeed('123456', '654321');
  for (let i = 0; i < 5; i++) model.appendCommentPage(feed, { success: true, series_id: '123456', episode_id: '654321',
    items: [{ id: String(i), content: '台独' }], next_cursor: String(i + 1), has_more: true }, DEFAULT_DANMAKU_SETTINGS);
  assert.equal(feed.hasMore, true);
  assert.equal(feed.cursor, '5');
  assert.equal(feed.emptyPages, 5);
  assert.ok(feed.error);
});


test('limited source preserves the exact limitation and full text until display', () => {
  const feed = model.createCommentFeed('123456', '654321');
  const original = '字'.repeat(100) + ' END';
  model.appendCommentPage(feed, { success: true, series_id: '123456', episode_id: '654321',
    items: [{ id: 'a', content: original }, { id: 'b', content: '  正常\n评论  ' }, { content: '' }, { content: 3 }],
    has_more: false, next_cursor: null, source_limited: true, notice: '官网仅提供部分评论' }, DEFAULT_DANMAKU_SETTINGS);
  assert.equal(feed.sourceLimited, true);
  assert.equal(feed.notice, '官网仅提供部分评论');
  assert.equal(feed.hasMore, false);
  assert.equal(feed.comments[0].content, original);
  assert.equal(feed.comments[1].content, '正常 评论');
  assert.equal(feed.comments.length, 2);
  advanceDanmaku(feed.animation, feed.comments, 0.1, { width: 500, height: 300, settings: DEFAULT_DANMAKU_SETTINGS, reducedMotion: true });
  assert.equal(Array.from(feed.animation.items[0].text).length, 80);
  const nextEpisode = model.createCommentFeed('123456', '654322');
  assert.equal(nextEpisode.animation.cursor, 0);
  assert.equal(nextEpisode.comments.length, 0);
});


test('all three comment densities emit more distinct comments while keeping their order', () => {
  const counts = ['sparse', 'normal', 'dense'].map((density, index) => {
    const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
    const comments = Array.from({ length: 40 }, (_, i) => `comment ${i}`);
    const options = { width: 1987, height: 1248, settings: { ...DEFAULT_DANMAKU_SETTINGS, density, area: 'full' }, reducedMotion: false };
    for (let frame = 0; frame < 720; frame++) advanceDanmaku(state, comments, 1 / 60, options);
    assert.ok(state.nextId >= [1, 2, 3][index], `${density}: ${state.nextId}`);
    assert.equal(new Set(state.items.map(item => item.content)).size, state.items.length);
    return state.nextId;
  });
  assert.ok(counts[0] < counts[1] && counts[1] < counts[2]);
});


test('少量评论滚出后轮播，追加的新评论优先，屏蔽和暂停有效', () => {
  const state = { items: [], cursor: 0, nextId: 0, cooldown: 0 };
  const comments = ['甲', '乙', '丙'];
  const runtime = { width: 500, height: 300, settings: { ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', speed: 2 }, reducedMotion: false };
  for (let frame = 0; frame < 1800; frame++) {
    advanceDanmaku(state, comments, 1 / 60, runtime);
    assert.ok(state.items.length <= 8, `不能一次铺满: ${frame}`);
    assert.equal(new Set(state.items.map(item => item.content)).size, state.items.length);
  }
  assert.ok(state.nextId > comments.length);
  comments.push('新内容');
  let sawNew = false;
  for (let frame = 0; frame < 300; frame++) {
    advanceDanmaku(state, comments, 1 / 60, runtime);
    if (state.items.some(item => item.content === '新内容')) sawNew = true;
  }
  assert.equal(state.cursor, 4);
  assert.ok(sawNew);
  const before = JSON.stringify(state);
  advanceDanmaku(state, comments, 0, runtime);
  assert.equal(JSON.stringify(state), before);
  state.items = [];
  runtime.settings = { ...runtime.settings, blockedWords: comments.join(',') };
  for (let frame = 0; frame < 600; frame++) advanceDanmaku(state, comments, 1 / 60, runtime);
  assert.equal(state.items.length, 0);
});

test('评论超时会再试，空页面只再确认一次，永久错误立即停下', () => {
  const feed = model.createCommentFeed('123456', '654321');
  const settings = model.DEFAULT_DANMAKU_SETTINGS;
  assert.equal(model.commentFetchBlocked(feed, 10000, false), false);
  assert.equal(model.acceptCommentPage(feed, { success: false, retryable: true, error: '公开评论加载超时，请重试' }, settings, 10000), 'retry');
  assert.equal(feed.error, '');
  assert.equal(model.commentFetchBlocked(feed, 10000, false), true);
  assert.equal(model.commentFetchBlocked(feed, feed.nextTryAt, false), false);
  assert.equal(model.acceptCommentPage(feed, { success: true, series_id: '123456', episode_id: '654321', items: [] }, settings, feed.nextTryAt), 'retry');
  assert.equal(feed.comments.length, 0);
  assert.equal(model.acceptCommentPage(feed, { success: true, series_id: '123456', episode_id: '654321', items: [], has_more: false }, settings, feed.nextTryAt), 'done');
  assert.equal(feed.loaded, true);
  const fatal = model.createCommentFeed('123456', '654321');
  assert.equal(model.acceptCommentPage(fatal, { success: false, retryable: false, error: '评论请求编号或条数无效' }, settings, 1), 'stop');
  assert.equal(fatal.error, '评论请求编号或条数无效');
  const flaky = model.createCommentFeed('123456', '654322');
  for (let attempt = 0; attempt < 3; attempt++) model.commentFailureAction(flaky, { retryable: true, error: '公开评论加载超时，请重试' }, attempt);
  assert.equal(flaky.error, '');
  model.commentFailureAction(flaky, { retryable: true, error: '公开评论加载超时，请重试' }, 10);
  assert.match(flaky.error, /超时/);
});

test('下一集弹幕只在当前集读完后预载一次', () => {
  const warmed = new Set();
  const ready = { enabled: true, timelineReady: true, seriesId: '7503745441910017049', nextEpisodeId: '7503780574541122622', warmed };
  const plan = planDanmakuWarmup(ready);
  assert.equal(plan.episodeId, '7503780574541122622');
  warmed.add(plan.key);
  assert.equal(planDanmakuWarmup(ready), null);
  assert.equal(planDanmakuWarmup({ ...ready, timelineReady: false, nextEpisodeId: '7503780574541122623' }), null);
  assert.equal(planDanmakuWarmup({ ...ready, enabled: false, nextEpisodeId: '7503780574541122623' }), null);
  assert.equal(planDanmakuWarmup({ ...ready, seriesId: 'custom:example', nextEpisodeId: '7503780574541122623' }), null);
  assert.ok(planDanmakuWarmup({ ...ready, nextEpisodeId: '7503780574541122623' }));
});
