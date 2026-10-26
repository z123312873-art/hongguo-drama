import { canonicalTitle } from '../chineseScript.mjs';

export function seasonTitle(title) {
  const text = canonicalTitle(title);
  const match = text.match(/^(.*?)(?:第([一二三四五六七八九十百零两兩\d]+)[季部]|[（(]([一二三四五六七八九十百零两兩\d]+)[）)]|season(\d+))$/i);
  if (!match) return { base: text, season: 1, explicit: false };
  const value = match[2] || match[3] || match[4];
  let season = Number(value);
  if (!Number.isFinite(season)) {
    const digits = {零:0,〇:0,一:1,二:2,两:2,兩:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
    let n = 0, digit = 0;
    for (const char of value) {
      if (char === '十' || char === '百') { n += (digit || 1) * (char === '十' ? 10 : 100); digit = 0; }
      else digit = digits[char] || 0;
    }
    season = /[十百]/.test(value) ? n + digit : Number([...value].map(char => digits[char]).join(''));
  }
  // Bare bracket numbers can be years or other title metadata; accept only modest season numbers.
  if (match[3] && season > 99) return { base: text, season: 1, explicit: false };
  if (!Number.isSafeInteger(season) || season < 1) return { base: text, season: 1, explicit: false, invalid: true };
  return { base: match[1], season, explicit: true };
}

export function sourceOf(id) {
  if (/^\d{6,30}$/.test(id)) return 'hongguo';
  if (/^xifan:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(id)) return 'xifan';
  if (/^hema:\d+$/.test(id)) return 'hema';
  return null;
}
