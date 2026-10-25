// Adapted from dawei233/hongguo-drama, commit c884fab6c6e36ad38173e251738b9b35f958383f (GPL-3.0).
// https://github.com/dawei233/hongguo-drama
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DANMAKU_SOURCE, normalizeDanmakuSource, createOfficialFeed, appendOfficialPage,
  advanceTimedDanmaku, lowerBoundTime, resolveDanmakuStatus, selectTimelinePlayback,
} from '../danmakuOfficial.mjs';
import { DEFAULT_DANMAKU_SETTINGS } from '../danmakuModel.mjs';
import * as sharedModel from '../danmakuModel.mjs';

const SERIES = '7503745441910017049';
const VID = '7503780574541122622';

const makeFeed = () => createOfficialFeed(SERIES, VID);
const at = (time, text) => ({ time, text, color: '#FFFFFF', mode: 'scroll' });
const options = (settings = DEFAULT_DANMAKU_SETTINGS, extra = {}) => ({ width: 800, height: 600, settings, reducedMotion: false, ...extra });

/** 按 60fps 推进到指定时间，模拟真实播放。 */
function playTo(state, list, from, to, optionsFor) {
  const step = 1 / 60;
  for (let time = from; time <= to + 1e-9; time += step) {
    advanceTimedDanmaku(state, list, Math.min(time, to), step, optionsFor);
  }
}

test('时间轴超过 35 条时均匀留下 35 条，开头和结尾都在', () => {
  assert.deepEqual(selectTimelinePlayback(null), []);
  assert.equal(selectTimelinePlayback(Array.from({ length: 25 }, (_, index) => at(index, `少${index}`))).length, 25);
  assert.equal(selectTimelinePlayback(Array.from({ length: 35 }, (_, index) => at(index, `满${index}`))).length, 35);
  const many = Array.from({ length: 80 }, (_, index) => at(index * 1.5, `多${index}`));
  const picked = selectTimelinePlayback(many);
  assert.equal(picked.length, 35);
  assert.equal(picked[0], many[0]);
  assert.equal(picked.at(-1), many.at(-1));
  for (let index = 1; index < picked.length; index++) assert.ok(picked[index].time > picked[index - 1].time);
  assert.equal(many.length, 80);
  const crowded = selectTimelinePlayback(Array.from({ length: 36 }, (_, index) => at(index, `边${index}`)));
  assert.equal(crowded.length, 35);
  assert.equal(new Set(crowded.map(item => item.text)).size, 35);
});

test('时间轴弹幕保留时间点，并把表情代码显示成 emoji', () => {
  const state = { items: [], nextId: 0, cursor: 0, cooldown: 0, lastTime: undefined, replayQueue: [] };
  const list = [at(0, '点赞[赞][送花]'), at(2, '稍后')];
  advanceTimedDanmaku(state, list, 0.1, 0.016, options());
  assert.equal(state.items[0].text, '点赞👍🌹');
  assert.equal(state.items[0].content, '点赞[赞][送花]');
  assert.equal(state.items.length, 1);
});

test('弹幕源只接受已知取值，其余一律回落官方弹幕', () => {
  assert.equal(normalizeDanmakuSource('comments'), 'comments');
  assert.equal(normalizeDanmakuSource('official'), 'official');
  assert.equal(normalizeDanmakuSource('随便什么'), DEFAULT_DANMAKU_SOURCE);
  assert.equal(normalizeDanmakuSource(undefined), 'official');
  assert.equal(DEFAULT_DANMAKU_SOURCE, 'official');
});

test('lowerBoundTime 定位到第一条不早于给定时间的弹幕', () => {
  const list = [at(1, 'a'), at(3, 'b'), at(3.5, 'c'), at(9, 'd')];
  assert.equal(lowerBoundTime(list, 0), 0);
  assert.equal(lowerBoundTime(list, 3), 1);
  assert.equal(lowerBoundTime(list, 3.2), 2);
  assert.equal(lowerBoundTime(list, 10), 4);
});

