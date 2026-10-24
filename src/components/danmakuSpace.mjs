// 时间轴弹幕与本集评论是两层。评论层每帧读时间轴的位置，避免快慢不同时互相盖住。
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
