const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nativeDir = path.join(__dirname, '../src/native');

// Published SM3 vectors plus a long input cross-checked with Node 22/OpenSSL.
const vectors = [
  ['abc', '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0'],
  ['abcd'.repeat(16), 'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732'],
  ['x'.repeat(10000), '335de0cbf893f7af9a3e548067c72f47630b9fa9293d93959c79c2085fab7e5e'],
];
const keyHex = '0123456789abcdef0123456789abcdef';
function encodedKey() {
  const plain = Buffer.from(`0${keyHex}`);
  const raw = Buffer.alloc(34);
  const previous = [246, 85];
  for (let i = 0; i < plain.length; i++) {
    const pop = i.toString(2).split('1').length - 1;
    raw[i + 1] = ((plain[i] + 21 + pop) & 255) ^ previous[i & 1];
    previous[i & 1] = raw[i + 1];
  }
  raw[0] = 48 ^ raw[1] ^ raw[2];
  return raw.toString('base64');
}
function fixture({ wrongVid = false, fallback = 'https://vod.snssdk.com/info', media = 'https://v3-reading.qznovelvod.com/video.mp4', redirect = '', malformedKey = false, videoList = null, encrypted = true } = {}) {
  const calls = [];
  const signedDeviceIds = [];
  const seed = Buffer.alloc(16, 7);
  const constants = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
  const material = crypto.createHash('sha512').update(Buffer.concat([crypto.createHash('sha512').update(seed).digest(), constants])).digest();
  const cipher = crypto.createCipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  const encryptedUrl = Buffer.concat([Buffer.from([0xa8, 0, 1, 0]), cipher.update(media), cipher.final()]).toString('base64');
  const axios = async config => {
    calls.push(config);
    assert.equal(config.maxRedirects, 0);
    assert.ok(config.timeout > 0 && config.timeout <= 12000);
    assert.ok(config.signal);
    if (String(config.url).includes('device_register')) {
      return { status: 200, headers: {}, data: JSON.stringify({ code: 1 }) };
    }
    if (config.method === 'POST') {
      assert.ok(config.headers['x-medusa']);
      assert.ok(config.headers['x-gorgon']);
      const model = { video_model: JSON.stringify({ fallback_api: fallback }) };
      return { status: 200, headers: {}, data: JSON.stringify({ code: 0, data: { '999': model, ...(wrongVid ? {} : { '11': model }) } }) };
    }
    if (redirect) return { status: 302, headers: { location: redirect }, data: '' };
    return { status: 200, headers: {}, data: JSON.stringify({ video_info: { data: { key_seed: encrypted ? seed.toString('base64') : null, video_list: videoList || {
      bad: { main_url: media, codec_type: 'bytevc2', quality_desc: '2160P', spade_a: encodedKey() },
      good: { main_url: encryptedUrl, codec_type: 'h264', quality_desc: '720P', spade_a: malformedKey ? 'bad' : encodedKey() },
    } } } }) };
  };
  const context = { Buffer, URL, URLSearchParams, AbortSignal, signedDeviceIds, module: { exports: {} },
    require: name => {
      if (name === 'axios') return axios;
      if (name === './sm3') return require(path.join(nativeDir, 'sm3'));
      if (name === './playback-device') return require(path.join(nativeDir, 'playback-device'));
      if (name === './download-quality') return require(path.join(nativeDir, 'download-quality'));
      if (name === './direct-connect') return require(path.join(nativeDir, 'direct-connect'));
      if (name === './codec-rank') return require(path.join(nativeDir, 'codec-rank'));
      if (name === './playback-policy') return require(path.join(nativeDir, 'playback-policy'));
      if (name === './cert-hint') return require(path.join(nativeDir, 'cert-hint'));
      if (name === 'node:crypto') return { ...crypto, createHash(name, ...args) {
        assert.notEqual(name.toLowerCase(), 'sm3', 'must not depend on OpenSSL SM3');
        return crypto.createHash(name, ...args);
      } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(nativeDir, 'app-source.js'), 'utf8') + `
    const originalDeviceProto = deviceProto;
    deviceProto = function (deviceId) {
      signedDeviceIds.push(deviceId);
      return originalDeviceProto(deviceId);
    };
  `, context);
  return { fetch: context.module.exports.fetchAppPlayUrl, calls, signedDeviceIds };
}
function loadApp(axios, { videoTab = false } = {}) {
  const context = { Buffer, URL, AbortSignal, module: { exports: {} },
    require: name => {
      if (name === 'axios') return config => !videoTab && String(config.url).includes('/reading/bookapi/video_tab/')
        ? Promise.resolve({ status: 200, headers: {}, data: JSON.stringify({ code: 1 }) }) : axios(config);
      if (name === './sm3') return require(path.join(nativeDir, 'sm3'));
      if (name === './playback-device') return require(path.join(nativeDir, 'playback-device'));
      if (name === './download-quality') return require(path.join(nativeDir, 'download-quality'));
      if (name === './direct-connect') return require(path.join(nativeDir, 'direct-connect'));
      if (name === './codec-rank') return require(path.join(nativeDir, 'codec-rank'));
      if (name === './playback-policy') return require(path.join(nativeDir, 'playback-policy'));
      if (name === './cert-hint') return require(path.join(nativeDir, 'cert-hint'));
      if (name === 'node:crypto') return crypto;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(nativeDir, 'app-source.js'), 'utf8'), context);
  return context.module.exports;
}
function loadFetch(axios) {
  const app = loadApp(axios);
  const fetch = app.fetchAppPlayUrl;
  fetch.ready = app.setBytevc2Ready;
  return fetch;
}

function nativeFixture() {
  const pending = [];
  const context = { module: { exports: {} }, Buffer, URL, process: { env: {} },
    require: name => name === 'axios' ? { get: () => new Promise(resolve => pending.push(resolve)) } : require(name.startsWith('.') ? path.join(nativeDir, name) : name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(nativeDir, 'hongguo.js'), 'utf8') + '\nmodule.exports.parseModelVideo = parseModelVideo;', context);
  return { ...context.module.exports, pending,
    finish(index, name) { pending[index]({ data: `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: {
      'player_(series_id)/(vid)/page': { vid: '11', series_id: '1', seriesDetail: { series_id: '1' }, publicVideoSeo: { available: true, itemId: '11', seriesId: '1' } },
    } })}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'VideoObject', url: 'https://hongguoduanju.com/player/1/11', contentUrl: `https://media.example/${name}.mp4` })}</script>` }); },
  };
}
const mediaUrl = name => `https://v3-reading.qznovelvod.com/${name}.mp4`;
const appRows = videoList => fixture({ videoList, encrypted: false }).fetch('11');
const turn = () => new Promise(resolve => setImmediate(resolve));

const checks = [
  ['registered video-tab GETs carry the exact per-lookup anonymous identity and never account credentials', async () => {
    const device = require(path.join(nativeDir, 'playback-device'));
    device.resetPlaybackDevice();
    let registered = 0;
    const ids = [];
    const media = mediaUrl('registered');
    try {
      const app = loadApp(async config => {
        if (String(config.url).includes('device_register')) {
          registered += 1;
          return { status: 200, headers: {}, data: JSON.stringify({ device_id_str: String(1000000000000000 + registered), install_id_str: String(2000000000000000 + registered), code: 0 }) };
        }
        const query = new URL(config.url).searchParams;
        assert.ok(String(config.url).includes('/reading/bookapi/video_tab/'));
        assert.equal(config.method, 'GET');
        const id = query.get('device_id');
        assert.ok(/^100000000000000[123]$/.test(id));
        assert.equal(query.get('iid'), id.replace(/^1/, '2'));
        assert.equal(query.get('video_id'), '11');
        assert.equal(query.get('version_code'), '73532');
        assert.equal(config.headers['Cookie'], undefined);
        assert.equal(config.headers['X-Tt-Token'], undefined);
        assert.equal(query.get('user_id'), null);
        for (const name of ['x-gorgon', 'x-medusa', 'x-helios']) assert.ok(config.headers[name]);
        ids.push(id);
        return { status: 200, headers: {}, data: JSON.stringify({ code: 0, data: { video_model_data: { '11': { video_model: JSON.stringify({ video_list: [{ main_url: media, codec_type: 'h264', vwidth: 1080, vheight: 1920 }] }) } } } }) };
      }, { videoTab: true });
      await app.fetchAppPlayUrl('11', { quality: '1080p' });
      const results = await Promise.all([app.fetchAppPlayUrl('11'), app.fetchAppPlayUrl('11')]);
      assert.ok(results.every(result => result.url === media));
      assert.equal(new Set(ids).size, 3);
      assert.equal(registered, 3);
    } finally {
      device.resetPlaybackDevice();
      await device.getPlaybackDevice(async () => ({ code: 1 })).catch(() => {});
    }
  }],

  ['sequential and concurrent lookups isolate request identities and signed device fields', async () => {
    const f = fixture();
    await f.fetch('11');
    await f.fetch('11');
    await Promise.all([f.fetch('11'), f.fetch('11'), f.fetch('11')]);
    const requests = f.calls.filter(call => call.method === 'POST' && String(call.url).includes('multi_video_model'));
    assert.equal(requests.length, 5, 'one model request per lookup; no retry loop');
    assert.equal(f.calls.filter(call => String(call.url).includes('device_register')).length, 1, 'anonymous playback registration is attempted once');
    for (const field of ['iid', 'device_id']) {
      const ids = requests.map(call => new URL(call.url).searchParams.get(field));
      assert.ok(ids.every(id => /^\d{16}$/.test(id)), `${field} must stay a valid synthetic identifier`);
      assert.equal(new Set(ids).size, requests.length, `${field} must not be reused across lookups`);
      if (field === 'device_id') assert.deepEqual(f.signedDeviceIds.filter(id => ids.includes(id)), ids, 'playback URL and signed device fields must match');
    }
    assert.equal(f.calls.length, 11, 'unregistered lookups never send catalog requests with synthetic identities');
  }],
  ['App H264 takes priority over higher-resolution HEVC', async () => {
    const result = await appRows({ hd: { main_url: mediaUrl('hevc'), codec_type: 'hevc', quality_desc: '1080P' },
      sd: { main_url: mediaUrl('avc'), codec_type: 'h264', quality_desc: '720P' } });
    assert.equal(result.url, mediaUrl('avc'));
  }],
  ['App invalid or missing main URL keeps validated same-stream backup', async () => {
    for (const main_url of ['', 'https://127.0.0.1/private', 'https://v3-reading.qznovelvod.com.attacker.test/video', 'http://v3-reading.qznovelvod.com/video']) {
      const result = await appRows({ one: { main_url, backup_url: mediaUrl('backup'), codec_type: 'h264' } });
      assert.equal(result.url, mediaUrl('backup'));
    }
  }],
  ['App skips unusable candidate but never ignores an invalid encryption key', async () => {
    const result = await appRows({ broken: { main_url: mediaUrl('broken'), codec_type: 'h264', quality_desc: '1080P', spade_a: 'bad' },
      working: { main_url: mediaUrl('working'), codec_type: 'h264', quality_desc: '720P', spade_a: encodedKey() } });
    assert.equal(result.url, mediaUrl('working'));
    assert.equal(result.contentKey, keyHex);
    await assert.rejects(appRows({ one: { main_url: 'https://127.0.0.1/private', backup_url: 'file:///private', codec_type: 'h264' } }));
  }],
  ['legacy parser prefers H264 and keeps a usable backup', async () => {
    const { parseModelVideo } = nativeFixture();
    const choose = rows => parseModelVideo(JSON.stringify({ video_list: rows }));
    assert.equal(choose([{ main_url: mediaUrl('hevc'), video_meta: { codec_type: 'h265', definition: '1080p' } },
      { main_url: mediaUrl('avc'), video_meta: { codec_type: 'H264', definition: '720p' } }])[0], mediaUrl('avc'));
    assert.equal(choose([{ main_url: mediaUrl('hevc'), video_meta: { codec_type: 'hevc', definition: '1080p' } },
      { main_url: mediaUrl('avc1'), video_meta: { codec_type: 'avc1.64001f', definition: '720p' } }])[0], mediaUrl('avc1'));
    assert.equal(choose([{ main_url: mediaUrl('family'), video_meta: { codec_type: 'h265_hvc1', definition: '720p' } },
      { main_url: mediaUrl('vvc'), video_meta: { codec_type: 'bytevc2', definition: '1080p' } }])[0], mediaUrl('family'));
    assert.equal(choose([{ main_url: mediaUrl('plain'), video_meta: { definition: '720p' } }])[0], mediaUrl('plain'));
    assert.equal(choose([{ main_url: 'not a URL', backup_url: mediaUrl('backup'), video_meta: { codec_type: 'h264' } }])[0], mediaUrl('backup'));
    assert.equal(choose([{ main_url: 'file:///private', backup_url: 'https://user:pass@example.com/video' }])[0], null);
  }],
  ['legacy parser uses actual dimensions before quality labels', async () => {
    const { parseModelVideo } = nativeFixture();
    const result = parseModelVideo(JSON.stringify({ video_list: [
      { main_url: mediaUrl('low'), video_meta: { codec_type: 'h264', definition: '1080p', vwidth: 360, vheight: 640 } },
      { main_url: mediaUrl('high'), video_meta: { codec_type: 'h264', definition: '720p', vwidth: 1920, vheight: 1080 } },
    ] }));
    assert.equal(result[0], mediaUrl('high'));
  }],
  ['forced lookup bypasses settled play URL cache', async () => {
    const f = nativeFixture();
    const first = f.fetchPlayUrlSingle('11', '1'); await turn(); f.finish(0, 'old'); await first;
    const forced = f.fetchPlayUrlSingle('11', '1', { force: true }); await turn();
    assert.equal(f.pending.length, 2, 'force must fetch a new address');
    f.finish(1, 'new'); await forced;
    assert.equal((await f.fetchPlayUrlSingle('11', '1')).url, 'https://media.example/new.mp4');
  }],
  ['old in-flight lookup cannot overwrite forced cache or remove forced pending', async () => {
    for (const oldFinishesFirst of [true, false]) {
      const f = nativeFixture();
      const old = f.fetchPlayUrlSingle('11', '1'); await turn();
      const forced = f.fetchPlayUrlSingle('11', '1', { force: true }); await turn();
      assert.equal(f.pending.length, 2, 'force must bypass old in-flight request');
      if (oldFinishesFirst) {
        f.finish(0, 'old'); await old;
        const joined = f.fetchPlayUrlSingle('11', '1'); await turn();
        assert.equal(f.pending.length, 2, 'old completion must preserve forced request');
        f.finish(1, 'new'); await forced;
        assert.equal((await joined).url, 'https://media.example/new.mp4');
      } else {
        f.finish(1, 'new'); await forced;
        f.finish(0, 'old'); await old;
      }
      assert.equal((await f.fetchPlayUrlSingle('11', '1')).url, 'https://media.example/new.mp4');
    }
  }],
  ['pure JS SM3 vectors', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'sm3.js')), 'pure JS SM3 missing');
    const sm3 = require(path.join(nativeDir, 'sm3'));
    for (const [input, expected] of vectors) {
      assert.equal(sm3(input).toString('hex'), expected);
      if (crypto.getHashes().includes('sm3')) assert.equal(sm3(input).toString('hex'), crypto.createHash('sm3').update(input).digest('hex'));
    }
  }],
  ['signed exact-episode model, fallback and compatible media', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
    const { fetch, calls } = fixture();
    const result = await fetch('11');
    assert.equal(result.source, 'app');
    assert.equal(result.contentKey, keyHex);
    assert.equal(result.codec, 'h264');
    assert.equal(result.quality, '720P');
    assert.equal(calls.length, 2);
  }],
  ['no wrong-episode fallback', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
    const { fetch, calls } = fixture({ wrongVid: true });
    await assert.rejects(fetch('11'));
    assert.equal(calls.length, 1);
  }],
  ['URL boundary and redirect validation', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
    for (const fallback of ['http://vod.snssdk.com/info', 'https://127.0.0.1/info', 'https://vod.snssdk.com.attacker.test/info', 'https://user:pass@vod.snssdk.com/info']) {
      const { fetch, calls } = fixture({ fallback });
      await assert.rejects(fetch('11'));
      assert.equal(calls.length, 1);
    }
    const { fetch, calls } = fixture({ redirect: 'https://127.0.0.1/private' });
    await assert.rejects(fetch('11'));
    assert.equal(calls.length, 2);
    await assert.rejects(fixture({ media: 'https://127.0.0.1/video' }).fetch('11'));
  }],
  ['an empty answer from an unregistered device takes a fresh device and then plays, a second empty answer stops', async () => {
    const device = require(path.join(nativeDir, 'playback-device'));
    const media = 'https://v3-reading.qznovelvod.com/video.mp4';
    const model = { code: 0, data: { '11': { video_model: JSON.stringify({ video_list: [
      { main_url: media, codec_type: 'h264', quality_desc: '720P', vwidth: 720, vheight: 1280 },
    ] }) } } };
    const run = async (secondRegister) => {
      device.resetPlaybackDevice();
      const calls = [];
      const fetch = loadFetch(async config => {
        calls.push(config);
        assert.equal(config.maxRedirects, 0);
        assert.ok(config.signal);
        if (String(config.url).includes('device_register')) {
          const count = calls.filter(call => String(call.url).includes('device_register')).length;
          if (count === 1 || secondRegister === 'fail') return { status: 200, headers: {}, data: JSON.stringify({ code: 1 }) };
          return { status: 200, headers: {}, data: JSON.stringify({ device_id_str: '1234567890123456', install_id_str: '6543210987654321', code: 0 }) };
        }
        if (config.method === 'POST') {
          const count = calls.filter(call => call.method === 'POST' && !String(call.url).includes('device_register')).length;
          assert.ok(config.headers['x-gorgon'], 'a registered device is signed first');
          if (count === 1) return { status: 200, headers: {}, data: '' };
          assert.equal(new URL(config.url).searchParams.get('device_id'), '1234567890123456');
          return { status: 200, headers: {}, data: JSON.stringify(model) };
        }
        throw new Error('unexpected request');
      });
      return { fetch, calls };
    };
    try {
      const healed = await run('ok');
      const result = await healed.fetch('11', { quality: '1080p' });
      assert.equal(result.url, media);
      assert.equal(result.codec, 'h264');
      assert.equal(healed.calls.filter(call => String(call.url).includes('device_register')).length, 2);
      assert.equal(healed.calls.filter(call => call.method === 'POST' && !String(call.url).includes('device_register')).length, 2);
      const stopped = await run('fail');
      await assert.rejects(stopped.fetch('11'), error => error.code === 'EMPTY_RESPONSE');
      assert.equal(stopped.calls.filter(call => String(call.url).includes('device_register')).length, 2);
      assert.equal(stopped.calls.filter(call => call.method === 'POST' && !String(call.url).includes('device_register')).length, 1);
    } finally {
      device.resetPlaybackDevice();
      await device.getPlaybackDevice(async () => ({ code: 1 })).catch(() => {});
    }
  }],
  ['blocked or re-signed registration is remembered as a reason and a later playback registers again', async () => {
    const device = require(path.join(nativeDir, 'playback-device'));
    const media = 'https://v3-reading.qznovelvod.com/video.mp4';
    const model = { code: 0, data: { '11': { video_model: JSON.stringify({ video_list: [
      { main_url: media, codec_type: 'h264', quality_desc: '720P', vwidth: 720, vheight: 1280 },
    ] }) } } };
    try {
      for (const [failure, reason] of [['SELF_SIGNED_CERT_IN_CHAIN', 'TLS'], ['ECONNRESET', 'NETWORK']]) {
        device.resetPlaybackDevice();
        const fetch = loadFetch(async config => {
          if (String(config.url).includes('device_register')) throw Object.assign(new Error('blocked'), { code: failure });
          return { status: 200, headers: {}, data: '' };
        });
        await assert.rejects(fetch('11'), error => error.code === 'EMPTY_RESPONSE' && error.registrationReason === reason);
      }
      device.resetPlaybackDevice();
      const blocked = loadFetch(async config => {
        if (String(config.url).includes('device_register')) throw Object.assign(new Error('blocked'), { code: 'ECONNRESET' });
        return { status: 200, headers: {}, data: '' };
      });
      await assert.rejects(blocked('11'));
      device.forgetFailedPlaybackDevice();
      const healed = loadFetch(async config => {
        if (String(config.url).includes('device_register')) {
          return { status: 200, headers: {}, data: JSON.stringify({ device_id_str: '1234567890123456', install_id_str: '6543210987654321', code: 0 }) };
        }
        return { status: 200, headers: {}, data: JSON.stringify(model) };
      });
      assert.equal((await healed('11', { quality: '1080p' })).url, media);
    } finally {
      device.resetPlaybackDevice();
      await device.getPlaybackDevice(async () => ({ code: 1 })).catch(() => {});
    }
  }],
  ['an empty signed answer falls back to the unsigned style on the same device and does not register again', async () => {
    const device = require(path.join(nativeDir, 'playback-device'));
    device.resetPlaybackDevice();
    const media = 'https://v3-reading.qznovelvod.com/video.mp4';
    const model = { code: 0, data: { '11': { video_model: JSON.stringify({ video_list: [
      { main_url: media, codec_type: 'h264', quality_desc: '1080P', vwidth: 1080, vheight: 1920 },
    ] }) } } };
    const calls = [];
    try {
      const fetch = loadFetch(async config => {
        calls.push(config);
        if (String(config.url).includes('device_register')) {
          return { status: 200, headers: {}, data: JSON.stringify({ device_id_str: '1234567890123456', install_id_str: '6543210987654321', code: 0 }) };
        }
        const videos = calls.filter(call => call.method === 'POST' && !String(call.url).includes('device_register'));
        if (videos.length === 1) {
          assert.ok(config.headers['x-gorgon'], 'the signed style goes first');
          return { status: 200, headers: {}, data: '' };
        }
        assert.equal(config.headers['x-gorgon'], undefined);
        assert.equal(new URL(config.url).searchParams.get('device_id'), '1234567890123456');
        assert.equal(new URL(config.url).searchParams.get('iid'), '6543210987654321');
        return { status: 200, headers: {}, data: JSON.stringify(model) };
      });
      const result = await fetch('11', { quality: '1080p' });
      assert.equal(result.url, media);
      assert.equal(result.quality, '1080p');
      assert.equal(calls.filter(call => String(call.url).includes('device_register')).length, 1);
      assert.equal(calls.filter(call => call.method === 'POST' && !String(call.url).includes('device_register')).length, 2);
    } finally {
      device.resetPlaybackDevice();
      await device.getPlaybackDevice(async () => ({ code: 1 })).catch(() => {});
    }
  }],
  ['every lookup takes a device of its own and the host that answered is asked first next time', async () => {
    const device = require(path.join(nativeDir, 'playback-device'));
    device.resetPlaybackDevice();
    const media = 'https://v3-reading.qznovelvod.com/video.mp4';
    const model = { code: 0, data: { '11': { video_model: JSON.stringify({ video_list: [
      { main_url: media, codec_type: 'h264', quality_desc: '720P', vwidth: 720, vheight: 1280 },
    ] }) } } };
    const calls = [];
    const used = new Map();
    let registered = 0;
    try {
      const fetch = loadFetch(async config => {
        calls.push(config);
        if (String(config.url).includes('device_register')) {
          registered += 1;
          return { status: 200, headers: {}, data: JSON.stringify({ device_id_str: String(1000000000000000 + registered), install_id_str: String(2000000000000000 + registered), code: 0 }) };
        }
        if (String(config.url).includes('/reading/bookapi/video_tab/')) {
          return { status: 200, headers: {}, data: JSON.stringify({ code: 1 }) };
        }
        const url = new URL(config.url);
        const id = url.searchParams.get('device_id');
        used.set(id, (used.get(id) || 0) + 1);
        // The service answers a device once, and the first edge host answers nobody.
        if (used.get(id) > 1 || url.hostname.startsWith('api5-normal-sinfonlineb')) return { status: 200, headers: {}, data: '' };
        return { status: 200, headers: {}, data: JSON.stringify(model) };
      });
      const first = await fetch('11', { quality: '1080p' });
      assert.equal(first.url, media);
      const hostOf = call => new URL(call.url).hostname;
      const videoCalls = () => calls.filter(call => call.method === 'POST' && !String(call.url).includes('device_register'));
      assert.equal(hostOf(videoCalls()[0]), 'api5-normal-sinfonlineb.fqnovel.com');
      assert.notEqual(hostOf(videoCalls().at(-1)), 'api5-normal-sinfonlineb.fqnovel.com', 'a refused device moves on to another edge host');
      const before = videoCalls().length;
      const second = await fetch('11', { quality: '1080p' });
      assert.equal(second.url, media);
      assert.equal(hostOf(videoCalls()[before]), hostOf(videoCalls()[before - 1]), 'the answering host is tried first');
      assert.equal(videoCalls().length - before, 1, 'a fresh device answers at once');
      assert.ok([...used.values()].every(count => count <= 2), 'no device is asked again after it was refused');
    } finally {
      device.resetPlaybackDevice();
      await device.getPlaybackDevice(async () => ({ code: 1 })).catch(() => {});
    }
  }],
  ['codec families accept parameter suffixes and keep unrelated families out', async () => {
    const { codecRank, playbackCodec } = require(path.join(nativeDir, 'codec-rank'));
    for (const name of ['h264', 'avc', 'avc1', 'AVC1.64001F', 'avc1.4d401f']) assert.equal(codecRank(name), 0, name);
    for (const name of ['hevc', 'h265', 'h265_hvc1', 'hvc1', 'hev1', 'bytevc1', 'hvc1.1.6.L93.B0', 'hev1.1.6.L120.90']) assert.equal(codecRank(name), 1, name);
    for (const name of ['', 'bytevc2', 'h266', 'vvc', 'av1', 'av01.0.05M.08', 'avc2']) assert.equal(codecRank(name), 2, name);
    assert.equal(playbackCodec('avc1.64001f'), 'h264');
    assert.equal(playbackCodec('h265_hvc1'), 'hevc');
    assert.equal(playbackCodec('bytevc1'), 'hevc');
    assert.equal(playbackCodec('bytevc2'), 'bytevc2');
  }],
  ['a model without a compatible codec tries one fresh device on the next host, then stops', async () => {
    const device = require(path.join(nativeDir, 'playback-device'));
    device.resetPlaybackDevice();
    const playable = mediaUrl('play');
    const model = (codec, name, size) => ({ code: 0, data: { '11': { video_model: JSON.stringify({ video_list: [
      { main_url: mediaUrl(name), codec_type: codec, quality_desc: size === 1080 ? '1080P' : '720P', vwidth: size || 0, vheight: size ? size * 16 / 9 : 0 },
    ] }) } } });
    const hostsOf = calls => calls.filter(call => call.method === 'POST' && !String(call.url).includes('device_register')).map(call => new URL(call.url).hostname);
    const run = async (answers) => {
      const calls = [];
      let registered = 0;
      const fetch = loadFetch(async config => {
        calls.push(config);
        if (String(config.url).includes('device_register')) {
          registered += 1;
          return { status: 200, headers: {}, data: JSON.stringify({ device_id_str: String(5000000000000000 + registered), install_id_str: String(6000000000000000 + registered), code: 0 }) };
        }
        const host = new URL(config.url).hostname;
        const answer = answers[host] || answers.default;
        return { status: 200, headers: {}, data: typeof answer === 'string' ? answer : JSON.stringify(answer) };
      });
      return { fetch, calls, hostsOf: () => hostsOf(calls), registered: () => registered, ready: fetch.ready };
    };
    try {
      const moved = await run({
        'api5-normal-sinfonlineb.fqnovel.com': model('bytevc2', 'vvc', 1080),
        default: model('h265_hvc1', 'play', 720),
      });
      const movedResult = await moved.fetch('11');
      assert.equal(movedResult.url, playable);
      assert.equal(movedResult.codec, 'hevc');
      assert.equal(moved.registered(), 2);
      assert.deepEqual(moved.hostsOf(), ['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-lf.fqnovel.com']);
      const family = await run({ default: model('avc1.64001f', 'avc', 720) });
      const familyResult = await family.fetch('11');
      assert.equal(familyResult.url, mediaUrl('avc'));
      assert.equal(familyResult.codec, 'h264');
      assert.equal(family.registered(), 1, 'a compatible family does not spend a second device');
      assert.equal(family.hostsOf().length, 1);
      const stopped = await run({ default: model('bytevc2', 'vvc', 1080) });
      await assert.rejects(stopped.fetch('11'), error => error.code === 'NO_COMPATIBLE_CODEC' && /转码组件未就绪/.test(error.message) && !/尺寸/.test(error.message));
      assert.equal(stopped.registered(), 2);
      assert.deepEqual(stopped.hostsOf(), ['api5-normal-sinfonlineb.fqnovel.com', 'api5-normal-lf.fqnovel.com']);
      const explicit = await run({ default: model('bytevc2', 'vvc', 1080) });
      await assert.rejects(explicit.fetch('11', { quality: '1080p' }), error => error.code === 'NO_COMPATIBLE_CODEC' && /转码组件未就绪/.test(error.message) && !/尺寸/.test(error.message));
      assert.equal(explicit.registered(), 2);
      const missing = await run({ default: { code: 0, data: {} } });
      await assert.rejects(missing.fetch('11'), error => error.code === 'MISSING_MODEL');
      assert.equal(missing.registered(), 1, 'a missing episode does not take another device');
      assert.equal(missing.hostsOf().length, 1);
      const sized = await run({ default: model('h264', 'sd', 720) });
      const sizedResult = await sized.fetch('11', { quality: '1080p' });
      assert.equal(sizedResult.url, mediaUrl('sd'));
      assert.equal(sizedResult.qualityLimited, true);
      assert.match(sizedResult.notice, /720P/);
      assert.equal(sized.registered(), 1, 'a measured lower stream stays on the first device');
      const upgraded = await run({
        'api5-normal-sinfonlineb.fqnovel.com': model('h264', 'unsized', 0),
        default: model('h264', 'hd', 1080),
      });
      const upgradedResult = await upgraded.fetch('11', { quality: '1080p' });
      assert.equal(upgradedResult.url, mediaUrl('hd'));
      assert.equal(upgradedResult.quality, '1080p');
      assert.equal(upgraded.registered(), 2);
      const undowngraded = await run({ default: model('h264', 'unsized', 0) });
      await assert.rejects(undowngraded.fetch('11', { quality: '1080p' }), error => error.code === 'NO_COMPATIBLE_CODEC' && /未降级/.test(error.message));
      assert.equal(undowngraded.registered(), 2);
      assert.equal(undowngraded.hostsOf().length, 2, 'a second host without a measured size stops the lookup');
      device.resetPlaybackDevice();
      const ladder = (rows) => ({ code: 0, data: { '11': { video_model: JSON.stringify({ video_list: rows }) } } });
      const stream = (name, codec, width, height) => ({ main_url: mediaUrl(name), codec_type: codec, vwidth: width, vheight: height });
      const newerLadder = await run({ default: ladder([
        stream('360', 'bytevc2', 360, 640),
        stream('720', 'bytevc2', 1280, 720),
        stream('1080', 'bytevc2', 1920, 1080),
        stream('1440', 'bytevc2', 2560, 1440),
      ]) });
      newerLadder.ready(true);
      const chosen = await newerLadder.fetch('11', { quality: '1080p' });
      assert.equal(chosen.url, mediaUrl('1080'));
      assert.equal(chosen.codec, 'bytevc2');
      assert.equal(chosen.transcode, 'bytevc2');
      assert.equal(chosen.quality, '1080p');
      assert.equal(chosen.qualityLimited, undefined);
      assert.equal(newerLadder.registered(), 1, 'a transcodable 1080 stream does not take a second device');
      const narrower = await newerLadder.fetch('11', { quality: '720p' });
      assert.equal(narrower.url, mediaUrl('720'));
      assert.equal(narrower.transcode, 'bytevc2');
      assert.equal(narrower.quality, '720p');
      const automatic = await run({ default: ladder([
        stream('720', 'bytevc2', 1280, 720),
        stream('1080', 'bytevc2', 1920, 1080),
      ]) });
      automatic.ready(true);
      const highest = await automatic.fetch('11');
      assert.equal(highest.url, mediaUrl('1080'));
      assert.equal(highest.transcode, 'bytevc2');
      assert.equal(automatic.registered(), 1);
      const mixed = await run({ default: ladder([
        stream('hevc720', 'hvc1', 1280, 720),
        stream('vvc1080', 'bytevc2', 1920, 1080),
      ]) });
      mixed.ready(true);
      const requested = await mixed.fetch('11', { quality: '1080p' });
      assert.equal(requested.url, mediaUrl('vvc1080'));
      assert.equal(requested.transcode, 'bytevc2');
      assert.equal(requested.quality, '1080p');
      const copied = await run({ default: ladder([
        stream('hevc720', 'hvc1', 1280, 720),
        stream('vvc1080', 'bytevc2', 1920, 1080),
      ]) });
      copied.ready(true);
      const autoCopy = await copied.fetch('11');
      assert.equal(autoCopy.url, mediaUrl('hevc720'));
      assert.equal(autoCopy.codec, 'hevc');
      assert.equal(autoCopy.transcode, undefined);
      const both = await run({ default: ladder([
        stream('hevc1080', 'hvc1', 1920, 1080),
        stream('vvc1080', 'bytevc2', 1920, 1080),
      ]) });
      both.ready(true);
      const kept = await both.fetch('11', { quality: '1080p' });
      assert.equal(kept.url, mediaUrl('hevc1080'));
      assert.equal(kept.codec, 'hevc');
      assert.equal(kept.transcode, undefined);
      assert.equal(both.registered(), 1);
    } finally {
      device.resetPlaybackDevice();
      await device.getPlaybackDevice(async () => ({ code: 1 })).catch(() => {});
    }
  }],
  ['invalid input and invalid key rejected', async () => {
    assert.ok(fs.existsSync(path.join(nativeDir, 'app-source.js')), 'app source missing');
    const { fetch, calls } = fixture();
    await assert.rejects(fetch('../11'));
    assert.equal(calls.length, 0);
    await assert.rejects(fixture({ malformedKey: true }).fetch('11'));
  }],
];
(async () => {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  console.log(`${checks.length - failed}/${checks.length} passed; Node ${process.versions.node}; OpenSSL SM3=${crypto.getHashes().includes('sm3')}`);
  process.exitCode = failed ? 1 : 0;
})();