test('appendOfficialPage 合并、去重、按时间排序，并保留失败说明', () => {
  const feed = makeFeed();
  appendOfficialPage(feed, {
    success: true, series_id: SERIES, episode_id: VID, truncated: false,
    items: [at(5, '后'), at(1, '前'), at(1, '前')],
  });
  assert.deepEqual(feed.danmaku.map(item => item.text), ['前', '后']);
  assert.equal(feed.loaded, true);
  assert.equal(feed.error, '');

  // 分页结果二次写入不应产生重复
  appendOfficialPage(feed, { success: true, series_id: SERIES, episode_id: VID, items: [at(1, '前'), at(7, '新')] });
  assert.deepEqual(feed.danmaku.map(item => item.text), ['前', '后', '新']);

  const failed = makeFeed();
  appendOfficialPage(failed, { success: false, series_id: SERIES, episode_id: VID, items: [], error: '弹幕接口不可用（HTTP 502）' });
  assert.equal(failed.error, '弹幕接口不可用（HTTP 502）');
});

test('appendOfficialPage 拒绝身份不匹配的响应（防止串集）', () => {
  const feed = makeFeed();
  assert.throws(() => appendOfficialPage(feed, { success: true, series_id: SERIES, episode_id: '999', items: [] }));
  assert.equal(feed.danmaku.length, 0);
});

test('弹幕只在时间到点时投放，不会提前出现', () => {
  const state = makeFeed().animation;
  const list = [at(10, '十秒')];
  playTo(state, list, 0, 5, options());
  assert.equal(state.items.length, 0, '5 秒时不该出现 10 秒的弹幕');
  playTo(state, list, 5, 10.05, options());
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].text, '十秒');
});

test('全屏和半屏在已有轨道放不下时扩展相邻行，不拉大行距', () => {
  for (const area of ['half', 'full']) {
    const state = makeFeed().animation;
    const settings = { ...DEFAULT_DANMAKU_SETTINGS, area };
    const list = Array.from({ length: 40 }, () => at(0, '长'.repeat(70)));
    playTo(state, list, 0, 4, options(settings, { width: 1987, height: 1248 }));
    const rows = [...new Set(state.items.map(item => item.y))].sort((a, b) => a - b);
    assert.ok(rows.length >= 10, `${area} 应能使用至少十行，实际 ${rows.length}`);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i] - rows[i - 1] <= settings.fontSize * 2);
    assert.ok(rows.at(-1) + settings.fontSize * 1.25 <= (area === 'half' ? 624 : 1248 - 76));
  }
});

test('密集半屏短弹幕复用已有空位，不因还有空行而留下整屏横向空档', () => {
  const state = makeFeed().animation;
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, area: 'half', density: 'dense', fontSize: 20, opacity: 25, speed: 2 };
  const runtime = options(settings, { width: 1987, height: 1248 });
  const list = Array.from({ length: 10 }, (_, index) => at(index * 0.7, `弹幕${index}`));
  playTo(state, list, 0, 6.4, runtime);
  assert.equal(state.nextId, list.length, '每条到点弹幕只投放一次');
  assert.deepEqual(state.items.map(item => item.content), list.map(item => item.text));
  assert.equal(new Set(state.items.map(item => item.lane)).size, 1, '前条已让出安全空位时应接在同一行');
  for (let index = 1; index < state.items.length; index++) {
    const older = state.items[index - 1];
    const newer = state.items[index];
    const gap = newer.x - older.x - older.width;
    assert.ok(gap >= 24 - 1e-6 && gap <= 45, `到点即续发且保持安全间距，实际 ${gap}`);
  }
});

