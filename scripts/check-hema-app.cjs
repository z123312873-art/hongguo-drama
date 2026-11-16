const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../src/native/hema-app.js');

async function load(axiosImpl) {
  const context = {
    module: { exports: {} },
    require: name => name === 'axios' ? axiosImpl : name === './cert-hint' ? { CERT_HINT: '证书提示' } : name === './direct-connect' ? { directAxiosOptions: () => ({}) } : require(name),
    Buffer, URL, setTimeout, clearTimeout, Date, JSON, String, Number, Array, Object, Error, Promise,
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return context.module.exports;
}

async function check() {
  const hemaApp = require('../src/native/hema-app');
  const cover = 'https://cdn.example/cover.jpg';
  const poster = 'https://cdn.example/poster.png?t=1';
  const mp4 = 'https://media.example/chapter.720p.mp4?sign=abc';
  const nested = {
    cover, videoInfo: {
      coverWap: poster,
      content: {
        mp4Url: mp4,
        mp4UrlRate: '720P',
        mp4SwitchUrl: [mp4],
        resolutionRates: [
          { rate: '1080P', needVip: 1, describe: '高清' },
          { rate: '720P', needVip: 0, describe: '准高清' },
          { rate: '540P', needVip: 0, describe: '标清' },
        ],
      },
    },
  };
  assert.equal(hemaApp.pickPlayUrl(nested), mp4);
  assert.equal(hemaApp.pickPlayUrl({ cover, poster, thumb: 'https://cdn.example/a.webp' }), '');
  assert.equal(hemaApp.pickPlayUrl({ downLoadUrl: 'https://media.example/file.mp4' }), 'https://media.example/file.mp4');
  assert.equal(hemaApp.pickPlayUrl({ mp4Url: cover, content: { mp4Url: mp4 } }), mp4);
  assert.equal(hemaApp.httpsUrl('http://media.example/a.mp4'), '');
  assert.equal(hemaApp.requestedRate('auto'), '720P');
  assert.equal(hemaApp.requestedRate('720p'), '720P');
  assert.equal(hemaApp.requestedRate('1080p'), '720P');
  assert.equal(hemaApp.requestedRate('540p'), '540P');
  assert.equal(hemaApp.publicQuality('720P'), '720p');
  assert.equal(hemaApp.publicQuality('540P'), '540p');
  assert.equal(hemaApp.publicQuality('1080P'), '720p');

  const posts = [];
  const axiosImpl = {
    async post(url, data, options) {
      posts.push({ url, data, options });
      assert.equal(typeof data, 'string');
      assert.ok(!String(data).startsWith('"'), 'encrypted body must not be JSON-wrapped');
      const identity = options.transformRequest?.[0];
      assert.equal(typeof identity, 'function');
      assert.equal(identity(data), data);
      assert.notEqual(JSON.stringify(data), data);
      if (String(url).endsWith('/1103')) {
        return { status: 200, data: JSON.stringify({ code: 0, data: { userInfoVo: { userId: '2911000001' } } }) };
      }
      if (String(url).endsWith('/1139')) {
        const body = { chapterList: [{ chapterId: '1', content: nested.videoInfo.content }] };
        return { status: 200, data: JSON.stringify({ code: 0, data: body }) };
      }
      return { status: 200, data: JSON.stringify({ code: 0, data: {} }) };
    },
  };
  const app = await load(axiosImpl);
  const sess = await app.ensureSession();
  assert.equal(sess.userId, '2911000001');
  const play = await app.fetchPlay('41000115014', '591821028', { quality: '720p' });
  assert.equal(play.url, mp4);
  assert.equal(play.locked, false);
  assert.equal(play.quality, '720p');
  assert.equal(play.rate, '720P');
  assert.equal(Array.from(play.qualities).join(','), '720P,540P');
  const play1080 = await app.fetchPlay('41000115014', '591821028', { quality: '1080p' });
  assert.equal(play1080.quality, '720p');
  const playEmpty = await (async () => {
    const emptyAxios = {
      async post(url, data, options) {
        assert.equal(options.transformRequest[0](data), data);
        if (String(url).endsWith('/1103')) {
          return { status: 200, data: JSON.stringify({ code: 0, data: { userInfoVo: { userId: '2911000001' } } }) };
        }
        return { status: 200, data: JSON.stringify({ code: 0, data: { cover, videoInfo: { coverWap: poster } } }) };
      },
    };
    const isolated = await load(emptyAxios);
    return isolated.fetchPlay('1', '2');
  })();
  assert.equal(playEmpty.url, null);
  assert.equal(playEmpty.locked, true);
  console.log('PASS 河马取址正文不二次封装、只取影片地址、画质上限 720P');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
