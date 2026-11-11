import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
const stealth = readFileSync(new URL('../StealthWindow.css', import.meta.url), 'utf8');

function sidebarWidth(viewport) {
  if (viewport <= 760) return 164;
  if (viewport <= 1060) return 190;
  return 214;
}

function buttonWidth(scale) {
  return 6 * 12 * scale + 26;
}

for (const viewport of [1280, 1920, 2560, 3840]) {
  const sidebar = sidebarWidth(viewport);
  assert.equal(sidebar, 214, `${viewport} keeps the sidebar width`);
  for (const scale of [0.92, 1, 1.08, 1.16, 1.28]) {
    assert.ok(buttonWidth(scale) <= sidebar - 24, `${viewport} font ${scale} login label fits`);
  }
}
assert.ok(buttonWidth(1.28) <= 164 - 24, 'largest type still fits the narrow sidebar');

assert.match(css, /\.sidebar \{[^}]*width:\s*214px/);
assert.match(css, /max-width:\s*1060px\)[\s\S]*\.sidebar \{[^}]*width:\s*190px/);
assert.match(css, /max-width:\s*760px\)[\s\S]*\.sidebar \{[^}]*width:\s*164px/);
assert.doesNotMatch(css, /@media\s*\(\s*min-width:\s*(?:1280|1920|2560|3840)px\)/);
assert.match(css, /\.account-name \{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/s);

assert.match(css, /\.account-strip \{[^}]*background:\s*transparent/s);
assert.doesNotMatch(css, /\.account-strip(?![-\w.])[^{,]*\{[^}]*background:\s*var\(--bg-elevated\)/s);
assert.match(css, /\.account-avatar \{[^}]*flex:\s*0 0 calc\(32px \* var\(--font-scale, 1\)\)/s);
assert.match(css, /\.account-name \{[^}]*flex:\s*1\.35 1 0/s);
assert.match(css, /\.sidebar-menu \{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
assert.match(css, /\.account-dialog \{[^}]*width:\s*min\(420px,\s*100%\)[^}]*max-height:\s*min\(640px,\s*calc\(100vh - 48px\)\)/s);
assert.match(css, /\.compact-account \{[^}]*display:\s*none/s);
assert.match(css, /\.layout-portrait \.compact-account \{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s);
assert.match(stealth, /\.stealth-mode \.compact-account/);
assert.match(stealth, /\.stealth-mode \.account-dialog-mask/);

console.log('PASS account sidebar fits 1K, 2K, and 4K');
