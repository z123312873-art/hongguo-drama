// SPDX-License-Identifier: GPL-3.0-only
// Golden checks: with a frozen clock and a seeded random source, the Hongguo (aid 8662) request
// signatures are byte-for-byte what they were before signing profiles were introduced.
// A second profile must change only its own identity fields and never leak into the default one.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');

const FROZEN_MS = 1790000000123;

function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function withFrozenWorld(run) {
    const originals = { now: Date.now, random: Math.random, randomBytes: crypto.randomBytes };
    const rand = seeded(20260101);
    Date.now = () => FROZEN_MS;
    Math.random = rand;
    crypto.randomBytes = (size) => Buffer.from(Array.from({ length: size }, () => Math.floor(rand() * 256)));
    const path = require.resolve('./app-source');
    const cached = require.cache[path];
    delete require.cache[path];
    try { return run(require('./app-source')); }
    finally {
        Date.now = originals.now; Math.random = originals.random; crypto.randomBytes = originals.randomBytes;
        if (cached) require.cache[path] = cached; else delete require.cache[path];
    }
}

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = { device_id: '4474387174276572', iid: '4474387173477868', cdid: '11111111-2222-3333-4444-555555555555' };

function hongguoSamples(app) {
    const search = app.signedSearchRequest({ keyword: '测试', page: 1, identity });
    const landpage = app.signedMetadataRequest('/reading/distribution/category/landpage/v/', { genre_type: '0' });
    const cell = app.signedMetadataRequest('/reading/bookapi/bookmall/cell/change/v', {}, { cell_id: '1' });
    return { search, landpage, cell };
}

const GOLDEN = {
    search: '0faf180400fda840a63ae3e03d36ebc7145b8dc9e2eee65ba8346c4895c9d184',
    landpage: 'ac8d40b17191e05cc47f1fe98ede0dd30d0a851bce46e224aeac36742f4046af',
    cell: '0a6e5a1871b0a5750bc5251794a53e73e9623ee747fe8078ed69e501874e6725',
};

test('default Hongguo signing output is unchanged', () => {
    const samples = withFrozenWorld(hongguoSamples);
    assert.equal(digest(samples.search), GOLDEN.search);
    assert.equal(digest(samples.landpage), GOLDEN.landpage);
    assert.equal(digest(samples.cell), GOLDEN.cell);
});

test('asking for the Hongguo profile explicitly equals the default', () => {
    const [implicit, explicit] = withFrozenWorld(app => [
        app.signedMetadataRequest('/reading/distribution/category/landpage/v/', { genre_type: '0' }),
        app.signedMetadataRequest('/reading/distribution/category/landpage/v/', { genre_type: '0' }, null, { profile: 'hongguo' }),
    ]);
    assert.equal(new URL(explicit.url).searchParams.get('aid'), '8662');
    assert.equal(explicit.headers['x-ss-dp'], '8662');
    assert.equal(new URL(implicit.url).searchParams.get('aid'), '8662');
});

test('the reader profile changes only its identity and requires a registered device', () => {
    const request = withFrozenWorld(app => app.signedMetadataRequest('/reading/reader/full/v/', { item_id: '7113845784809997000', key_register_ts: '0' }, null, { profile: 'reader', identity }));
    const query = new URL(request.url).searchParams;
    assert.equal(query.get('aid'), '1967');
    assert.equal(query.get('app_name'), 'novelapp');
    assert.equal(query.get('version_code'), '74332');
    assert.equal(query.get('device_id'), identity.device_id);
    assert.equal(query.get('iid'), identity.iid);
    assert.equal(query.get('cdid'), identity.cdid);
    assert.equal(query.get('item_id'), '7113845784809997000');
    assert.equal(request.headers['x-ss-dp'], '1967');
    for (const name of ['x-gorgon', 'x-medusa', 'x-helios', 'x-argus', 'x-ladon']) assert.ok(request.headers[name], name);
    withFrozenWorld(app => {
        assert.throws(() => app.signedMetadataRequest('/reading/reader/full/v/', {}, null, { profile: 'reader' }), /已注册/);
        assert.throws(() => app.signedMetadataRequest('/reading/reader/full/v/', {}, null, { profile: 'reader', identity: { device_id: '0', iid: '0' } }), /已注册/);
        assert.throws(() => app.signedMetadataRequest('/reading/reader/full/v/', {}), /不支持的 App 目录接口/, 'the default profile never reaches reader endpoints');
        assert.throws(() => app.signedMetadataRequest('/reading/crypt/registerkey', {}, {}, { profile: 'hongguo' }), /不支持/);
        assert.throws(() => app.signedMetadataRequest('/reading/reader/full/v/', {}, null, { profile: 'other', identity }), /身份配置/);
        assert.throws(() => app.signedMetadataRequest('/other/path', {}, null, { profile: 'reader', identity }), /不支持/);
    });
});

test('profiles do not share state: using the reader profile first does not change a later Hongguo request', () => {
    const samples = withFrozenWorld(app => {
        app.signedMetadataRequest('/reading/reader/full/v/', { item_id: '1' }, null, { profile: 'reader', identity });
        return null;
    });
    assert.equal(samples, null);
    const after = withFrozenWorld(hongguoSamples);
    assert.equal(digest(after.landpage), GOLDEN.landpage);
});


test('playback signing requires a registered identity without changing directory or reader signing', () => {
    withFrozenWorld(app => {
        const apiPath = '/reading/bookapi/video_tab/multi_video_model/v1/';
        assert.throws(() => app.signedMetadataRequest(apiPath), { code: 'DEVICE_REGISTRATION_FAILED' });
        assert.throws(() => app.signedMetadataRequest(apiPath, {}, null, { identity: { device_id: '0', iid: '1' } }), { code: 'DEVICE_REGISTRATION_FAILED' });
        const before = app.signedMetadataRequest('/reading/distribution/category/landpage/v/');
        const signed = app.signedMetadataRequest(apiPath, { video_id: '11' }, null, { identity });
        const query = new URL(signed.url).searchParams;
        for (const key of ['iid', 'device_id', 'cdid']) assert.equal(query.get(key), identity[key]);
        const after = app.signedMetadataRequest('/reading/distribution/category/landpage/v/');
        for (const key of ['iid', 'device_id', 'cdid']) assert.equal(new URL(after.url).searchParams.get(key), new URL(before.url).searchParams.get(key));
        assert.equal(query.get('version_code'), '73532');
    });
});
