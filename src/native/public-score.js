'use strict';

// Category lists do not carry a public score. Rank cards use scoreText ("评分9.4").
// Detail pages print the same 0–10 score in the hero, then again as seriesSocialInfo.rating.
// That rating may follow nested fields such as hot_score_data. hot_score_data itself is heat
// ("6063万热度"), and ratings inside reviews belong to one comment, not the series.

function normalizeScore(raw) {
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0 || number > 10) return null;
  return Math.round(number * 10) / 10;
}

const HERO_SCORE = /评分(?:<!--\s*-->|\s)*(\d+(?:\.\d+)?)(?![\d.])/;
// The series rating, when the page has one, sits in the head of seriesSocialInfo.
// Walking the whole review list would keep a no-score page open until the document ends.
const SERIES_HEADER_LIMIT = 16 * 1024;

function readSeriesRating(text) {
  const marker = '"seriesSocialInfo"';
  const at = text.indexOf(marker);
  if (at < 0) return null;
  let i = at + marker.length;
  while (i < text.length && text[i] <= ' ') i += 1;
  if (i >= text.length) return { open: true };
  if (text[i] !== ':') return null;
  i += 1;
  while (i < text.length && text[i] <= ' ') i += 1;
  if (i >= text.length) return { open: true };
  if (text[i] !== '{') return null;
  const origin = i;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let p = i; p < text.length; p += 1) {
    const char = text[p];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      if (depth === 1 && text.startsWith('"rating"', p)) {
        let q = p + 8;
        while (q < text.length && text[q] <= ' ') q += 1;
        if (q >= text.length) return { open: true };
        if (text[q] !== ':') {
          quoted = true;
          continue;
        }
        q += 1;
        while (q < text.length && text[q] <= ' ') q += 1;
        if (q >= text.length) return { open: true };
        const quotedValue = text[q] === '"';
        if (quotedValue) q += 1;
        const match = /^(-?\d+(?:\.\d+)?)(?![\d.])/.exec(text.slice(q));
        if (!match) return { open: q >= text.length - 1 };
        const end = q + match[0].length;
        const value = normalizeScore(match[1]);
        if (end >= text.length) return { value, open: true };
        if (quotedValue && text[end] !== '"') return value == null ? { absent: true } : { value };
        if (value == null) return { absent: true };
        return { value };
      }
      quoted = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { absent: true };
    }
    if (depth >= 1 && p - origin >= SERIES_HEADER_LIMIT) return { absent: true };
  }
  return { open: true };
}

function publicScoreMatch(html) {
  const text = String(html || '');
  const hero = HERO_SCORE.exec(text);
  if (hero) {
    const value = normalizeScore(hero[1]);
    const open = hero.index + hero[0].length === text.length;
    if (value != null) return { value, open };
    if (open) return { open: true };
  }
  const series = readSeriesRating(text);
  if (!series || series.absent) return null;
  if (series.open) return { value: series.value, open: true };
  if (series.value == null) return null;
  return { value: series.value, open: false };
}

function readPublicScore(html, options = {}) {
  const found = publicScoreMatch(html);
  if (!found) return null;
  if (options.partial && found.open) return null;
  return found.value ?? null;
}

module.exports = { readPublicScore, normalizeScore };
