// SPDX-License-Identifier: GPL-3.0-only
// One codec family for App playback and the web parser.
// A label the desktop player can decode is H.264 or HEVC, including the
// parameter suffixes those families use (avc1.64001f, hvc1.1.6.L93.B0, h265_hvc1).
// Newer or unrelated families stay out; they are not renamed into a known codec.
const H264 = new Set(['h264', 'avc', 'avc1']);
const HEVC = new Set(['h265', 'h265_hvc1', 'hevc', 'hvc1', 'hev1', 'bytevc1']);
const REFUSED = new Set(['bytevc2', 'h266', 'vvc', 'av1']);

function codecRank(codec) {
  const name = String(codec || '').trim().toLowerCase();
  if (!name || REFUSED.has(name) || name.startsWith('av01')) return 2;
  if (H264.has(name) || name.startsWith('avc1.')) return 0;
  if (HEVC.has(name) || name.startsWith('hvc1.') || name.startsWith('hev1.') || name.startsWith('h265')) return 1;
  return 2;
}

function playbackCodec(codec) {
  const rank = codecRank(codec);
  if (rank === 0) return 'h264';
  if (rank === 1) return 'hevc';
  return String(codec || '').trim().toLowerCase();
}

module.exports = { codecRank, playbackCodec };
