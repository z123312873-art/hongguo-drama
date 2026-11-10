import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPhaseLabel, downloadProgressText } from '../../downloadPhase.mjs';
test('transcoding and verification show genuine stages instead of implying a stuck transfer', () => {
  assert.equal(downloadProgressText({ status: 'downloading', phase: 'transcoding', phaseSeconds: 8.7, progress: 99 }), '正在转档 · 已处理 8 秒');
  assert.equal(downloadProgressText({ status: 'downloading', phase: 'verifying', progress: 99 }), '正在检查文件…');
  assert.equal(downloadProgressText({ status: 'downloading', progress: 42 }), '下载中 42%');
  assert.equal(downloadPhaseLabel({ status: 'failed', phase: 'transcoding' }), '');
  assert.equal(downloadProgressText({ status: 'completed', phase: 'transcoding', progress: 100 }), '');
});
