const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');
const slots = [];
let cursor = 0;
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
  },
  useRef: value => ({ current: value }), useCallback: fn => fn, useEffect() {}, useLayoutEffect() {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};
const context = { module: { exports: {} }, navigator: { platform: 'Mac' }, require: name => {
  if (name === 'react') return react;
  if (name.endsWith('useStealthWindow')) return () => ({ stealthMode: false, toggleStealth() {} });
  if (name.includes('scriptPreference')) return { getScriptPreference: () => 'hans', setScriptPreference() {}, subscribeScript: () => () => {} };
  return name;
} };
context.exports = context.module.exports;
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, context);
let tree;
const render = () => { cursor = 0; tree = context.module.exports.default(); };
const nodes = () => {
  const out = [];
  const visit = node => { if (!node || typeof node !== 'object') return; out.push(node); node.children?.forEach(visit); };
  visit(tree); return out;
};
const navigate = id => {
  const button = nodes().find(node => node.type === 'button' && node.props.key === id);
  assert(button, id); button.props.onClick(); render();
};
const players = () => nodes().filter(node => node.type === './components/Player');
render();
navigate('player'); assert.equal(players().length, 1);
for (const id of ['browse', 'download', 'history', 'calendar', 'manager', 'settings']) {
  navigate(id);
  assert.equal(players().length, 1, `${id} keeps the library player mounted`);
  assert.equal(players()[0].props.active, false);
}
navigate('player'); assert.equal(players().length, 1, 'returning to library keeps the same mounted player');
assert.equal(players()[0].props.active, true);
const labels = [];
(function visit(node) {
  if (!node || typeof node !== 'object') return;
  node.children?.forEach(child => { if (typeof child === 'string') labels.push(child); else visit(child); });
})(tree);
assert.equal(labels.includes('热播推荐'), false, '热播推荐 is no longer a navigation destination');
assert.ok(labels.includes('发现短剧'));
console.log('PASS navigation: library player stays mounted across pages, without a hot-feed destination');
