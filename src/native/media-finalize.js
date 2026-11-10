function waitForMediaProcess(child, { signal, cancelToken, onProgress, timeoutMs = 30 * 60 * 1000, idleTimeoutMs = 120000, killAfterMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false, failure, deadline, idle, killTimer, buffer = '', seconds = 0, bytes = 0;
    const cleanup = () => {
      clearTimeout(deadline); clearTimeout(idle); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      cancelToken?.unsubscribe(abort);
      child.stdout?.removeListener('data', progress);
    };
    const finish = error => {
      if (finished) return;
      finished = true; cleanup();
      if (error) reject(error); else resolve();
    };
    const stop = error => {
      if (finished || failure) return;
      failure = error;
      try { child.kill('SIGTERM'); } catch {}
      if (finished) return;
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish(failure);
      }, killAfterMs);
    };
    const timeout = () => stop(Object.assign(new Error('媒体处理超时，已停止本次下载。请重试，或改选其他清晰度。'), { code: 'MEDIA_FINALIZE_TIMEOUT' }));
    const abort = () => stop(Object.assign(new Error('已取消媒体处理'), { code: 'ERR_CANCELED' }));
    const refreshIdle = () => { clearTimeout(idle); idle = setTimeout(timeout, idleTimeoutMs); };
    const progress = chunk => {
      if (finished || failure) return;
      buffer = (buffer + chunk.toString()).slice(-65536);
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        const match = /^(out_time_us|out_time_ms|total_size)=(\d+)$/.exec(line);
        if (!match) continue;
        const value = Number(match[2]);
        if (!Number.isSafeInteger(value) || value < 0) continue;
        const previous = match[1] === 'total_size' ? bytes : seconds;
        const next = match[1] === 'total_size' ? value : value / 1000000;
        if (next <= previous) continue;
        if (match[1] === 'total_size') bytes = next; else seconds = next;
        refreshIdle();
        try { onProgress?.({ seconds, bytes }); } catch {}
      }
    };
    child.stdout?.on('data', progress);
    child.stderr?.on('data', () => {});
    child.once('error', () => finish(failure || Object.assign(new Error('无法启动媒体处理工具，请修复安装后重试。'), { code: 'LOCAL_MEDIA_TOOL_ERROR' })));
    child.once('close', code => finish(failure || (code === 0 ? null : Object.assign(new Error(`媒体处理失败（退出码 ${Number.isInteger(code) ? code : '未知'}）。请重试，或改选其他清晰度。`), { code: 'MEDIA_FINALIZE_FAILED' }))));
    deadline = setTimeout(timeout, timeoutMs);
    refreshIdle();
    signal?.addEventListener('abort', abort, { once: true });
    cancelToken?.subscribe(abort);
    if (signal?.aborted || cancelToken?.reason) abort();
  });
}
module.exports = { waitForMediaProcess };
