const FRAGMENTED = 'frag_keyframe+empty_moov+default_base_moof';

function copyStreamArgs(contentKey) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-decryption_key', contentKey, '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', FRAGMENTED, '-f', 'mp4', 'pipe:1'];
}

function bytevc2EncodeArgs() {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-x264-params', 'lookahead-threads=1', '-c:a', 'copy'];
}

function bytevc2StreamArgs(contentKey) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-decryption_key', contentKey, '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-threads', '4',
    '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-c:a', 'copy', '-movflags', FRAGMENTED, '-frag_duration', '250000', '-flush_packets', '1', '-f', 'mp4', 'pipe:1'];
}

function bytevc2FileArgs(contentKey, input, output) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-decryption_key', contentKey, '-i', input, '-map', '0:v:0', '-map', '0:a?', ...bytevc2EncodeArgs(), '-movflags', '+faststart', '-f', 'mp4', output];
}

function bytevc2PrefetchArgs(contentKey, input, output) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-decryption_key', contentKey, '-i', input, '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-threads', '4',
    '-g', '48', '-keyint_min', '48', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4', output];
}

function streamPlan(playInfo) {
  if (playInfo?.codec === 'bytevc2' || playInfo?.transcode === 'bytevc2') {
    return { tool: 'librempeg', args: bytevc2StreamArgs(playInfo.contentKey) };
  }
  return { tool: 'ffmpeg', args: copyStreamArgs(playInfo.contentKey) };
}

module.exports = { copyStreamArgs, bytevc2StreamArgs, bytevc2FileArgs, bytevc2PrefetchArgs, streamPlan };
