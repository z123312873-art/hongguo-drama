// In-memory Player handlers for sources the browser cannot seek (encrypted episodes streamed as fragmented MP4).
// The real Chromium behavior is covered by check-seek-chromium.cjs.
const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');

const video = { tagName: 'VIDEO', isContentEditable: false, closest: selector => selector.split(',').some(s => s.trim() === '.player-container') ? video : null };
const range = end => ({ length: end > 0 ? 1 : 0, start: () => 0, end: () => end });

function press(ui, key, extra = {}) {
  ui.document.activeElement = video;
  const init = { key, code: key, target: video, ...extra };
  const down = ui.dispatchKey('keydown', init);
  ui.dispatchKey('keyup', init);
  return down;
}

// A stream the browser cannot seek until the player swaps in the prepared complete file.
function streamFixture(overrides = {}) {
  const deferred = [];
  const prepare = p => {
    if (!p.seekable) return p.prefetch ? { success: false } : { success: true, url: 'hongguo-stream://live', streamId: 's-live', streaming: true };
    if (overrides.seekable) return overrides.seekable(p, deferred);
    return new Promise(resolve => deferred.push(value => resolve(value)));
  };
  return { prepare, deferred };
}

async function open(options = {}) {
  const fixture = streamFixture(options);
  const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, prepare: fixture.prepare, episodeCount: options.episodeCount || 2, saved: options.saved });
  await ui.flush();
  ui.media.seekable = range(0);
  ui.metadata(); ui.render();
  ui.media.currentTime = 10; ui.media.paused = false;
  return Object.assign(ui, fixture, { seekRequests: () => ui.prepares.filter(p => p.seekable) });
}

