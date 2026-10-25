// 时间轴和本集评论各写各的层。读取时传入自己的层名，只拿另一层的位置，避免把自己当成障碍往前推。
const layers = new Map();

export function syncDanmakuLayer(name, items) {
  layers.set(name, items);
}

export function foreignDanmaku(name) {
  const items = [];
  for (const [key, list] of layers) if (key !== name && Array.isArray(list)) items.push(...list);
  return items;
}

export function clearDanmakuLayer(name) {
  layers.delete(name);
}

// 时间轴先落地，本集评论再按条数决定补多少。播放器里两个钩子的调用顺序不变。
let timeline = { key: '', count: 0, ready: false };
const timelineListeners = new Set();

export function publishTimeline(seriesId, vid, value) {
  const next = {
    key: `${seriesId}:${vid}`,
    count: Number.isFinite(value?.count) ? Math.max(0, Math.floor(value.count)) : 0,
    ready: value?.ready === true,
  };
  if (timeline.key === next.key && timeline.count === next.count && timeline.ready === next.ready) return;
  timeline = next;
  timelineListeners.forEach(listener => listener());
}

export function currentTimeline(seriesId, episodeId) {
  const key = `${seriesId}:${episodeId}`;
  return timeline.key === key ? timeline : { key, count: 0, ready: false };
}

export function subscribeTimeline(listener) {
  timelineListeners.add(listener);
  return () => timelineListeners.delete(listener);
}
