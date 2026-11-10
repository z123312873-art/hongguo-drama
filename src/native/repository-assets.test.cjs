const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const pkg = require('../../package.json');
test('build resources and required third-party notices remain part of distributable packages', () => {
  assert.ok(fs.statSync(path.join(root, pkg.build.win.icon)).size > 1000);
  assert.ok(pkg.build.win.extraResources.some(item => item.from === 'build/ffmpeg'));
  assert.ok(pkg.build.win.extraFiles.some(item => item.from === 'THIRD-PARTY-NOTICES.md'));
  assert.ok(pkg.build.mac.extraResources.some(item => item.from === 'THIRD-PARTY-NOTICES.md'));
  assert.ok(pkg.build.mac.extraResources.some(item => item.from === 'build/app-update.yml'));
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'build/installer.nsh', 'build/ffmpeg/COPYING.GPLv3', 'build/ffmpeg/LICENSE.md']) assert.ok(fs.statSync(path.join(root, file)).size > 100);
  assert.match(fs.readFileSync(path.join(root, 'node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js'), 'utf8'), /getResource\(this\.options\.include, "installer\.nsh"\)/);
});
test('Windows launchers retain active entrypoints and do not launch unmatched package wildcards', () => {
  const launch = fs.readFileSync(path.join(root, '启动红果下载器.bat'), 'latin1');
  assert.equal((launch.match(/if exist "%%~fF"/g) || []).length, 2);
  assert.match(launch, /win-unpacked/);
  assert.match(fs.readFileSync(path.join(root, '开发模式.bat'), 'latin1'), /call npm run dev/);
});
test('pre-release publishes only the four standard application assets', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('publish-release-4-6-pre:'), workflow.indexOf('publish-release:'));
  assert.match(job, /for file in "\$setup" "\$blockmap" "\$latest" "\$portable"; do/);
  assert.match(job, /gh release upload "\$tag" "\$setup" "\$blockmap" "\$latest" "\$portable" --clobber/);
  assert.doesNotMatch(job, /\$source/);
});
