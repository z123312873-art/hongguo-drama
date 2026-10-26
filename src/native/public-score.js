'use strict';

// Category lists do not carry a public score. Rank cards use scoreText ("评分9.4").
// Detail pages print the same 0–10 score in the hero, then again as seriesSocialInfo.rating.
// hot_score_data is heat (for example "6063万热度"), not this score.

function normalizeScore(raw) {
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0 || number > 10) return null;
  return Math.round(number * 10) / 10;
}

const SCORE_PATTERNS = [
  /评分(?:<!--\s*-->|\s)*(\d+(?:\.\d+)?)(?![\d.])/,
  /"seriesSocialInfo"\s*:\s*\{[^{}]{0,600}?"rating"\s*:\s*(-?\d+(?:\.\d+)?)(?![\d.])/,
];

function publicScoreMatch(html) {
  const text = String(html || '');
  for (const pattern of SCORE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = normalizeScore(match[1]);
    if (value == null) continue;
    return { value, open: match.index + match[0].length === text.length };
  }
  return null;
}

function readPublicScore(html, options = {}) {
  const found = publicScoreMatch(html);
  if (!found) return null;
  if (options.partial && found.open) return null;
  return found.value;
}

module.exports = { readPublicScore, normalizeScore };
