function hedgeMedia(request, playInfo, options = {}, delayMs = 700) {
  if (playInfo?.source !== 'hema' || options.signal?.aborted) return request(playInfo, options);
  const parent = options.signal;
  return new Promise((resolve, reject) => {
    let finished = false;
    let opened = 0;
    let failed = 0;
    let lastError;
    const controllers = [];
    const abortOthers = (keep) => {
      controllers.forEach((controller, index) => { if (index !== keep && controller) controller.abort(); });
    };
    const giveUp = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error || lastError || Object.assign(new Error('已取消播放'), { code: 'ERR_CANCELED' }));
    };
    const fail = (error) => {
      lastError = error;
      failed += 1;
      if (!finished && failed >= opened && opened > 1) giveUp(error);
    };
    const succeed = (value, index) => {
      if (finished) {
        value?.data?.destroy?.();
        return;
      }
      finished = true;
      clearTimeout(timer);
      abortOthers(index);
      resolve(value);
    };
    const start = (index) => {
      const controller = new AbortController();
      controllers[index] = controller;
      if (parent?.aborted) controller.abort();
      else parent?.addEventListener('abort', () => controller.abort(), { once: true });
      opened += 1;
      Promise.resolve(request(playInfo, { ...options, signal: controller.signal, timeout: 8000 })).then(
        value => succeed(value, index),
        fail,
      );
    };
    const timer = setTimeout(() => {
      if (finished || parent?.aborted) return;
      start(1);
      if (failed >= opened) giveUp(lastError);
    }, delayMs);
    parent?.addEventListener('abort', () => {
      clearTimeout(timer);
      abortOthers(-1);
      giveUp(Object.assign(new Error('已取消播放'), { code: 'ERR_CANCELED' }));
    }, { once: true });
    start(0);
  });
}

module.exports = { hedgeMedia };