test('三个密度档都提高突发投放量，并保持递增', () => {
  const counts = ['sparse', 'normal', 'dense'].map((density, i) => {
    const state = makeFeed().animation;
    const settings = { ...DEFAULT_DANMAKU_SETTINGS, density, area: 'full' };
    playTo(state, Array.from({ length: 80 }, () => at(0, '长'.repeat(70))), 0, 1,
      options(settings, { width: 1987, height: 1248 }));
    assert.ok(state.nextId >= [3, 6, 15][i], `${density} 投放量不足：${state.nextId}`);
    return state.nextId;
  });
  assert.ok(counts[0] < counts[1] && counts[1] < counts[2]);
});

test('进入和退出全屏保留在屏弹幕、时间光标与播放进度', () => {
  assert.equal(typeof sharedModel.resizeDanmaku, 'function');
  const state = makeFeed().animation;
  const list = Array.from({ length: 8 }, (_, index) => at(index, `保留${index}`));
  const small = options();
  const full = options(DEFAULT_DANMAKU_SETTINGS, { width: 1987, height: 1248 });
  playTo(state, list, 0, 5, small);
  const ids = state.items.map(item => item.id);
  const cursor = state.cursor;
  const lastTime = state.lastTime;
  for (const [before, after] of [[small, full], [full, small]]) {
    sharedModel.resizeDanmaku(state, before, after);
    assert.deepEqual(state.items.map(item => item.id), ids);
    assert.equal(state.cursor, cursor);
    assert.equal(state.lastTime, lastTime);
    assert.ok(state.items.some(item => item.x < after.width && item.x + item.width > 0), '暂停切换也应立即有可见弹幕');
    advanceTimedDanmaku(state, list, lastTime, 0, after);
    assert.deepEqual(state.items.map(item => item.id), ids);
  }
});

test('倒退跳转：重建后续光标并保留在屏弹幕', () => {
  const state = makeFeed().animation;
  const list = [at(1, 'a'), at(2, 'b'), at(30, 'c')];
  playTo(state, list, 0, 3, options());
  assert.equal(state.items.length, 2);
  const cursorBefore = state.cursor;
  assert.equal(cursorBefore, 2);

  // 跳回 1.5 秒：1.5 秒之后、含 2 秒的弹幕应重新可发
  advanceTimedDanmaku(state, list, 1.5, 0, options());
  assert.equal(state.items.length, 2, '跳转时在屏弹幕继续自然滚动');
  assert.equal(state.cursor, 1, '光标应回到 1.5 秒对应的位置');
});

test('快进跳转：不把中间整段弹幕一次性倒到屏幕上', () => {
  const state = makeFeed().animation;
  const list = Array.from({ length: 200 }, (_, index) => at(index + 1, `弹幕${index + 1}`));
  playTo(state, list, 0, 2, options());
  const resumeAt = lowerBoundTime(list, 145);
  advanceTimedDanmaku(state, list, 150, 0.016, options());
  // 单帧最多投放有限条，绝不能因为快进而把 1~150 秒的弹幕全倒出来。
  assert.ok(state.items.length <= 4, `快进后单帧投放应受限，实际 ${state.items.length}`);
  assert.ok(state.cursor >= resumeAt, '光标应落在仍算新鲜的窗口内');
  assert.ok(state.cursor <= resumeAt + 4, '光标不应越过快进位置批量消费');
});

test('严重迟到的弹幕被丢弃，不补发', () => {
  const state = makeFeed().animation;
  const list = [at(0, '早就过去了'), at(20, '正常')];
  advanceTimedDanmaku(state, list, 20, 0.016, options());
  assert.deepEqual(state.items.map(item => item.text), ['正常']);
});

test('屏蔽词命中的弹幕被跳过，且不占用通道', () => {
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, blockedWords: '屏蔽我' };
  const state = makeFeed().animation;
  const list = [at(0, '屏蔽我'), at(0, '正常')];
  advanceTimedDanmaku(state, list, 0, 0.016, options(settings));
  assert.deepEqual(state.items.map(item => item.text), ['正常']);
});

