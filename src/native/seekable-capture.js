'use strict';

// Fragmented MP4 piped out of FFmpeg starts playing at once but Chromium cannot seek it. While that stream plays,
// the encrypted bytes it consumes are also kept on disk. When the download completes they are decrypted into one
// ordinary MP4 with an index, which the player can switch to the first time a seek is asked for.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { Readable, Writable, finished } = require('node:stream');
const { feedContentKey } = require('./content-key-feed');

const READ_SLICE = 256 * 1024;

function cancelled() {
  return Object.assign(new Error('已取消播放'), { code: 'ERR_CANCELED' });
}

function tooLarge() {
  return Object.assign(new Error('本集过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' });
}

function writeAll(fd, chunk, position, done) {
  let offset = 0;
  const step = () => {
    if (offset >= chunk.length) { done(null); return; }
    fs.write(fd, chunk, offset, chunk.length - offset, position + offset, (error, bytes) => {
      if (error) { done(error); return; }
      if (!bytes) { done(Object.assign(new Error('写入缓存失败'), { code: 'EIO' })); return; }
      offset += bytes;
      step();
    });
  };
  step();
}

/**
 * Downloads one encrypted episode to `directory`, hands its bytes to any number of FFmpeg readers while it grows,
 * and finally decrypts it into `video.mp4`. The caller owns `directory` after `adopt()`; until then the capture
 * removes it on failure or abort.
 */
function createContentKeyCapture({ playInfo, request, maxBytes, directory, decrypt, feed = feedContentKey }) {
  const controller = new AbortController();
  const encryptedPath = path.join(directory, 'encrypted.mp4');
  const outputPath = path.join(directory, 'video.mp4');
  const readers = new Set();
  const waiters = new Set();
  let fd = fs.openSync(encryptedPath, 'w', 0o600);
  let written = 0;
  let downloaded = false;
  let failure = null;
  let settled = false;
  let adopted = false;
  let sourceKept = true;

  const wake = () => { for (const resume of [...waiters]) resume(); };
  const closeFile = () => {
    if (fd === null) return;
    const handle = fd; fd = null;
    try { fs.closeSync(handle); } catch (_) { /* The file is removed with the directory. */ }
  };
  const fail = error => {
    if (!failure) failure = error;
    wake();
  };

  const sink = new Writable({
    highWaterMark: 1024 * 1024,
    emitClose: true,
    write(chunk, _encoding, callback) {
      if (fd === null || controller.signal.aborted) { callback(cancelled()); return; }
      if (written + chunk.length > maxBytes) { callback(tooLarge()); return; }
      writeAll(fd, chunk, written, error => {
        if (error) { callback(error); return; }
        written += chunk.length;
        wake();
        callback();
      });
    },
  });

  sink.on('error', () => {});

  const download = (async () => {
    await feed(playInfo, sink, controller.signal, { request, maxBytes });
    // The feeder returns quietly when cancelled or when its writer closed; only a finished sink is a whole file.
    if (!sink.writableEnded) throw sink.errored || cancelled();
    await new Promise((resolve, reject) => finished(sink, error => error ? reject(error) : resolve()));
    if (controller.signal.aborted) throw cancelled();
    if (!written) throw Object.assign(new Error('视频下载不完整，请重试'), { code: 'MEDIA_TRANSFER_ERROR' });
    downloaded = true;
    closeFile();
    wake();
  })();

  const cleanup = async () => {
    closeFile();
    for (const reader of [...readers]) reader.destroy(failure || undefined);
    await Promise.all([...readers].map(reader => new Promise(resolve => {
      if (reader.closed) resolve(); else reader.once('close', resolve);
    })));
    if (!adopted) await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
  };

  const result = (async () => {
    try {
      await download;
      await decrypt(encryptedPath, outputPath, { signal: controller.signal });
      if (controller.signal.aborted) throw cancelled();
      const { size } = await fsp.stat(outputPath);
      if (!size) throw Object.assign(new Error('视频解密失败，请重试'), { code: 'MEDIA_TRANSFER_ERROR' });
      await fsp.rm(encryptedPath, { force: true });
      sourceKept = false;
      settled = true;
      return { filePath: outputPath, size, directory };
    } catch (error) {
      settled = true;
      fail(error);
      sink.destroy();
      await cleanup();
      throw error;
    }
  })();
  result.catch(() => {});

  return {
    directory,
    outputPath,
    result,
    signal: controller.signal,
    get settled() { return settled; },
    get failed() { return failure; },
    /** True while the encrypted bytes are still on disk, so another FFmpeg may read them from the start. */
    get readable() { return sourceKept && !failure && !controller.signal.aborted; },
    /** Stream of the encrypted file from byte 0 that waits for the download instead of ending early. */
    reader() {
      if (!this.readable) throw failure || cancelled();
      const stream = Readable.from((async function* read() {
        const handle = await fsp.open(encryptedPath, 'r');
        let position = 0;
        try {
          for (;;) {
            if (failure) throw failure;
            if (position < written) {
              const buffer = Buffer.allocUnsafe(Math.min(READ_SLICE, written - position));
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
              if (!bytesRead) throw Object.assign(new Error('缓存读取失败'), { code: 'EIO' });
              position += bytesRead;
              yield bytes(buffer, bytesRead);
              continue;
            }
            if (downloaded) return;
            await new Promise(resolve => {
              const resume = () => { waiters.delete(resume); resolve(); };
              waiters.add(resume);
            });
          }
        } finally {
          await handle.close().catch(() => {});
        }
      })(), { objectMode: false, highWaterMark: READ_SLICE });
      readers.add(stream);
      stream.on('error', () => {});
      stream.once('close', () => readers.delete(stream));
      return stream;
    },
    /** The caller now owns `directory` and will remove it. */
    adopt() { adopted = true; },
    /** Drop a finished capture nobody will use. */
    async discard() { await cleanup(); },
    abort() {
      if (settled) return;
      controller.abort();
      fail(cancelled());
      sink.destroy();
    },
  };
}

function bytes(buffer, length) {
  return length === buffer.length ? buffer : buffer.subarray(0, length);
}

module.exports = { createContentKeyCapture };
