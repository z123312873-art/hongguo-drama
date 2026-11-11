
const assert = require('node:assert/strict');
const { mount } = require('./check-player-resume.cjs');

(async () => {
  let storageReads = 0;
  let cacheReads = 0;
  const ui = mount({
    episodeCount: 4,
    props: { target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
    apiOverrides: {
      getStorageUsage: async () => {
        storageReads++;
        return { success: true, series: [], totalFiles: 0, totalBytes: 0 };
      },
      onlineCacheStatus: async () => ({ success: true, count: ++cacheReads, bytes: cacheReads * 1024 }),
    },
  });
  try {
    await ui.flush();
    for (let episode = 1; episode <= 4; episode++) {
      ui.metadata();
      await ui.flush();
      assert.equal(ui.prepares.find(request => request.vidIndex === episode)?.vid, `v${episode}`);
      if (episode < 4) {
        ui.find(node => node.type === 'video').props.onEnded();
        await ui.flush();
      }
    }
    assert.ok(cacheReads >= 8, 'initial state, four plays and three prefetches must still refresh online cache');
    assert.equal(storageReads, 1, `four-episode playback scanned download storage ${storageReads} times; only initial management data needs a scan`);
    console.log(`PASS four-episode playback: ${cacheReads} online cache refreshes, ${storageReads} download storage scan`);
  } finally {
    ui.unmount();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
