// Display conversion is traditional-only. Search matching uses a separate simplified key
// and never rewrites the typed query, filenames, or stored titles.
import * as OpenCC from 'opencc-js/cn2t';
import * as OpenCCToSimplified from 'opencc-js/t2cn';

const converter = OpenCC.Converter({ from: 'cn', to: 'twp' });
const toSimplifiedRaw = OpenCCToSimplified.Converter({ from: 'twp', to: 'cn' });
const cache = new Map();
const HAN = /[\u3400-\u9fff]/;

// OpenCC maps 质量 to 質量 (mass). In this app the word means media quality.
function protectSenses(text) {
  return text.includes('质量') ? text.replaceAll('质量', '品質') : text;
}

export function toSimplified(value) {
  const text = String(value ?? '');
  if (!text || !HAN.test(text)) return text;
  try { return toSimplifiedRaw(text); }
  catch { return text; }
}

// One comparison key for simplified and traditional titles.
export function canonicalTitle(value) {
  return toSimplified(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export function toTraditional(value) {
  if (typeof value !== 'string' || !value || !HAN.test(value)) return value;
  const cached = cache.get(value);
  if (cached !== undefined) return cached;
  const converted = converter(protectSenses(value));
  cache.set(value, converted);
  if (cache.size > 4000) cache.delete(cache.keys().next().value);
  return converted;
}

// Keeps an existing simplified match, then adds a traditional-display match.
// Never rewrites the caller's query.
export function matchesText(haystack, needle) {
  const text = typeof haystack === 'string' ? haystack : '';
  const query = typeof needle === 'string' ? needle.trim() : '';
  if (!query) return true;
  if (text.includes(query)) return true;
  return toTraditional(text).includes(toTraditional(query));
}
