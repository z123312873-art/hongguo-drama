const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
require('app-builder-lib');
const { PlatformPackager } = require('app-builder-lib/out/platformPackager');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

(async () => {
  const resources = path.resolve(root, pkg.build.directories.buildResources);
  assert.equal(resources, path.join(root, 'build'));
  assert.equal(pkg.build.directories.output, 'dist');
  assert.match(fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8'), /outDir:\s*'dist-react'/);
  const context = { info: { buildResourcesDir: resources }, projectDir: root, resourceList: Promise.resolve(fs.readdirSync(resources)) };
  const original = await PlatformPackager.prototype.getResource.call(context, undefined, 'installer.nsh');
  const explicit = await PlatformPackager.prototype.getResource.call(context, pkg.build.nsis.include, 'installer.nsh');
  assert.equal(explicit, original);
  assert.equal(explicit, path.join(resources, 'installer.nsh'));
  const installer = fs.readFileSync(explicit, 'utf8');
  assert.match(installer, /!macro preInit/);
  assert.match(installer, /!macro customPageAfterChangeDir/);
  assert.match(installer, /Call instFilesPre/);
  for (const target of [pkg.build.win, pkg.build.mac]) {
    const icon = path.resolve(root, target.icon);
    assert.equal(fs.readFileSync(icon).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.ok(pkg.build.win.extraResources.some(row => row.from === 'build/ffmpeg' && row.filter.includes('COPYING.*')));
  assert.ok(pkg.build.mac.extraResources.some(row => row.from === 'build/app-update.yml'));
  const ignored = ['build/ffmpeg/ffmpeg.exe', 'build/ffmpeg/ffprobe.exe', 'build/ffmpeg/librempeg.exe', 'build/ffmpeg/darwin-arm64/ffmpeg', 'build/ffmpeg-essentials.zip', 'build/_ffmpeg_tmp/file', 'dist/file', 'dist-react/file'];
  for (const file of ignored) assert.equal(spawnSync('git', ['check-ignore', '--no-index', '--quiet', file], { cwd: root }).status, 0, file);
  const tracked = spawnSync('git', ['ls-files', '-z', 'build'], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0);
  for (const file of tracked.stdout.split('\0').filter(Boolean)) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file);
    assert.notEqual(spawnSync('git', ['check-ignore', '--no-index', '--quiet', file], { cwd: root }).status, 0, file);
  }
  console.log('PASS build assets: explicit NSIS resource matches default; icons, updater, licenses retained; generated files ignored');
})().catch(error => { console.error(error); process.exitCode = 1; });
