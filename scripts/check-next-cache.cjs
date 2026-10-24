const assert = require('node:assert/strict');
const { mount: mountPlayer } = require('./check-player-resume.cjs');
const mount = options => mountPlayer({ ...options, props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 }, setEpisodesOpen() {} } });
const tick = (ui, time) => {
  ui.media.currentTime = time;
  ui.find(n => n.type === 'video').props.onTimeUpdate?.({ currentTarget: ui.media });
};
(async () => {
  let finish;
  const ui = mount({ prepare: p => p.prefetch ? new Promise(r => { finish = r; }) : { success: true, url: 'hongguo-stream://one' } });
  await ui.flush(); ui.metadata();
  assert.equal(ui.button('缓存下一集'), undefined, 'cache preference lives in Settings');
  assert.equal(ui.media.currentTime, 0);
  assert.equal(ui.prepares.length, 2, 'opening episode one must immediately prefetch episode two');
  tick(ui, 1); tick(ui, 2); await ui.flush();
  assert.equal(ui.prepares.length, 2, 'repeated playback events must not duplicate prefetch');
  assert.equal(ui.prepares[1].prefetch, true);
  ui.find(n => n.type === 'video').props.onEnded(); await ui.flush();
  assert.equal(ui.prepares.length, 2, 'auto-next adopts the running preparation');
  assert.ok(!ui.releases.some(r => r.requestId === ui.prepares[1].requestId));
  finish({ success: true, url: 'hongguo-stream://next', streamId: 'next' }); await ui.flush();
  assert.equal(ui.find(n => n.type === 'video').props.src, 'hongguo-stream://next'); ui.unmount();
  for (const options of [{ local: true }, { settings: { cache_next_episode: false } }, { lockedIndexes: [2] }]) {
    const disabled = mount(options); await disabled.flush(); disabled.metadata();
    tick(disabled, 90); await disabled.flush();
    assert.ok(!disabled.prepares.some(p => p.prefetch)); disabled.unmount();
  }
  const changedSettings = { cache_next_episode: true };
  const cancel = mount({ apiOverrides: { getSettings: async () => changedSettings }, prepare: p => p.prefetch ? new Promise(() => {}) : { success: true, url: 'hongguo-stream://one' } });
  await cancel.flush(); cancel.metadata(); tick(cancel, 90); await cancel.flush();
  cancel.props.active = false; await cancel.flush();
  changedSettings.cache_next_episode = false; cancel.props.active = true; await cancel.flush();
  assert.ok(cancel.releases.some(r => r.requestId === cancel.prepares[1].requestId)); cancel.unmount();
  const failed = mount({ prepare: p => p.prefetch ? { success: false, error: 'offline' } : { success: true, url: 'hongguo-stream://normal' } });
  await failed.flush(); failed.metadata(); tick(failed, 90); await failed.flush(); tick(failed, 91); await failed.flush();
  assert.equal(failed.prepares.length, 2, 'failed prefetch must not loop');
  failed.episode(2); await failed.flush();
  assert.equal(failed.prepares.length, 3, 'playback retries normally after prefetch failure'); failed.unmount();
  const chain = mount({ episodeCount: 3 });
  await chain.flush(); chain.metadata(); await chain.flush();
  assert.equal(chain.prepares.at(-1).vidIndex, 2);
  chain.episode(2); await chain.flush(); chain.metadata(); await chain.flush();
  assert.equal(chain.prepares.at(-1).vidIndex, 3);
  assert.equal(chain.prepares.at(-1).prefetch, true); chain.unmount();
  console.log('PASS next-cache: immediate trigger, reuse, skip, settings refresh, cancellation, failure fallback, next-episode chain');
})().catch(error => { console.error(error); process.exitCode = 1; });