test('同一道内允许续发：前一条走出足够距离后可以再发', () => {
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, density: 'sparse' };
  const runtime = options(settings, { height: 120 }); // 小容器只容纳一行。
  const state = makeFeed().animation;
  const list = [at(0, '第一条'), at(2, '第二条')];
  advanceTimedDanmaku(state, list, 0, 0.016, runtime);
  assert.equal(state.items.length, 1);
  // 只推进 0.1 秒：第一条还占着道口，第二条必须等待
  playTo(state, list, 0, 0.1, runtime);
  assert.equal(state.items.length, 1);
  // 推进到 3.5 秒：第二条已到点、第一条也走远，两条应同时在屏
  playTo(state, list, 0.1, 3.5, runtime);
  assert.equal(state.items.length, 2);
  assert.deepEqual(state.items.map(item => item.text), ['第一条', '第二条']);
  assert.equal(state.cursor, 2, '两条都应被消费');
});

test('真实密度下不丢弹幕：0.5 条/秒的 100 条应全部投放', () => {
  const state = makeFeed().animation;
  // 时间轴 0~198 秒，每 2 秒一条，接近实测的每集弹幕密度
  const list = Array.from({ length: 100 }, (_, index) => at(index * 2, `弹幕${index}`));
  playTo(state, list, 0, 200, options());
  assert.equal(state.cursor, 100, '全部弹幕都应被消费');
  assert.equal(state.nextId, 100, '不该有弹幕因为迟到而被丢弃');
});

test('突发弹幕不会互相追尾：同道内前后两条始终保持间距', () => {
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, density: 'normal' };
  const state = makeFeed().animation;
  const list = Array.from({ length: 40 }, (_, index) => at(10, `突发${index}`));
  const step = 1 / 60;
  let peak = 0;
  let checked = 0;
  for (let time = 0; time <= 25; time += step) {
    advanceTimedDanmaku(state, list, time, step, options(settings));
    peak = Math.max(peak, state.items.length);
    // 同道内按 x 降序，新的那条必须整条落在旧的那条右侧留出间距之内
    for (const lane of new Set(state.items.map(item => item.lane))) {
      const inLane = state.items.filter(item => item.lane === lane).sort((a, b) => b.x - a.x);
      for (let i = 1; i < inLane.length; i++) {
        const newer = inLane[i - 1];
        const older = inLane[i];
        assert.ok(newer.x >= older.x + older.width + 24 - 1e-6,
          `同道追尾：${newer.text} 追上 ${older.text}（x=${newer.x.toFixed(1)} vs ${(older.x + older.width).toFixed(1)}）`);
        checked++;
      }
    }
  }
  assert.ok(peak > 3, `通道应被复用，实际峰值只有 ${peak}`);
  assert.ok(peak <= Math.ceil(5 / 0.15) + 1, `突发投放应受迟到窗口与间隔限制，实际峰值 ${peak}`);
  assert.ok(checked > 0, '应至少检查到一对同道弹幕');
});

test('多道模式下同屏弹幕不重叠', () => {
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', area: 'full' };
  const state = makeFeed().animation;
  const list = Array.from({ length: 60 }, (_, index) => at(index * 0.05, `第${index}条`));
  playTo(state, list, 0, 20, options(settings));
  const items = state.items;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      assert.ok(Math.abs(a.y - b.y) >= settings.fontSize + 12 ||
        a.x >= b.x + b.width + 24 - 1e-6 || b.x >= a.x + a.width + 24 - 1e-6, '同屏弹幕不得重叠');
    }
  }
});

