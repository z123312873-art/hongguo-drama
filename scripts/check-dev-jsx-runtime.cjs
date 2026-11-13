const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const config = fs.readFileSync(path.resolve(__dirname, '..', 'vite.config.js'), 'utf8');

test('JSX runtime shims are recognised with both Windows and POSIX separators (dev blank-screen cycle)', () => {
  const match = config.match(/isScriptJsxFile = file => (\/.*\/)\.test/);
  assert.ok(match, 'vite.config.js exposes the shim path check');
  const re = new RegExp(match[1].slice(1, -1));
  for (const file of ['/src/script-jsx/jsx-dev-runtime.js', 'C:/p/src/script-jsx/jsx-runtime.js', 'C:\\p\\src\\script-jsx\\jsx-runtime.js']) assert.ok(re.test(file), file);
  for (const file of ['/src/components/App.jsx', 'C:\\p\\src\\script-jsxy\\a.js', '', undefined]) assert.ok(!re.test(file), String(file));
  assert.ok(!/path\.sep/.test(config), 'no separator-dependent comparison remains');
});

test('shims import the real React runtime, which the resolver must leave alone', () => {
  const dir = path.resolve(__dirname, '..', 'src', 'script-jsx');
  assert.match(fs.readFileSync(path.join(dir, 'jsx-dev-runtime.js'), 'utf8'), /from 'react\/jsx-dev-runtime'/);
  assert.match(fs.readFileSync(path.join(dir, 'jsx-runtime.js'), 'utf8'), /from 'react\/jsx-runtime'/);
});
