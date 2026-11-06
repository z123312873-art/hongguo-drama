// The Windows media build must ship the newer-codec tool without the AGPL configure flag.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'scripts/build-ffmpeg-source-win.sh'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const commit = 'a0fafc5c42dbd7fce25b141c071277fb016a65c5';
assert.match(script, new RegExp(commit));
assert.match(script, /cp ffmpeg\.exe "\$ROOT\/artifacts\/bin\/librempeg\.exe"/);
assert.match(script, /ffmpeg_deps="avcodec avfilter avformat threads agpl"/);
const invoked = script.split('\n').filter(line => /--enable-/.test(line) && !line.trim().startsWith('#') && !line.includes('was not used'));
assert.equal(invoked.some(line => line.includes('--enable-agpl')), false, invoked.filter(line => line.includes('agpl')).join('\n'));
const [ffmpegPart, librempegPart] = script.split('# librempeg decodes');
assert.match(ffmpegPart, /--disable-x86asm/);
assert.equal(librempegPart.includes('--disable-x86asm'), false);
assert.match(fs.readFileSync(path.join(root, '.github/workflows/windows.yml'), 'utf8'), /\bnasm\b/);
const filters = pkg.build.win.extraResources[0].filter;
assert.ok(filters.includes('librempeg.exe'));
assert.equal(pkg.version, '4.5.0');
console.log('PASS librempeg build stays on the pinned commit without the AGPL flag');
