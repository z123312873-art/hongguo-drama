

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const result = spawnSync(process.execPath, [vite, 'build', '--logLevel', 'error'], {
  cwd: root,
  stdio: 'inherit',
});
assert.equal(result.status, 0, 'The installer page must build');

const assets = path.join(root, 'dist-react', 'assets');
const built = fs.readdirSync(assets).map(name => fs.readFileSync(path.join(assets, name), 'utf8')).join('\n');
for (const needle of ["尚未登入", "紅果立即登入", "帳號登出", "臺灣", '中国', 'is-out']) {
  assert.ok(built.includes(needle), `installer page is missing ${needle}`);
}
const css = fs.readFileSync(path.join(root, 'src', 'index.css'), 'utf8');
assert.match(css, /\.account-strip\.is-out[^{]*\{[^}]*background:\s*transparent/);
console.log('PASS renderer build includes login, region names, and the signed-out row');
