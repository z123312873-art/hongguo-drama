import { canonicalTitle } from './chineseScript.mjs';

// One chip row for every Hongguo category and hot rank. Real-drama keeps its
// server genres first so a single selected chip still requests that catalog.
// The extra labels are the ones comic, AI, and poster tags use.
export const SHARED_BROWSE_TAGS = [
  '爱情', '年代', '逆袭', '传奇', '成长', '家庭', '家族', '萌宝', '悬疑', '惊悚', '恐怖', '志怪',
  '古装', '玄幻', '奇幻', '都市', '青春', '喜剧', '科幻', '灾难', '动作冒险', '战争', '综艺', '剧情',
  '脑洞', '恋爱', '系统', '穿越', '重生', '末世', '豪门', '冒险',
];

export function toggleBrowseTags(selected, label) {
  const current = (Array.isArray(selected) ? selected : []).filter(item => SHARED_BROWSE_TAGS.includes(item));
  if (!label || label === '全部') return [];
  if (!SHARED_BROWSE_TAGS.includes(label)) return current;
  const index = current.indexOf(label);
  if (index >= 0) return current.filter(item => item !== label);
  if (current.length < 2) return [...current, label];
  return [current[1], label];
}

export function posterMatchesTags(tags, selected) {
  const wanted = (Array.isArray(selected) ? selected : []).map(label => canonicalTitle(label)).filter(Boolean);
  if (!wanted.length) return true;
  const have = new Set((Array.isArray(tags) ? tags : []).map(tag => canonicalTitle(tag)));
  return wanted.every(label => have.has(label));
}

export function formatPublicScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 10) return '';
  return (Math.round(number * 10) / 10).toFixed(1);
}
