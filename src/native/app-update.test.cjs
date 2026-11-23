const assert = require('node:assert/strict');
const test = require('node:test');
const { parseUpdateFeed, releaseUrls, updateRedirectTag, availableRelease, FEED_URLS, FALLBACK_SOURCE } = require('./app-update');

test('update feed accepts only this owner and a repository name', () => {
  assert.deepEqual(parseUpdateFeed({ owner: 'z123312873-art', repo: 'hongguo-drama' }), FALLBACK_SOURCE);
  assert.deepEqual(parseUpdateFeed('{"owner":"z123312873-art","repo":"drama-hub-exe"}'), { owner: 'z123312873-art', repo: 'drama-hub-exe' });
  for (const value of [null, '', 'not-json', { owner: 'other', repo: 'hongguo-drama' }, { owner: 'z123312873-art', repo: '../evil' }, { owner: 'z123312873-art', repo: 'https://evil.example' }, { owner: 'z123312873-art' }]) {
    assert.equal(parseUpdateFeed(value), null);
  }
  assert.equal(FEED_URLS[0], 'https://raw.githubusercontent.com/z123312873-art/hongguo-drama/main/update-feed.json');
});

test('release checks follow the feed and fall back to the public repository', () => {
  const moved = releaseUrls({ owner: 'z123312873-art', repo: 'drama-hub-exe' });
  assert.equal(moved.api, 'https://api.github.com/repos/z123312873-art/drama-hub-exe/releases/latest');
  assert.equal(updateRedirectTag('https://github.com/z123312873-art/drama-hub-exe/releases/tag/v4.9', { owner: 'z123312873-art', repo: 'drama-hub-exe' }), 'v4.9');
  assert.equal(updateRedirectTag('https://github.com/z123312873-art/hongguo-drama/releases/tag/v4.9', { owner: 'z123312873-art', repo: 'drama-hub-exe' }), null);
  const release = availableRelease({ tag_name: 'v4.9', body: '摘要：\n- 新安裝位置' }, '4.8.0', { owner: 'z123312873-art', repo: 'drama-hub-exe' });
  assert.equal(release.version, '4.9');
  assert.equal(release.url, 'https://github.com/z123312873-art/drama-hub-exe/releases/tag/v4.9');
  assert.equal(availableRelease({ tag_name: 'v4.8' }, '4.7.5').version, '4.8');
  assert.equal(availableRelease({ tag_name: 'v4.7' }, '4.7.5'), null);
  assert.equal(availableRelease({ tag_name: 'v4.8', prerelease: true }, '4.7.0'), null);
});
