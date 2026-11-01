import { canonicalTitle } from './chineseScript.mjs';

// Comic posters carry the source's own labels (about sixty distinct ones, many of them variants of the
// same idea such as 现言 / 现代言情 / 现言甜宠). These chips group them by keyword, so a new variant the
// source invents tomorrow still lands in the right chip without any list being edited.
// A poster can belong to several chips. A label that matches nothing only shows under "全部".
export const COMIC_CHIPS = Object.freeze([
  { label: '都市', words: ['都市', '职场', '乡村', '日常'] },
  { label: '言情', words: ['言情', '现言', '恋爱', '甜宠', '纯爱', '男神', '娱乐圈', '双男主', '耽美'] },
  { label: '总裁豪门', words: ['总裁', '豪门'] },
  { label: '古风', words: ['古风', '古代', '古言', '宫斗', '宅斗', '种田'] },
  { label: '玄幻仙侠', words: ['玄幻', '仙侠', '武侠', '修仙', '修真', '妖怪'] },
  { label: '穿越重生', words: ['穿越', '重生', '穿书'] },
  { label: '系统开挂', words: ['系统', '开挂', '无敌', '金手指'] },
  { label: '逆袭复仇', words: ['逆袭', '复仇', '反派', '打脸'] },
  { label: '悬疑灵异', words: ['悬疑', '灵异', '恐怖', '惊悚'] },
  { label: '热血异能', words: ['热血', '冒险', '异能', '战神'] },
  { label: '萌趣搞笑', words: ['搞笑', '治愈', '萌', '轻松'] },
  { label: '青春校园', words: ['校园', '青春'] },
  { label: '末世科幻', words: ['末世', '末日', '科幻', '网游', '游戏'] },
  { label: '小说漫改', words: ['漫改', '改编'] },
]);

const KEYS = COMIC_CHIPS.map(chip => ({ label: chip.label, words: chip.words.map(word => canonicalTitle(word)) }));
const MAX_SELECTED = 2;

export function comicChipsFor(tags) {
  const list = (Array.isArray(tags) ? tags : []).map(tag => canonicalTitle(tag)).filter(Boolean);
  if (!list.length) return [];
  return KEYS.filter(chip => chip.words.some(word => list.some(tag => tag.includes(word)))).map(chip => chip.label);
}

export function toggleComicChips(selected, label) {
  const valid = new Set(COMIC_CHIPS.map(chip => chip.label));
  const current = (Array.isArray(selected) ? selected : []).filter(item => valid.has(item));
  if (!label || label === '全部') return [];
  if (!valid.has(label)) return current;
  if (current.includes(label)) return current.filter(item => item !== label);
  return current.length < MAX_SELECTED ? [...current, label] : [current[1], label];
}

// Selecting two chips keeps posters that have both.
export function comicMatchesChips(card, selected) {
  const wanted = Array.isArray(selected) ? selected : [];
  if (!wanted.length) return true;
  const have = new Set(comicChipsFor(card?.tags));
  return wanted.every(label => have.has(label));
}

// Chip counts for the current list, so empty chips can be hidden instead of leading to a blank page.
export function comicChipCounts(cards) {
  const counts = new Map(COMIC_CHIPS.map(chip => [chip.label, 0]));
  for (const card of Array.isArray(cards) ? cards : []) {
    for (const label of comicChipsFor(card?.tags)) counts.set(label, counts.get(label) + 1);
  }
  return counts;
}
