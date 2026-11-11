
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/shortcuts.js'), 'utf8');
  const shortcuts = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const { DEFAULT_SHORTCUTS, SHORTCUT_STORAGE_KEY, formatShortcut, ignoresPlaybackShortcut, readShortcuts, saveShortcuts, shortcutKey, subscribeShortcuts, validateShortcuts } = shortcuts;
  const storage = new Map();
  global.window = new EventTarget();
  window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  assert.deepEqual(readShortcuts(), DEFAULT_SHORTCUTS);
  assert.equal(validateShortcuts(DEFAULT_SHORTCUTS), '');
  assert.equal(shortcutKey({ key: ' ', code: 'Space' }), 'space');
  assert.equal(shortcutKey({ key: 'J', code: 'KeyJ', shiftKey: true }), 'shift+j');
  assert.equal(formatShortcut('shift+arrowright'), 'Shift + →');
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'isComposing']) {
    assert.equal(shortcutKey({ key: 'f', code: 'KeyF', [modifier]: true }), null);
  }
  for (const key of ['Escape', 'Tab', 'Enter', 'Backspace', 'F5', 'Meta']) assert.equal(shortcutKey({ key }), null);
  assert.equal(shortcutKey({ key: ' ', code: 'Space', shiftKey: true }), null);
  assert.match(validateShortcuts({ ...DEFAULT_SHORTCUTS, play: 'a' }), /冲突/);
  assert.match(validateShortcuts({ ...DEFAULT_SHORTCUTS, play: 'ctrl+p' }), /不可用/);
  let observed;
  const stop = subscribeShortcuts(value => { observed = value; });
  const custom = { ...DEFAULT_SHORTCUTS, play: 'shift+j' };
  saveShortcuts(custom);
  assert.deepEqual(readShortcuts(), custom);
  assert.deepEqual(observed, custom, 'same-window changes notify the mounted player');
  assert.throws(() => saveShortcuts({ ...custom, next: 'shift+j' }), /冲突/);
  assert.deepEqual(readShortcuts(), custom, 'rejected binding must not replace saved preferences');
  saveShortcuts({ ...DEFAULT_SHORTCUTS });
  assert.deepEqual(observed, DEFAULT_SHORTCUTS);
  stop();
  storage.set(SHORTCUT_STORAGE_KEY, '{broken');
  assert.deepEqual(readShortcuts(), DEFAULT_SHORTCUTS);
  storage.set(SHORTCUT_STORAGE_KEY, JSON.stringify({ ...custom, next: 'shift+j' }));
  assert.deepEqual(readShortcuts(), DEFAULT_SHORTCUTS, 'damaged maps restore together, without partial-map conflicts');
  assert.equal(ignoresPlaybackShortcut({ isContentEditable: true }), true);
  for (const selector of ['input', 'textarea', 'select', '[data-shortcut-settings]', '[role="dialog"]']) {
    assert.equal(ignoresPlaybackShortcut({ closest: query => query.split(', ').includes(selector) ? {} : null }), true, selector);
  }
  assert.equal(ignoresPlaybackShortcut({ closest: query => query === 'button, a' ? {} : null }), true, 'outside-player buttons retain keyboard activation');
  assert.equal(ignoresPlaybackShortcut({ closest: () => null }), false);
  console.log('PASS preview shortcuts: defaults, recording keys, conflicts, persistence, live updates, reset, input boundaries');
})().catch(error => { console.error(error); process.exitCode = 1; });