(async () => {
  let failures = 0;
  const test = async (name, fn) => {
    if (process.argv[2] && !name.includes(process.argv[2])) return;
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.stack}`); }
  };
  const finish = async (ui, index = 0, extra = {}) => {
    ui.deferred[index]({ success: true, url: 'hongguo-stream://file', streamId: 's-file', streaming: false, cached: true, ...extra });
    await ui.flush();
  };

  await test('seeking an unseekable stream swaps to the complete file and lands on the exact target', async () => {
    const ui = await open();
    const live = ui.media.src;
    assert.equal(press(ui, 'ArrowRight').defaultPrevented, true);
    assert.equal(ui.media.currentTime, 10, 'the live stream keeps playing untouched while the file is prepared');
    assert.equal(ui.media.src, live);
    assert.equal(ui.seekRequests().length, 1);
    assert.equal(ui.seekRequests()[0].seriesId, 'A'); assert.equal(ui.seekRequests()[0].vid, 'v1');
    await finish(ui);
    assert.equal(ui.media.src, 'hongguo-stream://file');
    assert.equal(ui.media.currentTime, 0, 'a new source starts at zero until its metadata arrives');
    ui.media.seekable = range(100); ui.metadata();
    assert.equal(ui.media.currentTime, 15, '+5 seconds, not a restart');
    assert.ok(ui.releases.some(r => r.streamId === 's-live'), 'the old stream is released after the swap');
    ui.unmount();
  });

  await test('rewind lands exactly five seconds back and later seeks are native', async () => {
    const ui = await open();
    press(ui, 'ArrowLeft'); await finish(ui);
    ui.media.seekable = range(100); ui.metadata();
    assert.equal(ui.media.currentTime, 5);
    press(ui, 'ArrowRight'); assert.equal(ui.media.currentTime, 10, 'seekable media uses the native seek');
    press(ui, 'ArrowRight'); assert.equal(ui.media.currentTime, 15);
    assert.equal(ui.seekRequests().length, 1, 'only one swap per episode');
    ui.unmount();
  });

  await test('held arrow keys accumulate into one swap', async () => {
    const ui = await open();
    press(ui, 'ArrowRight'); press(ui, 'ArrowRight', { repeat: true }); press(ui, 'ArrowRight', { repeat: true });
    press(ui, 'ArrowLeft');
    assert.equal(ui.seekRequests().length, 1);
    await finish(ui); ui.media.seekable = range(100); ui.metadata();
    assert.equal(ui.media.currentTime, 20, 'three forward and one back from 10');
    ui.unmount();
  });

  await test('rewinding past the start clamps to zero without losing playback', async () => {
    const ui = await open();
    ui.media.currentTime = 3; press(ui, 'ArrowLeft'); await finish(ui);
    ui.media.seekable = range(100); ui.metadata();
    assert.equal(ui.media.currentTime, 0);
    ui.unmount();
  });

  await test('forward past the real end clamps to the duration', async () => {
    const ui = await open();
    ui.media.currentTime = 98; ui.media.duration = NaN; press(ui, 'ArrowRight'); await finish(ui);
    ui.media.seekable = range(100); ui.media.duration = 100; ui.metadata();
    assert.equal(ui.media.currentTime, 100);
    ui.unmount();
  });

  await test('a paused player stays paused after the swap', async () => {
    const ui = await open();
    ui.media.paused = true; press(ui, 'ArrowRight'); const before = ui.mediaCalls.play;
    await finish(ui); ui.media.seekable = range(100); ui.metadata(); await ui.flush();
    assert.equal(ui.media.currentTime, 15); assert.equal(ui.media.paused, true); assert.equal(ui.mediaCalls.play, before);
    ui.unmount();
  });

  await test('a playing player resumes playing after the swap', async () => {
    const ui = await open();
    press(ui, 'ArrowRight'); const before = ui.mediaCalls.play;
    await finish(ui); ui.media.seekable = range(100); ui.metadata(); await ui.flush();
    assert.equal(ui.mediaCalls.play, before + 1); assert.equal(ui.media.paused, false);
    ui.unmount();
  });

  await test('failure keeps the live stream playing, reports it, and does not hammer the main process', async () => {
    const ui = await open();
    const live = ui.media.src;
    press(ui, 'ArrowRight'); await finish(ui, 0, { success: false, error: 'boom' });
    assert.equal(ui.media.src, live, 'a failed swap never restarts or replaces playback');
    assert.equal(ui.media.currentTime, 10);
    press(ui, 'ArrowRight'); await ui.flush();
    assert.equal(ui.seekRequests().length, 1, 'repeat presses during the cool-down do not re-request');
    assert.equal(ui.media.currentTime, 10, 'the browser seek that would restart playback is never attempted');
    ui.unmount();
  });

  await test('an episode too large for a complete file is not retried', async () => {
    const ui = await open();
    press(ui, 'ArrowRight'); await finish(ui, 0, { success: false, code: 'MEDIA_TOO_LARGE', error: '本集过大' });
    for (const timer of ui.timers.values()) timer.fn?.call?.(null);
    press(ui, 'ArrowRight'); press(ui, 'ArrowLeft');
    assert.equal(ui.seekRequests().length, 1);
    assert.equal(ui.media.currentTime, 10);
    ui.unmount();
  });

  await test('an answer that still streams is rejected instead of looping', async () => {
    const ui = await open();
    const live = ui.media.src;
    press(ui, 'ArrowRight'); await finish(ui, 0, { streaming: true, url: 'hongguo-stream://live2' });
    assert.equal(ui.media.src, live);
    assert.equal(ui.seekRequests().length, 1);
    ui.unmount();
  });

  await test('switching episode cancels the pending swap and ignores its late answer', async () => {
    const ui = await open();
    press(ui, 'ArrowRight');
    const request = ui.seekRequests()[0];
    ui.find(n => n.props?.['aria-label'] === '第 2 集').props.onClick(); await ui.flush();
    assert.ok(ui.releases.some(r => r.requestId === request.requestId), 'the in-flight prepare is released');
    const src = ui.media.src;
    await finish(ui);
    assert.equal(ui.media.src, src, 'the old episode answer must not replace the new episode');
    assert.ok(ui.releases.filter(r => r.requestId === request.requestId).length >= 1);
    assert.equal(ui.prepares.filter(p => p.vidIndex === 2 && !p.prefetch && !p.seekable).length, 1);
    ui.unmount();
  });

  await test('unmounting during a swap releases the request', async () => {
    const ui = await open();
    press(ui, 'ArrowRight'); const request = ui.seekRequests()[0];
    ui.unmount();
    assert.ok(ui.releases.some(r => r.requestId === request.requestId));
  });

  await test('already seekable online media keeps the native 5 second seek', async () => {
    const ui = await open();
    ui.media.seekable = range(100); ui.media.currentTime = 40;
    press(ui, 'ArrowRight'); assert.equal(ui.media.currentTime, 45);
    press(ui, 'ArrowLeft'); assert.equal(ui.media.currentTime, 40);
    assert.equal(ui.seekRequests().length, 0, 'no extra work for sources that already seek');
    ui.unmount();
  });

  await test('local files never ask the main process', async () => {
    const ui = mount({ local: true }); await ui.flush(); ui.media.seekable = range(100); ui.metadata(); ui.render();
    ui.media.currentTime = 40; press(ui, 'ArrowRight');
    assert.equal(ui.media.currentTime, 45); assert.equal(ui.prepares.length, 0);
    ui.unmount();
  });

  await test('the progress slider uses the same swap', async () => {
    const ui = await open();
    const controls = ui.find(n => typeof n.props?.onSeek === 'function');
    controls.props.onSeek(60);
    assert.equal(ui.seekRequests().length, 1);
    await finish(ui); ui.media.seekable = range(100); ui.metadata();
    assert.equal(ui.media.currentTime, 60);
    ui.unmount();
  });

  await test('a saved resume position on an unseekable stream swaps instead of restarting from zero', async () => {
    const ui = mount({ saved: { vid_index: 1, currentTime: 34 }, prepare: streamFixture().prepare });
    await ui.flush(); ui.media.seekable = range(0); ui.media.currentTime = 0;
    ui.metadata();
    assert.equal(ui.prepares.filter(p => p.seekable).length, 1);
    ui.unmount();
  });

  await test('returning to an earlier streamed episode in the same session lands on its remembered second', async () => {
    const ui = await open({ episodeCount: 3 });
    ui.media.currentTime = 33.3;
    ui.find(n => n.props?.['aria-label'] === '第 2 集').props.onClick(); await ui.flush();
    ui.media.seekable = range(0); ui.metadata(); ui.media.currentTime = 4;
    ui.find(n => n.props?.['aria-label'] === '第 1 集').props.onClick(); await ui.flush();
    ui.media.seekable = range(0); ui.metadata();
    const seeks = ui.seekRequests().filter(p => p.vid === 'v1');
    assert.equal(seeks.length, 1, 'the remembered position needs the seekable file');
    await finish(ui, ui.deferred.length - 1); ui.media.seekable = range(100); ui.metadata();
    assert.equal(ui.media.currentTime, 33.3);
    ui.unmount();
  });

  await test('a key pressed before metadata does not start a swap', async () => {
    const fixture = streamFixture();
    const ui = mount({ props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, prepare: fixture.prepare });
    await ui.flush();
    ui.media.currentTime = 0; press(ui, 'ArrowRight');
    assert.equal(ui.prepares.filter(p => p.seekable).length, 0);
    assert.equal(ui.media.currentTime, 0, 'a browser seek before metadata would restart the stream');
    ui.unmount();
  });

  process.exitCode = failures ? 1 : 0;
})();
