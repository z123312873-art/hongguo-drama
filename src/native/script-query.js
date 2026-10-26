// Main-process converter. Keep this CommonJS: Electron's asar package cannot
// resolve ESM imports, and chineseScript.mjs is not shipped outside the renderer bundle.
const OpenCC = require('opencc-js/t2cn');

const toSimplifiedRaw = OpenCC.Converter({ from: 'twp', to: 'cn' });
const HAN = /[\u3400-\u9fff]/;

function toSimplified(value) {
  const text = String(value ?? '');
  if (!text || !HAN.test(text)) return text;
  try { return toSimplifiedRaw(text); }
  catch { return text; }
}

function canonicalTitle(value) {
  return toSimplified(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

module.exports = { toSimplified, canonicalTitle };
