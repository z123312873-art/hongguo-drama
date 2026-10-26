// The installed app loads the main process from app.asar. Node's ESM loader
// cannot resolve imports inside that archive, so startup must stay on require().
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packaged = require(path.join(root, 'package.json')).build.files;
const roots = ['main.js', 'preload.js'];

function packagedFile(relative) {
  const normalized = relative.split(path.sep).join('/');
  return packaged.some((pattern) => {
    if (pattern.endsWith('/**/*')) return normalized.startsWith(pattern.slice(0, -5));
    return normalized === pattern;
  });
}

function resolveRequired(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...['.js', '.cjs', '.json', '.mjs'].map((ext) => base + ext)];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

const seen = new Set();
const failures = [];
function walk(file) {
  const relative = path.relative(root, file);
  if (seen.has(relative)) return;
  seen.add(relative);
  if (relative !== 'package.json' && !packagedFile(relative)) failures.push(`${relative} is required at startup but is not in the installer file list`);
  if (file.endsWith('.mjs')) failures.push(`${relative} is ESM; the packaged main process cannot import it from app.asar`);
  const source = fs.readFileSync(file, 'utf8');
  if (/^\s*import\s/m.test(source) || /^\s*export\s/m.test(source)) failures.push(`${relative} contains an ESM import`);
  for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = resolveRequired(file, match[1]);
    if (!target) failures.push(`${relative} requires missing ${match[1]}`);
    else walk(target);
  }
}

for (const name of roots) walk(path.join(root, name));
assert.deepEqual(failures, [], failures.join('\n'));
assert.ok(seen.has('src/native/watch-history.js'));
assert.ok(seen.has('src/native/season-title.js'));
assert.ok(![...seen].some((file) => file.endsWith('.mjs')));
console.log(`PASS packaged main process: ${seen.size} CommonJS files, no ESM imports inside app.asar`);
