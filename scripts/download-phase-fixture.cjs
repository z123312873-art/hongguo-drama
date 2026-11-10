const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const fixture = { exports: {} };
const code = transformSync(fs.readFileSync(path.join(__dirname, '../src/downloadPhase.mjs'), 'utf8'), { format: 'cjs' }).code;
vm.runInNewContext(code, { module: fixture, exports: fixture.exports });
module.exports = fixture.exports;
