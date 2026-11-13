const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const load = () => import(path.join(__dirname, 'vite-dev-cjs.mjs'));

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'native' ? [] : walk(full);
  return /\.(jsx?|mjs)$/.test(entry.name) && !/check-|\.test\./.test(entry.name) ? [full] : [];
});

function nativeCjsReachableFromRenderer() {
  const found = new Set();
  const visit = (file) => {
    const code = fs.readFileSync(file, 'utf8');
    const specs = [...code.matchAll(/(?:from\s+|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map(match => match[1]);
    for (const spec of specs) {
      const base = path.resolve(path.dirname(file), spec);
      const target = [base, `${base}.js`].find(item => /[/\\]src[/\\]native[/\\][^/\\]+\.js$/.test(item) && fs.existsSync(item) && fs.statSync(item).isFile());
      if (!target || found.has(target)) continue;
      if (!/\bmodule\.exports\b/.test(fs.readFileSync(target, 'utf8'))) continue;
      found.add(target);
      visit(target);
    }
  };
  walk(path.join(root, 'src')).forEach(visit);
  return [...found];
}

test('exportedNames reads shorthand and aliased names and ignores comments and spreads', async () => {
  const { exportedNames } = await load();
  assert.deepEqual(exportedNames('module.exports = { a, b, c: d, ...rest, // note\n  e,\n};'), ['a', 'b', 'c', 'e']);
  assert.deepEqual(exportedNames('module.exports = {};'), []);
  assert.deepEqual(exportedNames('const x = 1;'), []);
  assert.deepEqual(exportedNames('module.exports = { a, a };'), ['a']);
});

test('only renderer-reachable CommonJS under src/native is converted, never main-process code or other files', async () => {
  const { isRendererCjs } = await load();
  assert.equal(isRendererCjs('/p/src/native/folder-rules.js', 'module.exports = { a };'), true);
  assert.equal(isRendererCjs('C:\\p\\src\\native\\folder-rules.js?v=1', 'module.exports = { a };'), true);
  assert.equal(isRendererCjs('/p/src/native/next-season.mjs', 'module.exports = { a };'), false);
  assert.equal(isRendererCjs('/p/src/native/plain.js', 'export const a = 1;'), false);
  assert.equal(isRendererCjs('/p/src/components/x.js', 'module.exports = { a };'), false);
  assert.equal(isRendererCjs('/p/node_modules/x/src/native/y.js', 'const a = 1;'), false);
});

test('every CommonJS module the renderer reaches converts to ESM with the same exports (dev mode no longer opens blank)', async () => {
  const { cjsToEsm, isRendererCjs } = await load();
  const modules = nativeCjsReachableFromRenderer();
  const names = modules.map(file => path.basename(file));
  for (const expected of ['folder-rules.js', 'account-profile.js', 'account-session.js']) assert.ok(names.includes(expected), `${expected} is reached from the renderer`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-cjs-'));
  try {
    for (const file of modules) {
      const code = fs.readFileSync(file, 'utf8');
      assert.ok(isRendererCjs(file, code), `${path.basename(file)} is selected for conversion`);
      const esm = cjsToEsm(code);
      assert.ok(!/\brequire\(/.test(esm.replace(/\/\/[^\n]*/g, '')), `${path.basename(file)} keeps no require() call`);
      fs.writeFileSync(path.join(dir, path.basename(file, '.js') + '.mjs'), esm.replace(/from "(\.[^"]+)"/g, (_m, spec) => `from "${spec}.mjs"`));
    }
    for (const file of modules) {
      const expected = require(file);
      const actual = await import(path.join(dir, path.basename(file, '.js') + '.mjs'));
      const exported = Object.keys(actual).filter(key => key !== 'default').sort();
      assert.deepEqual(exported, Object.keys(expected).sort(), `${path.basename(file)} exposes every name as a named export`);
      assert.deepEqual(Object.keys(actual.default).sort(), Object.keys(expected).sort(), `${path.basename(file)} default export is the whole module`);
      for (const key of exported) {
        assert.equal(typeof actual[key], typeof expected[key], `${path.basename(file)}.${key} keeps its type`);
        if (typeof expected[key] !== 'function') assert.deepEqual(actual[key], expected[key]);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the conversion is development-only and wired into the Vite config', async () => {
  const { developmentCjs } = await load();
  const plugin = developmentCjs();
  assert.equal(plugin.apply, 'serve', 'production builds keep using the CommonJS plugin');
  assert.equal(plugin.enforce, 'pre');
  assert.equal(plugin.transform('const a = 1;', '/p/src/components/x.js'), null);
  assert.equal(plugin.transform('export const a = 1;', '/p/src/native/y.js'), null);
  assert.match(plugin.transform('module.exports = { a };', '/p/src/native/y.js').code, /export default module\.exports/);
  const config = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');
  assert.match(config, /import \{ developmentCjs \} from '\.\/scripts\/vite-dev-cjs\.mjs'/);
  assert.match(config, /plugins: \[[^\]]*developmentCjs\(\)/);
  assert.match(config, /commonjsOptions/, 'the production CommonJS handling stays');
});
