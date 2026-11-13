
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const load = (file, extra = {}) => {
  const resolved = path.join(__dirname, '..', file);
  const code = transformSync(fs.readFileSync(resolved, 'utf8'), { loader: file.endsWith('.jsx') ? 'jsx' : 'js', format: 'cjs' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, URL, require: spec => extra[spec] || require(spec), ...(extra.__globals || {}) });
  return module.exports;
};

function mountCover(initialProps, globals) {
  const slots = [], effects = [], cleanups = [];
  let cursor = 0, props = initialProps, tree, queued = false;
  const changed = (old, deps) => !old || deps.some((dep, i) => !Object.is(dep, old[i]));
  const react = {
    createElement: (type, p, ...children) => ({ type, props: p || {}, children: children.flat(Infinity) }),
    useState: initial => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; queued = true; } }];
    },
    useEffect: (fn, deps) => { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const coverFallback = load('src/coverFallback.mjs');
  const CoverImage = load('src/components/CoverImage.jsx', { react, './icons': { Film: () => null }, '../coverFallback.mjs': coverFallback, __globals: globals }).default;
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
ui = mountCover({ src: hosted, alt: 'x' });
assert.equal(ui.current().props.loading, 'lazy', 'posters stay lazy unless a caller asks otherwise');
assert.equal(ui.current().props.fetchpriority, undefined);
ui = mountCover({ src: hosted, alt: 'x', eager: true });
assert.equal(ui.current().props.loading, 'eager');
assert.equal(ui.current().props.fetchpriority, 'high');
assert.equal(ui.current().props.decoding, 'async');

const timers = [], probes = [];
const globals = {
  setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
  clearTimeout: id => { if (timers[id - 1]) timers[id - 1].live = false; },
  Image: class { constructor() { probes.push(this); } },
};
const run = () => timers.filter(timer => timer.live).forEach(timer => { timer.live = false; timer.fn(); });
ui = mountCover({ src: hosted, alt: 'slow' }, globals);
assert.equal(timers.length, 1);
assert.ok(timers[0].ms > 0 && timers[0].ms <= 1000, 'a slow poster gets a head start of well under a second before the alternative is tried');
assert.equal(probes.length, 0, 'the alternative is not requested while the first choice may still be quick');
run();
assert.equal(probes.length, 1);
assert.equal(probes[0].src, plain, 'the alternative loads in the background');
assert.equal(ui.current().props.src, hosted, 'the first choice stays on screen until something better is ready');
probes[0].onload(); ui.render();
assert.equal(ui.current().props.src, plain, 'whichever rendition arrives first is shown');
ui.current().props.onError(); ui.render();
assert.equal(ui.current().props.className, 'cover-placeholder', 'no candidates left after the alternative also fails');

timers.length = 0; probes.length = 0;
ui = mountCover({ src: hosted, alt: 'fast' }, globals);
ui.current().props.onLoad(); ui.render();
run();
assert.equal(probes.length, 0, 'a poster that already loaded never triggers a second download');
assert.equal(ui.current().props.src, hosted);

timers.length = 0; probes.length = 0;
ui = mountCover({ src: hosted, alt: 'late' }, globals);
run();
ui.current().props.onError(); ui.render();
const stale = probes[0].onload;
assert.equal(ui.current().props.src, plain, 'an error moves on at once without waiting for the background load');
if (stale) stale();
ui.render();
assert.equal(ui.current().props.src, plain, 'a background load that finishes late cannot skip past the poster now shown');

timers.length = 0; probes.length = 0;
ui = mountCover({ src: 'https://img.example/only.jpg', alt: 'single' }, globals);
assert.equal(timers.length, 0, 'nothing to fall back to: no timer');
ui = mountCover({ src: hosted, alt: 'swap' }, globals);
ui.setProps({ src: 'https://img.example/next.jpg', alt: 'swap' });
run();
assert.equal(probes.length, 0, 'changing the poster cancels the pending alternative for the old one');

console.log('PASS cover image: source first, plain rendition retry, placeholder, reset on new poster, unusable values');
