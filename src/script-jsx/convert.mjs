import { toTraditional } from '../chineseScript.mjs';

const TEXT_PROPS = ['placeholder', 'title', 'alt', 'aria-label', 'aria-description', 'aria-placeholder'];

function convertNode(node) {
  if (typeof node === 'string') {
    const converted = toTraditional(node);
    return converted === node ? node : converted;
  }
  if (!Array.isArray(node)) return node;
  let changed = false;
  const next = node.map((child) => {
    const converted = convertNode(child);
    if (converted !== child) changed = true;
    return converted;
  });
  return changed ? next : node;
}

// Input values are intentionally left alone so a search box keeps the typed query.
export function convertConfig(config) {
  if (!config || config['data-script'] === 'keep' || config.translate === 'no') return config;
  let next = config;
  const children = convertNode(config.children);
  if (children !== config.children) next = { ...config, children };
  for (const key of TEXT_PROPS) {
    if (typeof config[key] !== 'string') continue;
    const converted = toTraditional(config[key]);
    if (converted === config[key]) continue;
    if (next === config) next = { ...config };
    next[key] = converted;
  }
  return next;
}
