'use strict';

// The first window is written as it arrives so playback can start before the rest downloads.
// Later windows are fetched together, then appended in order. A closed FFmpeg pipe must not surface write EOF.
const FIRST_WINDOW = 1024 * 1024;
const PARALLEL_MIN = 2 * 1024 * 1024;
const WRITE_SLICE = 256 * 1024;

function cancelled() {
  return Object.assign(new Error('已取消播放'), { code: 'ERR_CANCELED' });
}

function isCancel(error, signal) {
  return Boolean(signal?.aborted)
    || error?.code === 'ERR_CANCELED'
    || error?.name === 'CanceledError'
    || error?.name === 'AbortError';
}

function withSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => {
      Promise.resolve(promise).then(value => value?.data?.destroy?.(), () => {});
      reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        value?.data?.destroy?.();
        reject(cancelled());
        return;
      }
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

function createStdinWriter(stdin, signal) {
  let closed = false;
  const close = () => { closed = true; };
  if (stdin && typeof stdin.on === 'function') {
    stdin.on('error', close);
    stdin.on('close', close);
  }
  if (signal?.aborted) close();
  else signal?.addEventListener('abort', close, { once: true });
  const dead = () => closed || !stdin || stdin.destroyed || stdin.writableEnded || stdin.writable === false;
  return {
    get closed() { return dead(); },
    async write(chunk) {
      if (dead()) return false;
      let accepted = true;
      try { accepted = stdin.write(chunk); }
      catch { close(); return false; }
      if (accepted || dead()) return !dead();
      await new Promise(resolve => {
        const finish = () => {
          stdin.off?.('drain', finish);
          stdin.off?.('error', finish);
          stdin.off?.('close', finish);
          resolve();
        };
        stdin.once('drain', finish);
        stdin.once('error', finish);
        stdin.once('close', finish);
      });
      return !dead();
    },
    async writeBuffer(buffer) {
      for (let offset = 0; offset < buffer.length; offset += WRITE_SLICE) {
        const slice = buffer.subarray(offset, Math.min(buffer.length, offset + WRITE_SLICE));
        if (!(await this.write(slice))) return false;
      }
      return true;
    },
    end() {
      if (dead()) return;
      try { stdin.end(); }
      catch { close(); }
    },
  };
}

function contentRange(headers) {
  const raw = headers?.['content-range'] || headers?.['Content-Range'] || '';
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(Array.isArray(raw) ? raw[0] : raw));
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

async function readBody(stream, signal, onChunk) {
  let received = 0;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        stream.destroy?.();
        throw cancelled();
      }
      received += chunk.length;
      if (onChunk && !(await onChunk(chunk))) {
        stream.destroy?.();
        throw cancelled();
      }
    }
  } catch (error) {
    stream.destroy?.();
    throw error;
  }
  return received;
}

async function readRange(request, playInfo, start, end, signal) {
  const response = await withSignal(request(playInfo, {
    signal,
    headers: { Range: `bytes=${start}-${end}` },
    validateStatus: status => status === 206 || status === 200,
  }), signal);
  const chunks = [];
  try {
    await readBody(response.data, signal, async chunk => { chunks.push(chunk); return true; });
  } catch (error) {
    response.data?.destroy?.();
    throw error;
  }
  const buf = Buffer.concat(chunks);
  if (buf.length !== end - start + 1) throw Object.assign(new Error('分片长度不符'), { code: 'MEDIA_TRANSFER_ERROR' });
  return buf;
}

async function feedContentKey(playInfo, stdin, signal, options = {}) {
  const request = options.request;
  const maxBytes = Number(options.maxBytes) || 300 * 1024 * 1024;
  const writer = createStdinWriter(stdin, signal);
  if (writer.closed || typeof request !== 'function') return;
  const tails = [];
  try {
    const response = await withSignal(request(playInfo, {
      signal,
      headers: { Range: `bytes=0-${FIRST_WINDOW - 1}` },
      validateStatus: status => status === 206 || status === 200,
    }), signal);
    if (writer.closed) {
      response.data?.destroy?.();
      return;
    }
    const range = contentRange(response.headers);
    if (range && range.start !== 0) {
      response.data?.destroy?.();
      throw Object.assign(new Error('分片长度不符'), { code: 'MEDIA_TRANSFER_ERROR' });
    }
    const whole = response.status === 200 || (range && range.end + 1 >= range.total);
    if (!range && response.status !== 200) {
      response.data?.destroy?.();
      const full = await withSignal(request(playInfo, { signal }), signal);
      if (writer.closed) { full.data?.destroy?.(); return; }
      await readBody(full.data, signal, chunk => writer.write(chunk));
      if (!writer.closed) writer.end();
      return;
    }
    if (whole) {
      const received = await readBody(response.data, signal, chunk => writer.write(chunk));
      if (range && received !== range.total) throw Object.assign(new Error('分片长度不符'), { code: 'MEDIA_TRANSFER_ERROR' });
      if (!writer.closed) writer.end();
      return;
    }
    const covered = range.end + 1;
    const total = range.total;
    const expectedFirst = range.end - range.start + 1;
    const parallel = total >= PARALLEL_MIN && total <= maxBytes;
    if (parallel) {
      const span = Math.ceil((total - covered) / 3);
      for (let index = 0; index < 3; index += 1) {
        const start = covered + index * span;
        if (start >= total) break;
        tails.push(readRange(request, playInfo, start, Math.min(total - 1, start + span - 1), signal));
      }
    }
    const received = await readBody(response.data, signal, chunk => writer.write(chunk));
    if (received !== expectedFirst) throw Object.assign(new Error('分片长度不符'), { code: 'MEDIA_TRANSFER_ERROR' });
    if (parallel) {
      for (const piece of tails) {
        if (!(await writer.writeBuffer(await piece))) throw cancelled();
      }
    } else if (covered < total) {
      const rest = await withSignal(request(playInfo, {
        signal,
        headers: { Range: `bytes=${covered}-` },
        validateStatus: status => status === 206 || status === 200,
      }), signal);
      if (writer.closed) { rest.data?.destroy?.(); return; }
      await readBody(rest.data, signal, chunk => writer.write(chunk));
    }
    if (!writer.closed) writer.end();
  } catch (error) {
    if (!isCancel(error, signal) && !writer.closed) throw error;
  } finally {
    await Promise.allSettled(tails);
  }
}

module.exports = { feedContentKey, createStdinWriter };
