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
