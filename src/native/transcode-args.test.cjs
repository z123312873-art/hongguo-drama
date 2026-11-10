const assert = require('node:assert/strict');
const test = require('node:test');
const { streamPlan, bytevc2FileArgs, bytevc2PrefetchArgs, copyStreamArgs } = require('./transcode-args');

test('compatible streams stay on copy and bytevc2 uses a separate transcoder', () => {
  const copy = streamPlan({ contentKey: 'ab', codec: 'h264' });
  assert.equal(copy.tool, 'ffmpeg');
  assert.equal(copy.args.includes('libx264'), false);
  assert.equal(copy.args.includes('frag_keyframe+empty_moov+default_base_moof'), true);
  assert.equal(copy.args.includes('+faststart'), false);
  const hevc = streamPlan({ contentKey: 'ab', codec: 'hevc' });
  assert.deepEqual(hevc.args, copyStreamArgs('ab'));
  const transcode = streamPlan({ contentKey: 'cd', codec: 'bytevc2' });
  assert.equal(transcode.tool, 'librempeg');
  for (const token of ['libx264', 'ultrafast', 'zerolatency', '23', '4', '48', 'expr:gte(t,n_forced*1)']) assert.equal(transcode.args.includes(token), true, token);
  assert.equal(transcode.args.includes('veryfast'), false);
  assert.equal(transcode.args.includes('lookahead_threads'), false);
  assert.equal(transcode.args.includes('+faststart'), false);
  const file = bytevc2FileArgs('cd', 'in.mp4', 'out.mp4');
  assert.equal(file.includes('+faststart'), true);
  assert.equal(file.includes('veryfast'), true);
  assert.equal(file.includes('ultrafast'), false);
  assert.equal(file.at(-1), 'out.mp4');
  const prefetch = bytevc2PrefetchArgs('cd', 'in.mp4', 'next.mp4');
  for (const token of ['ultrafast', 'zerolatency', '4', '+faststart']) assert.equal(prefetch.includes(token), true, token);
  assert.equal(prefetch.includes('veryfast'), false);
  assert.equal(prefetch.at(-1), 'next.mp4');
});


test('online newer-codec fragments are emitted early without changing encoding quality or compatible copies', () => {
  const plan = streamPlan({ contentKey: 'ab', codec: 'bytevc2' });
  assert.equal(plan.args[plan.args.indexOf('-frag_duration') + 1], '250000');
  assert.equal(plan.args[plan.args.indexOf('-flush_packets') + 1], '1');
  assert.equal(plan.args[plan.args.indexOf('-crf') + 1], '23');
  assert.equal(plan.args.includes('-vf'), false);
  assert.equal(copyStreamArgs('ab').includes('-frag_duration'), false);
  assert.equal(bytevc2FileArgs('ab', 'input', 'output').includes('-frag_duration'), false);
});
