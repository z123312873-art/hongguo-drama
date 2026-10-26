// Query and title matching only. Display text stays on the renderer converter.
const OpenCC = require('opencc-js/t2cn');

const toSimplifiedRaw = OpenCC.Converter({ from: 'twp', to: 'cn' });

function toSimplified(value) {
  const text = String(value ?? '');
  if (!text || !/[\u3400-\u9fff]/.test(text)) return text;
  try { return toSimplifiedRaw(text); }
  catch { return text; }
}

// One key for simplified and traditional titles. Does not rewrite stored names.
function canonicalTitle(value) {
  return toSimplified(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

module.exports = { toSimplified, canonicalTitle };
