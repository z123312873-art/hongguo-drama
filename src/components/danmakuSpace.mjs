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