test('减少动态效果时改为静态轮换：只留一条、停在左侧、读完替换', () => {
  const state = makeFeed().animation;
  const list = [at(0, '一'), at(0.1, '二')];
  const runtime = options(DEFAULT_DANMAKU_SETTINGS, { reducedMotion: true });
  advanceTimedDanmaku(state, list, 0, 0.016, runtime);
  assert.equal(state.items.length, 1);
  const firstId = state.items[0].id;
  assert.equal(state.items[0].x, 12);
  playTo(state, list, 0, 8, runtime);
  assert.equal(state.items.length, 1);
  assert.notEqual(state.items[0].id, firstId);
  assert.equal(state.items[0].x, 12);
});

test('暂停时不推进：位置与时间都不变', () => {
  const state = makeFeed().animation;
  const list = [at(0, '停住')];
  advanceTimedDanmaku(state, list, 0, 0.016, options());
  playTo(state, list, 0, 1, options());
  const x = state.items[0].x;
  // elapsed=0 表示这一帧媒体时间没有前进（暂停）
  advanceTimedDanmaku(state, list, 1, 0, options());
  assert.equal(state.items[0].x, x);
});

test('容器过小或列表为空时不抛异常，也不谎报变化', () => {
  const state = makeFeed().animation;
  assert.equal(advanceTimedDanmaku(state, [], 1, 0.016, options()), false);
  assert.equal(advanceTimedDanmaku(state, [at(0, 'x')], 1, 0.016, options(DEFAULT_DANMAKU_SETTINGS, { width: 10, height: 10 })), false);
  assert.equal(advanceTimedDanmaku(state, [at(0, 'x')], 1, 0.016, options(DEFAULT_DANMAKU_SETTINGS, { width: 800, height: 20 })), false);
});

test('长弹幕被截断到 80 字，并保留原文供设置变更时重新计算', () => {
  const state = makeFeed().animation;
  const long = '字'.repeat(120);
  advanceTimedDanmaku(state, [at(0, long)], 0, 0.016, options());
  assert.equal(Array.from(state.items[0].text).length, 80);
  assert.equal(state.items[0].content, long);
});

test('状态出口：失败绝不说成"暂无弹幕"', () => {
  const base = { source: 'official', supported: true, enabled: true, active: true, visible: true, loading: false, notice: '', loaded: true, count: 0 };
  // 有 error 时必须原样透出
  assert.equal(resolveDanmakuStatus({ ...base, error: '弹幕接口不可用（HTTP 502）' }), '弹幕接口不可用（HTTP 502）');
  // 没 error 且没有内容，才是真的没有弹幕
  assert.equal(resolveDanmakuStatus({ ...base, error: '' }), '本集暂无弹幕');
  // 有内容时给出条数，并带上来源限制说明
  assert.match(resolveDanmakuStatus({ ...base, count: 12, notice: '上游仅返回部分结果' }), /已载入 12 条弹幕/);
  assert.match(resolveDanmakuStatus({ ...base, count: 12, notice: '上游仅返回部分结果' }), /上游仅返回部分结果/);
  // 未启用 / 不支持 / 未播放 各有明确说法
  assert.match(resolveDanmakuStatus({ ...base, enabled: false }), /开启后/);
  assert.match(resolveDanmakuStatus({ ...base, supported: false }), /仅红果来源/);
  assert.match(resolveDanmakuStatus({ ...base, active: false }), /播放本集后/);
  assert.equal(resolveDanmakuStatus({ ...base, visible: false }), '');
  assert.match(resolveDanmakuStatus({ ...base, error: '', loaded: false }), /正在加载/);
});


test('不完整响应不能当成本集没有弹幕', () => {
  for (const data of [
    { series_id: SERIES, episode_id: VID, items: [] },
    { success: true, series_id: SERIES, episode_id: VID },
  ]) {
    const feed = makeFeed();
    assert.throws(() => appendOfficialPage(feed, data), /Invalid/);
    assert.equal(feed.loaded, false);
  }
});

test('部分结果与截断结果始终说明限制', () => {
  for (const flag of ['partial', 'truncated']) {
    const feed = makeFeed();
    appendOfficialPage(feed, { success: true, series_id: SERIES, episode_id: VID, items: [], [flag]: true });
    assert.match(feed.notice, /部分|限制/);
  }
});


