const STORAGE_KEY = 'hongguo-experience-preview:script';
const SCRIPTS = ['hans', 'hant'];
let current = 'hans';
const listeners = new Set();

function readStored() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return SCRIPTS.includes(stored) ? stored : 'hans';
  } catch {
    return 'hans';
  }
}

function applyScript(script) {
  current = script;
  try {
    document.documentElement.lang = script === 'hant' ? 'zh-Hant' : 'zh-Hans';
    document.documentElement.dataset.script = script;
  } catch { /* preference still works without a document */ }
  listeners.forEach((listener) => listener(script));
}

export function getScriptPreference() {
  return current;
}

export function isTraditional() {
  return current === 'hant';
}

export function subscribeScript(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setScriptPreference(script) {
  if (!SCRIPTS.includes(script)) throw new Error('请选择简体中文或繁体中文');
  if (script === current && readStored() === script) return;
  localStorage.setItem(STORAGE_KEY, script);
  applyScript(script);
}

export function initializeScript() {
  applyScript(readStored());
}
