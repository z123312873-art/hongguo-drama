const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const root = path.join(__dirname, '../src');
const entries = {
  './components/useAccountSession': 'components/useAccountSession.js',
  './components/AccountChrome': 'components/AccountChrome.jsx',
  './waitingNotice.mjs': 'waitingNotice.mjs',
};

function createAppExtra(react) {
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const file = path.join(root, relative);
    const module = { exports: {} };
    const code = transformSync(fs.readFileSync(file, 'utf8'), {
      loader: file.endsWith('.jsx') ? 'jsx' : 'js',
      format: 'cjs',
    }).code;
    const req = (spec) => {
      if (spec === 'react') return react;
      if (!spec.startsWith('.')) return require(spec);
      const resolved = path.resolve(path.dirname(file), spec);
      const hit = [resolved, `${resolved}.js`, `${resolved}.mjs`, `${resolved}.jsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (!hit) throw new Error(`Cannot resolve ${spec} from ${relative}`);
      return load(path.relative(root, hit).split(path.sep).join('/'));
    };
    vm.runInNewContext(code, {
      module,
      exports: module.exports,
      require: req,
      console,
      setTimeout,
      clearTimeout,
      window: { addEventListener() {}, removeEventListener() {}, electronAPI: {} },
    });
    cache.set(relative, module.exports);
    return module.exports;
  }
  return (name) => (entries[name] ? load(entries[name]) : null);
}

module.exports = createAppExtra;
