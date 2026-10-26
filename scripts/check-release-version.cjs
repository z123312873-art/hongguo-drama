const assert = require('node:assert/strict');
const { availableRelease } = require('../src/native/app-update');

const ordered = ['1.7', '1.8', '1.9', '1.71', '1.74', '1.75', '1.75.1', '1.76', '1.99', '1.100', '2.0', '2.9', '3.0', '3.1', '3.2', '3.3', '3.4'];
let checks = 0;
for (let current = 0; current < ordered.length; current++) {
  for (let next = 0; next < ordered.length; next++) {
    const release = availableRelease({ tag_name: `v${ordered[next]}` }, ordered[current]);
    assert.equal(release?.version || null, next > current ? ordered[next] : null,
      `${ordered[current]} to ${ordered[next]}`);
    checks++;
  }
}
for (const tag of ['v1.75', '1.75', 'v1.75.0', '1.75.0']) {
  assert.equal(availableRelease({ tag_name: tag }, '1.75.0'), null);
}
for (const tag of ['v1.76-beta.1', 'v1.76.0-beta.1', 'garbage', '1.76.0.1', '1.9007199254740992']) {
  assert.equal(availableRelease({ tag_name: tag }, '1.75.0'), null);
}
for (const flags of [{ prerelease: true }, { draft: true }]) {
  assert.equal(availableRelease({ tag_name: 'v2.0', ...flags }, '1.75.0'), null);
}
const pkg = require('../package.json');
const lock = require('../package-lock.json');
assert.equal(lock.version, pkg.version, 'Lockfile version must match the release');
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root package must match the release');
assert.match(pkg.version, /^\d+\.\d+\.0$/, 'Release versions use two public components and an internal zero patch');
const publicVersion = pkg.version.replace(/\.0$/, '');
assert.equal(availableRelease({ tag_name: 'v2.0' }, '1.80.0').version, '2.0');
assert.equal(availableRelease({ tag_name: 'v2.0' }, '2.0.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.1' }, '3.0.0').version, '3.1');
assert.equal(availableRelease({ tag_name: 'v3.1' }, '3.1.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.2' }, '3.1.0').version, '3.2');
assert.equal(availableRelease({ tag_name: 'v3.2' }, '3.2.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.3' }, '3.2.0').version, '3.3');
assert.equal(availableRelease({ tag_name: 'v3.3' }, '3.3.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.4' }, '3.3.0').version, '3.4');
assert.equal(availableRelease({ tag_name: 'v3.4' }, '3.4.0'), null);
assert.equal(availableRelease({ tag_name: 'installer-3.4-traditional-pre', prerelease: true }, '3.3.0'), null);
const noted = availableRelease({ tag_name: 'v3.4', body: '摘要：\n- 修正彈幕重疊\n- 時間軸最多 35 條\n\nSHA256：abc\nhttps://example.invalid/setup.exe' }, '3.3.0');
assert.equal(noted.version, '3.4');
assert.deepEqual(noted.highlights, ['修正彈幕重疊', '時間軸最多 35 條']);
assert.equal(availableRelease({ tag_name: 'v3.4', body: '摘要：這一整句不該變成單行摘要，因為正式說明要條列。' }, '3.3.0').highlights, undefined);
assert.deepEqual(availableRelease({ tag_name: 'v3.4', body: '摘要：橫幅、更新提醒、時間軸' }, '3.3.0').highlights, ['橫幅', '更新提醒', '時間軸']);
assert.equal(availableRelease({ tag_name: 'v3.4', body: `- ${'字'.repeat(40)}` }, '3.3.0').highlights, undefined);
assert.equal(availableRelease({ tag_name: 'v3.4', body: `摘要：\n- ${'字'.repeat(40)}` }, '3.3.0').highlights[0].length, 24);
assert.equal(availableRelease({ tag_name: 'v3.4', prerelease: true, body: '摘要：\n- 不該出現' }, '3.3.0'), null);
for (const artifact of [pkg.build.artifactName, pkg.build.portable.artifactName, pkg.build.nsis.artifactName]) {
  assert(artifact.includes(`-${publicVersion}-`), 'Download filenames must contain the two-part release version');
  assert(!artifact.includes('${version}'), 'Raw internal versions must not leak into download filenames');
}
console.log(`PASS ${checks} version pairs, equivalent versions, invalid versions and unpublished releases`);
