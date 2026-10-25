const assert = require('node:assert/strict');
const { fitWindowBounds, getWindowScale, saveWindowZoom } = require('../src/native/window-layout');
const screen = { x: 0, y: 25, width: 1440, height: 850 };
const current = { x: 100, y: 100, width: 1100, height: 750 };
const portrait = fitWindowBounds('portrait', current, screen);
assert(portrait.height > portrait.width);
assert.equal(portrait.width, 620);
assert(portrait.y >= screen.y && portrait.y + portrait.height <= 875);
assert.deepEqual(fitWindowBounds('landscape', current, screen, current), current);
const secondary = { x: -1024, y: 0, width: 1024, height: 700 };
const moved = fitWindowBounds('landscape', portrait, secondary, current);
assert(moved.x >= -1024 && moved.x + moved.width <= 0);
assert(moved.height <= 700);
const small = fitWindowBounds('portrait', current, { x: 0, y: 0, width: 800, height: 600 });
assert(small.width < small.height && small.height <= 600);
assert.throws(() => fitWindowBounds('invalid', current, screen), /Invalid/);
assert.equal(getWindowScale(), 1, 'default font size is independent of window width');
assert.equal(getWindowScale(0.8), 0.8, 'only the user preference controls zoom');
for (const invalid of [undefined, null, '0.8', NaN, Infinity]) assert.equal(getWindowScale(invalid), 1);
assert.equal(getWindowScale(0.1), 0.5);
assert.equal(getWindowScale(10), 2);
let saved = { download_quality: '720p', custom_sources: [{ id: 'kept' }] };
const store = { getSettings: () => saved, saveSettings: value => { saved = value; } };
saveWindowZoom(store, 'out');
assert.equal(saved.ui_zoom, 0.9);
assert.equal(saved.download_quality, '720p');
assert.deepEqual(saved.custom_sources, [{ id: 'kept' }]);
assert.equal(getWindowScale(store.getSettings().ui_zoom), 0.9, 'new window restores the saved preference');
saved = { ...saved, max_concurrent: 4 };
saveWindowZoom(store, 'in');
assert.equal(saved.ui_zoom, 1);
assert.equal(saved.max_concurrent, 4, 'zoom merges the latest options');
saveWindowZoom(store, 'out');
saveWindowZoom(store, 'reset');
assert.equal(saved.ui_zoom, 1);
const beforeFailure = saved;
assert.throws(() => saveWindowZoom({ ...store, saveSettings() { throw Error('disk full'); } }, 'out'), /disk full/);
assert.equal(saved, beforeFailure, 'failed zoom save does not mutate existing settings');
assert.throws(() => saveWindowZoom(store, 'invalid'), /Invalid/);
console.log('PASS window layout: portrait, round trip, moved display, small display, invalid mode');
console.log('PASS font size uses only the saved user zoom preference');
console.log('PASS user zoom: activation, resize/fullscreen, layout, reload, latest-setting merge, bounds, reset and save failure');

const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const sourceRoot = path.join(__dirname, '../src');
for (const file of fs.readdirSync(sourceRoot, { recursive: true }).filter(file => file.endsWith('.css'))) {
  const css = postcss.parse(fs.readFileSync(path.join(sourceRoot, file), 'utf8'));
  const declarations = [];
  css.walkDecls(/^(font|font-size)$/, declaration => declarations.push(declaration));
  declarations.forEach(declaration => {
    assert(!/\b[\d.]+(?:[sld]?v[whib]|[sld]?vmin|[sld]?vmax|cq[whib]|cqmin|cqmax)\b/.test(declaration.value), `${file}: font size must not follow viewport dimensions`);
    for (let parent = declaration.parent; parent; parent = parent.parent) {
      assert(!(parent.type === 'atrule' && parent.name === 'media' && /(?:width|height|orientation)/.test(parent.params)), `${file}: responsive layout must preserve font size`);
    }
  });
}
console.log('PASS responsive CSS preserves font sizes across window dimensions');
