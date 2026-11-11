const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const native = path.join(__dirname, '../src/native');
const id = '7300000000000000001';
function fixture({ missing = false, rejected = false, failed = false, video = {} } = {}) {
    const calls = [];
    const context = { Buffer, URL, URLSearchParams, AbortSignal, module: { exports: {} }, require(name) {
        if (name === './playback-device') return { takePlaybackDevice: async () => ({ device_id: '1234567890123456', iid: '6543210987654321' }), armPlaybackPool() {} };
        if (name === 'axios') return async config => {
            calls.push(config);
            assert.equal(config.method, 'POST');
            assert.ok(config.headers['x-medusa']);
            assert.equal(config.headers['x-argus'].length, 8);
            assert.equal(config.headers.Cookie, undefined);
            assert.equal(config.headers['X-Tt-Token'], undefined);
            if (failed) throw Object.assign(new Error('network'), { code: 'ECONNRESET' });
            return { status: 200, headers: {}, data: JSON.stringify({ code: rejected ? 1 : 0, data: { [missing ? '999' : id]: { video_data: { series_title: '尚未上線', series_cover: 'https://example.com/poster.jpg', video_list: [], ...video } } } }) };
        };
        return require(name.startsWith('.') ? path.join(native, name) : name);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(native, 'app-source.js'), 'utf8'), context);
    return { ...context.module.exports, calls };
}
(async () => {
    for (const flags of [{}, { online_time: Date.now() + 86400000 }, { status: 1, series_status: 1, audit_status: 1 }]) {
        const f = fixture({ video: flags }), data = await f.fetchAppSeriesMetadata(id);
        assert.equal(data.series_title, '尚未上線');
        assert.equal(data.cover, 'https://example.com/poster.jpg');
        assert.equal(data.total, 0);
        assert.equal(data.episodes.length, 0);
        assert.equal(f.calls.length, 1);
    }
    const f = fixture({ video: { video_list: [{ vid: '12', vid_index: 2 }, { vid: '11', vid_index: 1 }, { vid: '13', vid_index: 3, series_id: '999' }] } });
    assert.deepEqual(Array.from((await f.fetchAppSeriesMetadata(id)).episodes, item => item.vid), ['11', '12']);
    for (const options of [{ missing: true }, { rejected: true }, { failed: true }]) await assert.rejects(fixture(options).fetchAppSeriesMetadata(id));
    for (const input of ['', 'x', '../1', '1'.repeat(31)]) {
        const invalid = fixture();
        await assert.rejects(invalid.fetchAppSeriesMetadata(input));
        assert.equal(invalid.calls.length, 0);
    }
    console.log('PASS metadata without episodes, future-launch preservation, exact series matching, legacy detail headers, transient errors and invalid inputs');
})().catch(error => { console.error(error); process.exitCode = 1; });
