const assert = require('node:assert/strict');
const test = require('node:test');
const { streamPlan, bytevc2FileArgs, copyStreamArgs } = require('./transcode-args');

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
  for (const token of ['libx264', 'veryfast', '23', '2', '1']) assert.equal(transcode.args.includes(token), true, token);
  assert.equal(transcode.args.includes('+faststart'), false);
  const file = bytevc2FileArgs('cd', 'in.mp4', 'out.mp4');
  assert.equal(file.includes('+faststart'), true);
  assert.equal(file.at(-1), 'out.mp4');
});
