// Renderer-only copy. The installed main process uses season-title.js because
// app.asar cannot resolve this ESM import. Keep the two parsers aligned.
import { canonicalTitle } from '../chineseScript.mjs';

const ROMAN = {Ⅰ:1,Ⅱ:2,Ⅲ:3,Ⅳ:4,Ⅴ:5,Ⅵ:6,Ⅶ:7,Ⅷ:8,Ⅸ:9,Ⅹ:10,Ⅺ:11,Ⅻ:12,I:1,II:2,III:3,IV:4,V:5,VI:6,VII:7,VIII:8,IX:9,X:10,XI:11,XII:12};

function romanValue(token) {
  return ROMAN[token] || ROMAN[String(token || '').toUpperCase()] || null;
}

function trailingInstallment(text) {
  const marked = text.match(/^(.*?)后([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+|[ivx]{1,8}|\d{1,2})$/i);
  if (marked && marked[1].length >= 2) {
    const number = /^\d+$/.test(marked[2]) ? Number(marked[2]) : romanValue(marked[2]);
    if (number >= 1 && number <= 98) return { base: marked[1], season: number + 1, explicit: true };
  }
  const roman = text.match(/^(.*?)([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+)$/);
  if (roman && roman[1].length >= 2) {
    const number = romanValue(roman[2]);
    if (number >= 1 && number <= 99) return { base: roman[1], season: number, explicit: true };
  }
  const digit = text.match(/^(.*?)(\d{1,2})$/);
  if (digit && digit[1].length >= 2 && !/\d$/.test(digit[1])) {
    const number = Number(digit[2]);
    if (number >= 1 && number <= 99) return { base: digit[1], season: number, explicit: true };
  }
  return null;
}

function seasonNumber(value) {
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
  return Number.isSafeInteger(season) && season >= 1 ? season : 0;
}

// Sentence punctuation after a title ("…福布斯了！") is not part of the series name, and must not
// stop "…福布斯了第二季" from being recognised as the same series.
const TAIL = /[\s!?.,;:~·…。、！？，；：～_—-]+$/u;
const trimTail = text => text.replace(TAIL, '');
const PUNCTUATION = /[\s\p{P}\p{S}]+/gu;

function parseSeason(title) {
  const text = trimTail(canonicalTitle(title));
  // （第一季） keeps 第N季 inside the brackets. A bare （2024） is still not a season.
  const match = text.match(/^(.*?)(?:第([一二三四五六七八九十百零两兩\d]+)[季部]|[（(]\s*第([一二三四五六七八九十百零两兩\d]+)[季部]\s*[）)]|[（(]([一二三四五六七八九十百零两兩\d]+)[）)]|season(\d+))$/i);
  if (!match) return trailingInstallment(text) || { base: text, season: 1, explicit: false };
  const value = match[2] || match[3] || match[4] || match[5];
  const season = seasonNumber(value);
  // Bare bracket numbers above 99 are years or other title metadata, not seasons.
  if (match[4] && season > 99) return { base: text, season: 1, explicit: false };
  if (season < 1) return { base: text, season: 1, explicit: false, invalid: true };
  return { base: match[1], season, explicit: true };
}

// `key` ignores punctuation and symbols, so "名称：副标题" and "名称，副标题" name the same series.
export function seasonTitle(title) {
  const parsed = parseSeason(title);
  const base = trimTail(parsed.base);
  return { ...parsed, base, key: base.replace(PUNCTUATION, '') };
}

export function sourceOf(id) {
  if (/^\d{6,30}$/.test(id)) return 'hongguo';
  if (/^xifan:[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(id)) return 'xifan';
  if (/^hema:\d+$/.test(id)) return 'hema';
  return null;
}
