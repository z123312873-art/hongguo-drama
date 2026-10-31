// Run: node scripts/check-cover-image.cjs. Renders CoverImage with in-memory hooks; no browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const load = (file, extra = {}) => {
  const resolved = path.join(__dirname, '..', file);
  const code = transformSync(fs.readFileSync(resolved, 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, URL, require: spec => extra[spec] || require(spec) });
  return module.exports;
};

function mountCover(initialProps) {
  const slots = [], effects = [];
  let cursor = 0, props = initialProps, tree, queued = false;
  const changed = (old, deps) => !old || deps.some((dep, i) => !Object.is(dep, old[i]));
  const react = {
    createElement: (type, p, ...children) => ({ type, props: p || {}, children: children.flat(Infinity) }),
    useState: initial => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; queued = true; } }];
    },
    useEffect: (fn, deps) => { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(fn); } },
  };
  const coverFallback = load('src/coverFallback.mjs');
  const CoverImage = load('src/components/CoverImage.jsx', { react, './icons': { Film: () => null }, '../coverFallback.mjs': coverFallback }).default;
  const render = () => {
    let guard = 0;
    do { queued = false; cursor = 0; tree = CoverImage(props); effects.splice(0).forEach(fn => fn()); } while (queued && ++guard < 10);
    return tree;
  };
  render();
  return { render, current: () => tree, setProps: next => { props = next; render(); } };
}

const hosted = 'https://p3-reading-sign.fqnovelpic.com/novel-pic/abc~tplv-x:400:0.heic?lk3s=1';
const plain = 'https://p3-novel.byteimg.com/novel-pic/abc~tplv-shrink:640:0.image';

let ui = mountCover({ src: hosted, alt: '甲剧' });
assert.equal(ui.current().type, 'img');
assert.equal(ui.current().props.src, hosted, 'the source URL is tried first');
ui.current().props.onError(); ui.render();
assert.equal(ui.current().type, 'img');
assert.equal(ui.current().props.src, plain, 'a failed image retries the plain rendition');
assert.equal(ui.current().props.alt, '甲剧');
ui.current().props.onError(); ui.render();
assert.equal(ui.current().props.className, 'cover-placeholder', 'exhausted candidates show the placeholder, never a broken image');
ui.setProps({ src: 'https://img.example/next.jpg', alt: '乙剧' });
assert.equal(ui.current().type, 'img', 'a new poster starts over after an earlier failure');
assert.equal(ui.current().props.src, 'https://img.example/next.jpg');

for (const src of ['', undefined, null, 'javascript:alert(1)']) {
  ui = mountCover({ src, alt: 'x' });
  assert.equal(ui.current().props.className, 'cover-placeholder', `unusable cover ${String(src)} shows the placeholder`);
}
ui = mountCover({ src: 'https://img.example/only.jpg', alt: 'x' });
ui.current().props.onError(); ui.render();
assert.equal(ui.current().props.className, 'cover-placeholder', 'a poster without an alternative falls back after one failure');
console.log('PASS cover image: source first, plain rendition retry, placeholder, reset on new poster, unusable values');
