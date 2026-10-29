'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { PassThrough } = require('node:stream');

/** Wall-clock delay before spill writes hit disk (playback path stays pipe-first). */
const SPILL_DELAY_MS = 30_000;
/** Hold early bytes in memory until the gate opens; then flush and stream-append. */
const SPILL_BUFFER_MAX_BYTES = 16 * 1024 * 1024;

function mediaRange(rangeHeader, size) {
  if (!rangeHeader || size <= 0) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader) || /^bytes=(\d+)-$/.exec(rangeHeader);
  if (!match) return false;
  const start = Number(match[1]);
  let end = match[2] === '' || match[2] === undefined ? size - 1 : Number(match[2]);
  if (!Number.isFinite(start) || start < 0 || start >= size) return false;
  end = Math.min(end, size - 1);
  if (end < start) return false;
  return { start, end };
}

function spillState(entry) {
  if (!entry.spill) {
    entry.spill = {
      directory: null,
      path: null,
      stream: null,
      pending: [],
      pendingBytes: 0,
      gateOpen: false,
      timer: null,
      size: 0,
      finalized: false,
    };
  }
  return entry.spill;
}

async function ensureSpillDirectory(entry) {
  const spill = spillState(entry);
  if (spill.directory) return spill;
  let tempRoot;
  try { tempRoot = require('electron').app.getPath('temp'); }
  catch { tempRoot = require('node:os').tmpdir(); }
  spill.directory = await fsp.mkdtemp(path.join(tempRoot, 'hongguo-spill-'));
  spill.path = path.join(spill.directory, 'playback.mp4');
  spill.stream = fs.createWriteStream(spill.path, { flags: 'w', mode: 0o600 });
  spill.stream.on('error', () => {});
  return spill;
}

function flushPending(spill) {
  if (!spill.stream || spill.finalized) return;
  for (const chunk of spill.pending) {
    spill.stream.write(chunk);
    spill.size += chunk.length;
  }
  spill.pending = [];
  spill.pendingBytes = 0;
}

function openSpillGate(entry) {
  const spill = spillState(entry);
  if (spill.gateOpen || spill.finalized) return;
  spill.gateOpen = true;
  if (spill.timer) clearTimeout(spill.timer);
  ensureSpillDirectory(entry).then(() => flushPending(spill)).catch(() => {});
}

function scheduleSpillGate(entry, signal) {
  const spill = spillState(entry);
  if (spill.gateOpen || spill.timer) return;
  spill.timer = setTimeout(() => openSpillGate(entry), SPILL_DELAY_MS);
  const abort = () => {
    if (spill.timer) clearTimeout(spill.timer);
    spill.timer = null;
  };
  signal?.addEventListener('abort', abort, { once: true });
}

function appendSpillChunk(entry, chunk) {
  const spill = spillState(entry);
  if (spill.finalized) return;
  if (!spill.gateOpen) {
    spill.pending.push(chunk);
    spill.pendingBytes += chunk.length;
    if (spill.pendingBytes >= SPILL_BUFFER_MAX_BYTES) openSpillGate(entry);
    return;
  }
  if (!spill.stream) {
    spill.pending.push(chunk);
    spill.pendingBytes += chunk.length;
    ensureSpillDirectory(entry).then(() => flushPending(spill)).catch(() => {});
    return;
  }
  spill.stream.write(chunk);
  spill.size += chunk.length;
}

function finalizeSpill(entry) {
  if (!entry) return;
  const spill = spillState(entry);
  if (spill.finalized) return;
  spill.finalized = true;
  if (spill.timer) clearTimeout(spill.timer);
  if (spill.gateOpen && spill.stream) {
    try { spill.stream.end(); } catch (_) {}
  }
  try {
    if (spill.path && fs.existsSync(spill.path)) spill.size = fs.statSync(spill.path).size;
  } catch (_) {}
}

function disposeEntrySpill(entry) {
  if (!entry?.spill) return;
  const spill = entry.spill;
  if (spill.timer) clearTimeout(spill.timer);
  spill.finalized = true;
  try { spill.stream?.destroy?.(); } catch (_) {}
  if (spill.directory) {
    try { fs.rmSync(spill.directory, { recursive: true, force: true }); } catch (_) {}
  }
  delete entry.spill;
}

function spillFileSize(entry) {
  const spill = entry?.spill;
  if (!spill?.path) return 0;
  try {
    if (!fs.existsSync(spill.path)) return spill.size || 0;
    return fs.statSync(spill.path).size;
  } catch (_) {
    return spill.size || 0;
  }
}

function spillRangeResponse(request, entry) {
  const size = spillFileSize(entry);
  if (size <= 0) return null;
  const spill = entry.spill;
  if (!spill?.path || !fs.existsSync(spill.path)) return null;
  const range = mediaRange(request.headers.get('range'), size);
  if (range === false) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const { start, end } = range || { start: 0, end: size - 1 };
  const headers = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const reader = fs.createReadStream(spill.path, { start, end });
  return new Response(require('node:stream').Readable.toWeb(reader), { status: range ? 206 : 200, headers });
}

/**
 * Tap FFmpeg stdout: player gets every chunk; spill appends after delayed gate.
 */
function tapContentKeyStdout(entry, sourceStdout, signal) {
  scheduleSpillGate(entry, signal);
  const out = new PassThrough();
  sourceStdout.on('data', chunk => {
    appendSpillChunk(entry, chunk);
    if (!out.destroyed) out.write(chunk);
  });
  sourceStdout.once('end', () => { finalizeSpill(entry); out.end(); });
  sourceStdout.once('close', () => { finalizeSpill(entry); out.destroy(); });
  sourceStdout.once('error', err => { finalizeSpill(entry); out.destroy(err); });
  signal?.addEventListener('abort', () => out.destroy(), { once: true });
  return out;
}

module.exports = {
  SPILL_DELAY_MS,
  SPILL_BUFFER_MAX_BYTES,
  tapContentKeyStdout,
  spillRangeResponse,
  spillFileSize,
  finalizeSpill,
  disposeEntrySpill,
  openSpillGate,
  mediaRange,
};
