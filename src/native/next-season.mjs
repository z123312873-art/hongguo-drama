import { canonicalTitle } from '../chineseScript.mjs';
import { seasonTitle, sourceOf } from './season-title.mjs';

export const COUNTDOWN_SECONDS = 5;

export function seasonFinaleIndex(episodes) {
  let max = 0;
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    const index = Number(episode?.vid_index);
    if (Number.isSafeInteger(index) && index > max) max = index;
  }
  return max;
}

function safeCover(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function chineseSeason(season) {
  const digits = '零一二三四五六七八九';
  if (season < 10) return digits[season];
  return `${season < 20 ? '' : digits[Math.floor(season / 10)]}十${season % 10 ? digits[season % 10] : ''}`;
}

// Only the immediately following season. Season 1 never selects season 5 when season 2 is missing.
export function immediateNextSeason(series, candidates) {
  const current = seasonTitle(series?.series_title);
  const source = sourceOf(String(series?.series_id || ''));
  if (!current.base || current.invalid || !source || !Number.isInteger(current.season) || current.season < 1 || current.season >= 99) return null;
  const target = current.season + 1;
  const exact = new Set([
    canonicalTitle(`${current.base}第${target}季`),
    canonicalTitle(`${current.base}第${chineseSeason(target)}季`),
    canonicalTitle(`${current.base}第${target}部`),
    canonicalTitle(`${current.base}第${chineseSeason(target)}部`),
  ]);
  const matches = [];
  const seen = new Set([String(series.series_id)]);
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const id = String(candidate?.series_id || '');
    const next = seasonTitle(candidate?.series_title);
    if (!id || seen.has(id) || sourceOf(id) !== source || !next.explicit || next.invalid) continue;
    if (next.base !== current.base || next.season !== target) continue;
    seen.add(id);
    matches.push(candidate);
  }
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const aExact = exact.has(canonicalTitle(a.series_title)) ? 0 : 1;
    const bExact = exact.has(canonicalTitle(b.series_title)) ? 0 : 1;
    return aExact - bExact || String(a.series_id).localeCompare(String(b.series_id));
  });
  const chosen = matches[0];
  return {
    series_id: String(chosen.series_id),
    series_title: String(chosen.series_title),
    cover: safeCover(chosen.cover),
    season: target,
    seconds: COUNTDOWN_SECONDS,
  };
}
