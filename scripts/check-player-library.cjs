// Fixture-only library intent regression. No real media, network or user data.
const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');
(async () => {
  for (const local of [false, true]) {
    const ui = mount({ local, saved: { vid_index: 2, currentTime: 99 }, props: { target: null } });
    await ui.flush();
    assert.equal(ui.prepares.length, 0, 'opening library must not prepare old streams');
    assert.equal(ui.find(n => n.type === 'video').props.src, undefined, 'opening library must not attach local media');
    assert.equal(ui.mediaCalls.play, 0);
    ui.button('播放本集').props.onClick(); await ui.flush(); ui.metadata();
    assert.equal(ui.media.paused, false, 'explicit play still starts');
    ui.episode(1); await ui.flush(); ui.metadata();
    assert.equal(ui.media.paused, false, 'explicit episode selection still starts');
    ui.unmount();
  }
  const ui = mount({ props: { target: null, onNavigate() {} } }); await ui.flush();
  const panel = () => ui.find(n => n.props.id === 'player-management');
  assert.equal(panel().props.hidden, true);
  ui.button('管理').props.onClick(); await ui.flush();
  assert.equal(panel().props.hidden, false, 'management opens real actions in either layout');
  assert.ok(ui.button('播放设置')); ui.unmount();
  for (const local of [false, true]) for (const autoNext of [false, true]) {
    const cleaned = [];
    const playing = mount({ local, settings: { auto_delete_watched: true },
      props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, apiOverrides: {
        cleanupWatchedEpisode: async (...args) => { cleaned.push(args); return { success: true, count: 1, freed: 20 }; },
      } });
    await playing.flush(); playing.metadata(); playing.media.currentTime = 100;
    if (!autoNext) { playing.button('连播').props.onClick(); await playing.flush(); }
    const savedBeforeEnd = playing.saves.length;
    playing.find(n => n.type === 'video').props.onEnded(); await playing.flush();
    assert.deepEqual(cleaned, [['A', 1]], 'online and local ended both invoke the unified cleanup');
    assert.ok(!playing.saves.slice(savedBeforeEnd).some(args => args[1] === 1 && args[2] === 0), 'cleanup must not erase the finished position');
    if (autoNext) {
      playing.metadata(); assert.equal(playing.media.paused, false, 'cleanup preserves auto-next');
      assert.ok(playing.find(n => n.type === 'video').props.src);
    } else assert.equal(playing.find(n => n.type === 'video').props.src, undefined);
    playing.unmount();
  }
  let finishRelease, cleanupCalls = 0;
  const releasing = mount({ settings: { auto_delete_watched: true, cache_next_episode: false },
    props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, apiOverrides: {
      releaseOnlinePlay: () => new Promise(resolve => { finishRelease = resolve; }),
      cleanupWatchedEpisode: async () => { cleanupCalls++; return { success: true, count: 0 }; },
    } });
  await releasing.flush(); releasing.metadata(); releasing.find(n => n.type === 'video').props.onEnded(); await releasing.flush();
  assert.equal(cleanupCalls, 0, 'cleanup waits for backend stream release');
  finishRelease(); await releasing.flush(); assert.equal(cleanupCalls, 1); releasing.unmount();
  const forgotten = [];
  let list = [{ series_id: 'A', series_title: '甲' }, { series_id: 'B', series_title: '乙' }];
  const library = mount({ props: { target: null }, apiOverrides: {
    getSeriesList: async () => list,
    getSeriesEpisodes: async series_id => ({ success: true, data: { series_id, series_title: series_id, episodes: [{ vid_index: 1, vid: series_id, status: 'missing' }] } }),
    forgetSeries: async sid => { forgotten.push(sid); list = list.filter(item => item.series_id !== sid); return { success: true }; },
    deleteSeriesFiles: () => { throw new Error('record removal must never delete files'); },
  } });
  await library.flush(); library.button('切换短剧').props.onClick(); await library.flush();
  library.find(n => n.props['aria-label'] === '永久移除 甲 的剧库记录').props.onClick({ stopPropagation() {} });
  await library.flush(); assert.deepEqual(forgotten, [], 'record removal requires the concrete confirmation');
  await library.button('永久移除').props.onClick(); await library.flush();
  assert.deepEqual(forgotten, ['A']); assert.equal(library.prepares.length, 0, 'removing a record must not play its replacement');
  assert.equal(library.button('恢复已移除'), undefined); library.unmount();
  console.log('PASS library waits for intent; explicit playback, management, cleanup and permanent record removal');
})().catch(error => { console.error(error); process.exitCode = 1; });