test('backward seek never duplicates a comment that is still visible', () => {
  const state = makeFeed().animation;
  const list = [at(1, 'keep rolling')];
  advanceTimedDanmaku(state, list, 1, 0.016, options());
  const id = state.items[0].id;
  advanceTimedDanmaku(state, list, 0.5, 0, options());
  advanceTimedDanmaku(state, list, 1, 0.5, options());
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].id, id);
});


test('少量时间轴弹幕只播放一次，空档保持空白，新到点仍优先', () => {
  const state = makeFeed().animation;
  const list = [at(0, '甲'), at(0.2, '乙'), at(0.4, '丙'), at(20, '新内容')];
  const runtime = options({ ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', speed: 2 }, { width: 500, height: 300 });
  const emitted = new Map();
  const seenIds = new Set();
  let quiet = false;
  for (let frame = 0; frame < 2400; frame++) {
    const time = frame / 60;
    advanceTimedDanmaku(state, list, time, 1 / 60, runtime);
    assert.equal(new Set(state.items.map(item => item.content)).size, state.items.length);
    for (const item of state.items) {
      assert.ok(item.entry.time <= time);
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        emitted.set(item.entry, (emitted.get(item.entry) || 0) + 1);
      }
    }
    if (time > 8 && time < 19) {
      if (!state.items.length) quiet = true;
      assert.ok(state.items.every(item => item.entry !== list[3]), '未到点的弹幕不能提前补上');
    }
    if (time > 20.1 && time < 20.2) assert.ok(state.items.some(item => item.entry === list[3]));
  }
  assert.ok(quiet, '前面几条飞完后应留下空档，而不是循环重播');
  assert.equal(emitted.size, list.length);
  for (const count of emitted.values()) assert.equal(count, 1);
  assert.equal(state.cursor, list.length);
});

test('密集模式新弹幕供应充足时不轮播', () => {
  const state = makeFeed().animation;
  const list = Array.from({ length: 800 }, (_, i) => at(i / 10, `真实${i}`));
  const runtime = options({ ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', speed: 2 });
  const entries = new Set(); const ids = new Set();
  for (let frame = 0; frame < 2400; frame++) {
    advanceTimedDanmaku(state, list, frame / 60, 1 / 60, runtime);
    for (const item of state.items) if (!ids.has(item.id)) {
      assert.ok(!entries.has(item.entry), '供应充足不能轮播');
      entries.add(item.entry); ids.add(item.id);
    }
  }
});


test('跳转和缓冲保留在屏内容，暂停不补发已经飞过的弹幕', () => {
  const state = makeFeed().animation;
  const list = [at(0, '甲'), at(0.2, '乙'), at(0.4, '丙')];
  const runtime = options({ ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', speed: 2 }, { width: 500, height: 300 });
  playTo(state, list, 0, 8, runtime);
  assert.equal(state.nextId, 3);
  const ids = state.items.map(item => item.id);
  advanceTimedDanmaku(state, list, 50, 0.016, runtime);
  assert.ok(ids.every(id => state.items.some(item => item.id === id)));
  advanceTimedDanmaku(state, list, 0.1, 0.016, runtime);
  assert.ok(ids.every(id => state.items.some(item => item.id === id)));
  const nextId = state.nextId;
  advanceTimedDanmaku(state, list, 0.1, 0.1, { ...runtime, emitting: false });
  assert.equal(state.nextId, nextId);
  advanceTimedDanmaku(state, list, 0.1, 0, runtime);
  assert.equal(state.nextId, nextId);
});

test('稀疏真实时间点从空档续播时不补历史，也不提前投放', () => {
  const list = [25.484, 64.009, 78.148, 78.694].map((time, i) => at(time, `真实${i}`));
  const state = makeFeed().animation;
  const runtime = options({ ...DEFAULT_DANMAKU_SETTINGS, density: 'dense' });
  advanceTimedDanmaku(state, list, 52, 0, runtime);
  assert.equal(state.items.length, 0, '静止首帧不补发');
  playTo(state, list, 52.016, 63.5, runtime);
  assert.equal(state.items.length, 0, '已经过去的弹幕不再循环补空档');
  playTo(state, list, 63.516, 64.1, runtime);
  assert.ok(state.items.some(item => item.entry === list[1]), '到点内容仍会播出');
  assert.ok(state.items.every(item => item.entry.time >= 64 && item.entry.time <= 64.1));
});

test('重新开启和空屏跳转不回放历史，静止帧也不补发', () => {
  const list = [at(0.1, '早期'), at(0.2, '早期'), at(0.3, '屏蔽'), ...Array.from({ length: 20 }, (_, i) => at(1 + i, `历史${i}`)), at(80, '未来')];
  const runtime = options({ ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', blockedWords: '屏蔽' });
  const state = makeFeed().animation;
  advanceTimedDanmaku(state, list, 0.5, 0.016, runtime);
  assert.deepEqual(state.items.map(item => item.content), ['早期']);
  Object.assign(state, { lastTime: undefined, items: [] });
  advanceTimedDanmaku(state, list, 52, 0.016, runtime);
  assert.equal(state.items.length, 0, '空档不能把已飞过的历史再铺上来');
  advanceTimedDanmaku(state, list, 60, 0, runtime);
  assert.equal(state.items.length, 0);
  playTo(state, list, 80, 80.05, runtime);
  assert.deepEqual(state.items.map(item => item.content), ['未来']);
});

test('空档续播和减少动态效果都不补发已经过去的弹幕', () => {
  const list = Array.from({ length: 8 }, (_, i) => at(i, `历史${i}`));
  for (const density of ['sparse', 'normal', 'dense']) {
    const state = makeFeed().animation;
    const runtime = options({ ...DEFAULT_DANMAKU_SETTINGS, density });
    advanceTimedDanmaku(state, list, 52, 0.016, { ...runtime, emitting: false });
    assert.equal(state.items.length, 0);
    playTo(state, list, 52, 53, runtime);
    assert.equal(state.items.length, 0, `${density} 不能循环历史`);
  }
  const reduced = makeFeed().animation;
  advanceTimedDanmaku(reduced, list, 52, 0.016, options(DEFAULT_DANMAKU_SETTINGS, { reducedMotion: true }));
  assert.equal(reduced.items.length, 0);
});

test('时间轴让开仍在画面右侧的本集评论', () => {
  const state = makeFeed().animation;
  const runtime = options(DEFAULT_DANMAKU_SETTINGS, {
    obstacles: [{ x: 760, y: 12, width: 80, speed: 1 }],
  });
  advanceTimedDanmaku(state, [at(0, '时间轴')], 0.016, 0.016, runtime);
  assert.equal(state.items.length, 1);
  assert.notEqual(state.items[0].y, 12);
});

test('丰富片源中途续播不为历史回放挤占新到点弹幕', () => {
  const state = makeFeed().animation;
  const list = Array.from({ length: 800 }, (_, i) => at(i / 10, `真实${i}`));
  const runtime = options({ ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', speed: 2 });
  const entries = new Set(), ids = new Set();
  for (let frame = 0; frame < 600; frame++) {
    advanceTimedDanmaku(state, list, 52 + frame / 60, 1 / 60, runtime);
    for (const item of state.items) if (!ids.has(item.id)) {
      assert.ok(item.entry.time >= 47, '只保留跳转前仍算新鲜的几秒，不回放整段历史');
      assert.ok(!entries.has(item.entry), '供应充足时不轮播');
      entries.add(item.entry); ids.add(item.id);
    }
  }
  assert.ok(entries.size > 50);
});
