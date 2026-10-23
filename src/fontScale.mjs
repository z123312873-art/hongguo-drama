const STORAGE_KEY = 'hongguo-experience-preview:font-scale';
export const FONT_CHOICES = [
  { id: 'smaller', scale: 0.92, label: '较小' },
  { id: 'default', scale: 1, label: '默认' },
  { id: 'larger', scale: 1.08, label: '稍大' },
  { id: 'large', scale: 1.16, label: '大' },
  { id: 'largest', scale: 1.28, label: '更大' },
];

export function fontChoice(id) {
  return FONT_CHOICES.find(choice => choice.id === id) || FONT_CHOICES[1];
}

export function getFontChoice() {
  try {
    return fontChoice(globalThis.localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    return 'default';
  }
}

function applyFontChoice(id) {
  const choice = fontChoice(id);
  try { globalThis.document.documentElement.style.setProperty('--font-scale', String(choice.scale)); } catch { /* tests may have no document */ }
  return choice;
}

export function setFontChoice(id) {
  const choice = FONT_CHOICES.find(item => item.id === id);
  if (!choice) throw new Error('请选择列出的字号');
  globalThis.localStorage.setItem(STORAGE_KEY, choice.id);
  applyFontChoice(choice.id);
  return choice.id;
}

export function initializeFontScale() {
  applyFontChoice(getFontChoice());
}
