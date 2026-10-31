const assert = require('node:assert/strict');
const test = require('node:test');
const { compatibleCover } = require('./cover-url');

test('decodable covers pass through untouched', () => {
  for (const url of [
    'https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image',
    'https://img.example/a.jpg?x=1',
    'http://img.example/c.png',
    'https://p3.fqnovelpic.com/novel-pic/abc~tplv-x.webp',
  ]) assert.equal(compatibleCover(url), url);
});

test('HEIC variants of Hongguo CDN images map to the plain rendition of the same image', () => {
  assert.equal(compatibleCover('https://p3-reading-sign.fqnovelpic.com/novel-pic/abc~tplv-81nmtwyey9-superreso-aifit:400:0.heic?lk3s=1'),
    'https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image');
  assert.equal(compatibleCover('https://p6-novel.byteimg.com/novel-pic/x1~tplv-a.HEIC'), 'https://p3-novel.byteimg.com/novel-pic/x1~tplv-shrink:640:0.image');
  assert.equal(compatibleCover('https://p3.fqnovelpic.com/novel-pic/x2~tplv-b.heif'), 'https://p3-novel.byteimg.com/novel-pic/x2~tplv-shrink:640:0.image');
});

test('covers that cannot be decoded or trusted become blank', () => {
  for (const value of [
    'https://img.example/a.heic', 'https://evil.byteimg.com.example/novel-pic/abc~t.heic', 'https://p3.byteimg.com/other/abc~t.heic',
    'https://p3.byteimg.com/novel-pic/~t.heic', 'https://p3.byteimg.com/novel-pic/abc.heic', 'javascript:alert(1)', 'data:image/png;base64,AAAA',
    '//img.example/a.jpg', 'not a url', '', null, undefined, 42,
  ]) assert.equal(compatibleCover(value), '', String(value));
});
