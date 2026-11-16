import assert from 'node:assert/strict';
import test from 'node:test';
import { coverCandidates } from '../../coverFallback.mjs';

test('a CDN poster falls back to the plain rendition of the same image', () => {
  assert.deepEqual(coverCandidates('https://p3-reading-sign.fqnovelpic.com/novel-pic/abc~tplv-x:400:0.heic?lk3s=1'), [
    'https://p3-reading-sign.fqnovelpic.com/novel-pic/abc~tplv-x:400:0.heic?lk3s=1',
    'https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image',
  ]);
  assert.deepEqual(coverCandidates('https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image'), ['https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image']);
});

test('other hosts and unusable values never get a guessed fallback', () => {
  assert.deepEqual(coverCandidates('https://img.example/a.jpg'), ['https://img.example/a.jpg']);
  assert.deepEqual(coverCandidates('https://evil.example/novel-pic/abc~x.jpg'), ['https://evil.example/novel-pic/abc~x.jpg']);
  for (const value of ['', '  ', 'javascript:alert(1)', '/relative.jpg', null, undefined, 7, {}]) assert.deepEqual(coverCandidates(value), []);
});

test('a resized object-storage poster falls back to its untouched original', () => {
  assert.deepEqual(coverCandidates('https://seoali.zqkanshu.com/c/41.jpg?t=17&x-oss-process=image/resize,w_320/quality,q_80'), [
    'https://seoali.zqkanshu.com/c/41.jpg?t=17&x-oss-process=image/resize,w_320/quality,q_80',
    'https://seoali.zqkanshu.com/c/41.jpg?t=17',
  ]);
  assert.deepEqual(coverCandidates('https://seoali.zqkanshu.com/c/41.jpg?x-oss-process=image/resize,w_320'), [
    'https://seoali.zqkanshu.com/c/41.jpg?x-oss-process=image/resize,w_320',
    'https://seoali.zqkanshu.com/c/41.jpg',
  ]);
  assert.deepEqual(coverCandidates('https://seoali.zqkanshu.com/c/41.jpg?t=17'), ['https://seoali.zqkanshu.com/c/41.jpg?t=17']);
  assert.deepEqual(coverCandidates('https://evil.example/c.jpg?x-oss-process=image/resize,w_320'), ['https://evil.example/c.jpg?x-oss-process=image/resize,w_320']);
});

test('a Hema poster offers the same picture from its second image host before the full-size original', () => {
  const app = 'https://kyyresali.kkyd.cn/cppartner/4x1/41x0/410x0/41000497974/41000497974.jpg?t=1794578310201&imageView2/0/w/200/h/267';
  assert.deepEqual(coverCandidates(app), [
    'https://kyyresali.kkyd.cn/cppartner/4x1/41x0/410x0/41000497974/41000497974.jpg?t=1794578310201&x-oss-process=image/resize,w_320/quality,q_80',
    'https://seoali.zqkanshu.com/cppartner/4x1/41x0/410x0/41000497974/41000497974.jpg?t=1794578310201&x-oss-process=image/resize,w_320/quality,q_80',
    app,
    'https://kyyresali.kkyd.cn/cppartner/4x1/41x0/410x0/41000497974/41000497974.jpg?t=1794578310201',
  ]);
  const listed = 'https://seoali.zqkanshu.com/cppartner/1/2/3.jpg?x-oss-process=image/resize,w_320/quality,q_80';
  assert.deepEqual(coverCandidates(listed), [
    listed,
    'https://kyyresali.kkyd.cn/cppartner/1/2/3.jpg?x-oss-process=image/resize,w_320/quality,q_80',
    'https://seoali.zqkanshu.com/cppartner/1/2/3.jpg',
  ]);
});

test('mirroring stays on the two known hosts and plain HTTPS image paths', () => {
  for (const value of ['http://seoali.zqkanshu.com/cppartner/1.jpg', 'https://seoali.zqkanshu.com:8443/cppartner/1.jpg', 'https://user:pw@seoali.zqkanshu.com/cppartner/1.jpg',
    'https://seoali.zqkanshu.com/other/1.jpg', 'https://seoali.zqkanshu.com/cppartner/1.mp4', 'https://evil.kkyd.cn.example/cppartner/1.jpg', 'https://x.kkyd.cn/cppartner/1.jpg']) {
    assert.ok(!coverCandidates(value).some(item => item.includes('kyyresali.kkyd.cn') && !value.includes('kyyresali')), value);
  }
  assert.deepEqual(coverCandidates('https://seoali.zqkanshu.com/cppartner/1.jpg?t=abc'), [
    'https://seoali.zqkanshu.com/cppartner/1.jpg?x-oss-process=image/resize,w_320/quality,q_80',
    'https://kyyresali.kkyd.cn/cppartner/1.jpg?x-oss-process=image/resize,w_320/quality,q_80',
    'https://seoali.zqkanshu.com/cppartner/1.jpg?t=abc',
    'https://seoali.zqkanshu.com/cppartner/1.jpg',
  ]);
});
