
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
