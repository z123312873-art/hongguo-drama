const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BUILTIN_MEDIA_SOURCES, normalizeMediaSources, mediaSourceLabel } = require('../src/components/mediaSourcesModel.mjs');

async function check() {
  assert.equal(BUILTIN_MEDIA_SOURCES.some(item => item.id === 'xifan'), false);
  assert.deepEqual(normalizeMediaSources([
    { id: 'hongguo', label: '红果短剧' }, { id: 'xifan', label: '西饭短剧' }, { id: 'hema', label: '河马短剧' },
  ]).map(item => item.id), ['hongguo', 'hema']);
  assert.match(mediaSourceLabel('xifan:huabo:a'), /已移除/);
  assert.equal(fs.existsSync(path.join(__dirname, '../src/native/xifan.js')), false);
  const vm = require('node:vm');
  const context = { module: { exports: {} }, Buffer, URL, process: { env: {} }, console,
    require: name => { if (name === './xifan') throw Error('西饭适配器不得再被载入'); if (name === 'axios') return { get: () => { throw Error('西饭不得发出请求'); } }; return require(name.startsWith('.') ? path.join(__dirname, '../src/native', name) : name); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/native/hongguo.js'), 'utf8'), context);
  await assert.rejects(context.module.exports.fetchEpisodeList('xifan:a:b'), error => error.code === 'SOURCE_REMOVED' && /红果/.test(error.message));
  const play = await context.module.exports.fetchPlayUrlSingle('xifan:a:b:1', 'xifan:a:b');
  assert.equal(play.url, null);
  assert.match(play.error, /已移除/);
  const { sourceOf } = require('../src/native/season-title');
  assert.equal(sourceOf('xifan:a:b'), null, '已移除来源不再查续作');
  const { RANDOM_SOURCES } = await import(require('node:url').pathToFileURL(path.join(__dirname, '../src/components/randomDramaModel.mjs')).href);
  assert.equal(RANDOM_SOURCES.some(([id]) => id === 'xifan'), false);
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.equal(/label:'西饭'/.test(main), false);
  assert.match(main, /西饭来源已移除/);
  console.log('PASS 西饭来源已移除，旧设定回退红果，残留编号仍可辨识');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
