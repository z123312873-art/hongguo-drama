const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { availableRelease, releaseSummary } = require('../src/native/app-update');

const ordered = ['1.7', '1.8', '1.9', '1.71', '1.74', '1.75', '1.75.1', '1.76', '1.99', '1.100', '2.0', '2.9', '3.0', '3.1', '3.2', '3.3', '3.4', '4.0', '4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.6.1', '4.6.3', '4.6.5', '4.7', '4.7.5'];
let checks = 0;
for (let current = 0; current < ordered.length; current++) {
  for (let next = 0; next < ordered.length; next++) {
    const release = availableRelease({ tag_name: `v${ordered[next]}` }, ordered[current]);
    assert.equal(release?.version || null, next > current ? ordered[next] : null,
      `${ordered[current]} to ${ordered[next]}`);
    checks++;
  }
}
for (const tag of ['v1.75', '1.75', 'v1.75.0', '1.75.0']) {
  assert.equal(availableRelease({ tag_name: tag }, '1.75.0'), null);
}
for (const tag of ['v1.76-beta.1', 'v1.76.0-beta.1', 'garbage', '1.76.0.1', '1.9007199254740992']) {
  assert.equal(availableRelease({ tag_name: tag }, '1.75.0'), null);
}
for (const flags of [{ prerelease: true }, { draft: true }]) {
  assert.equal(availableRelease({ tag_name: 'v2.0', ...flags }, '1.75.0'), null);
}
const pkg = require('../package.json');
const lock = require('../package-lock.json');
assert.equal(lock.version, pkg.version, 'Lockfile version must match the release');
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root package must match the release');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'Release versions support nonzero patch upgrades');
const publicVersion = pkg.version.replace(/^(\d+\.\d+)\.0$/, '$1');
assert.equal(availableRelease({ tag_name: 'v2.0' }, '1.80.0').version, '2.0');
assert.equal(availableRelease({ tag_name: 'v2.0' }, '2.0.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.1' }, '3.0.0').version, '3.1');
assert.equal(availableRelease({ tag_name: 'v3.1' }, '3.1.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.2' }, '3.1.0').version, '3.2');
assert.equal(availableRelease({ tag_name: 'v3.2' }, '3.2.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.3' }, '3.2.0').version, '3.3');
assert.equal(availableRelease({ tag_name: 'v3.3' }, '3.3.0'), null);
assert.equal(availableRelease({ tag_name: 'v3.4' }, '3.3.0').version, '3.4');
assert.equal(availableRelease({ tag_name: 'v3.4' }, '3.4.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.0' }, '3.4.0').version, '4.0');
assert.equal(availableRelease({ tag_name: 'v4.0' }, '4.0.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.1' }, '4.0.0').version, '4.1');
assert.equal(availableRelease({ tag_name: 'v4.1' }, '4.1.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.0' }, '4.1.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.2' }, '4.1.0').version, '4.2');
assert.equal(availableRelease({ tag_name: 'v4.2' }, '4.2.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.1' }, '4.2.0'), null);
assert.equal(availableRelease({ tag_name: 'installer-4.2-traditional-pre', prerelease: true }, '4.1.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.3' }, '4.1.0').version, '4.3');
assert.equal(availableRelease({ tag_name: 'v4.3' }, '4.2.0').version, '4.3');
assert.equal(availableRelease({ tag_name: 'v4.3' }, '4.3.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.2' }, '4.3.0'), null);
assert.equal(availableRelease({ tag_name: 'installer-4.3-traditional-pre', prerelease: true }, '4.1.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.4' }, '4.3.0').version, '4.4');
assert.equal(availableRelease({ tag_name: 'v4.4' }, '4.4.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.3' }, '4.4.0'), null);
assert.equal(availableRelease({ tag_name: 'installer-4.4-traditional-pre', prerelease: true }, '4.3.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.5' }, '4.4.0').version, '4.5');
assert.equal(availableRelease({ tag_name: 'v4.5' }, '4.5.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.4' }, '4.5.0'), null);
assert.equal(availableRelease({ tag_name: 'installer-4.5-traditional-pre', prerelease: true }, '4.4.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.6' }, '4.5.0').version, '4.6');
assert.equal(availableRelease({ tag_name: 'v4.6' }, '4.6.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.5' }, '4.6.0'), null);
assert.equal(availableRelease({ tag_name: 'installer-4.6-traditional-pre', prerelease: true }, '4.5.0'), null);
assert.equal(availableRelease({ tag_name: 'v4.6', prerelease: true }, '4.5.0'), null);
assert.equal(availableRelease({ tag_name: 'installer-4.1-traditional-pre', prerelease: true }, '4.0.0'), null);
assert.equal(availableRelease({ tag_name: 'installer-4.0-traditional-pre', prerelease: true }, '3.4.0'), null);
assert.equal(availableRelease({ tag_name: 'installer-3.4-traditional-pre', prerelease: true }, '3.3.0'), null);
const noted = availableRelease({ tag_name: 'v3.4', body: '摘要：\n- 修正彈幕重疊\n- 時間軸最多 35 條\n\nSHA256：abc\nhttps://example.invalid/setup.exe' }, '3.3.0');
assert.equal(noted.version, '3.4');
assert.deepEqual(noted.highlights, ['修正彈幕重疊', '時間軸最多 35 條']);
assert.equal(availableRelease({ tag_name: 'v3.4', body: '摘要：這一整句不該變成單行摘要，因為正式說明要條列。' }, '3.3.0').highlights, undefined);
assert.deepEqual(availableRelease({ tag_name: 'v3.4', body: '摘要：橫幅、更新提醒、時間軸' }, '3.3.0').highlights, ['橫幅', '更新提醒', '時間軸']);
assert.equal(availableRelease({ tag_name: 'v3.4', body: `- ${'字'.repeat(40)}` }, '3.3.0').highlights, undefined);
assert.equal(availableRelease({ tag_name: 'v3.4', body: `摘要：\n- ${'字'.repeat(40)}` }, '3.3.0').highlights[0].length, 40);
assert.equal(availableRelease({ tag_name: 'v3.4', body: `摘要：\n- ${'字'.repeat(200)}` }, '3.3.0').highlights[0].length, 72);
const many = availableRelease({ tag_name: 'v4.1', body: `摘要：\r\n${Array.from({ length: 27 }, (_, i) => `- 第 ${i + 1} 項`).join('\r\n')}\r\n\r\nSHA256：abc` }, '4.0.0');
assert.equal(many.highlights.length, 20);
assert.equal(many.moreCount, 7);
assert.equal(many.highlights[19], '第 20 項');
assert.equal(availableRelease({ tag_name: 'v4.1', body: '摘要：\n- 一\n- 二' }, '4.0.0').moreCount, undefined);
assert.deepEqual(availableRelease({ tag_name: 'v4.1', body: '## 摘要\n1. 甲\n2、乙\n（3）丙\n   - 子項\n\n### 新增\n- 丁\n- 甲\n\n### SHA256\n- 不該出現' }, '4.0.0').highlights, ['甲', '乙', '丙', '子項', '丁']);
assert.deepEqual(availableRelease({ tag_name: 'v4.1', body: '摘要：\n- 一\n\n**下載**\n- 不該出現' }, '4.0.0').highlights, ['一']);
assert.deepEqual(availableRelease({ tag_name: 'v4.1', body: '摘要：\n- 見 [說明](https://example.invalid/a)\n- https://example.invalid/b\n- 檔案 SHA256 abc\n- 二' }, '4.0.0').highlights, ['見 說明', '二']);
assert.equal(availableRelease({ tag_name: 'v4.1', body: '摘要這一整句沒有冒號\n- 不該出現' }, '4.0.0').highlights, undefined);
assert.equal(availableRelease({ tag_name: 'v4.1', body: '4.1 正式版\n- 不該出現' }, '4.0.0').highlights, undefined);
assert.equal(availableRelease({ tag_name: 'v4.1', body: '摘要：\n' }, '4.0.0').highlights, undefined);
assert.equal(availableRelease({ tag_name: 'v4.1', body: '摘要：\n- ' + '甲'.repeat(5000) }, '4.0.0').highlights[0].length, 72);
assert.equal(availableRelease({ tag_name: 'v4.1', body: null }, '4.0.0').highlights, undefined);
assert.equal(availableRelease({ tag_name: 'v3.4', prerelease: true, body: '摘要：\n- 不該出現' }, '3.3.0'), null);
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows.yml'), 'utf8').replace(/\r\n?/g, '\n');
const releaseJob = workflow.slice(workflow.indexOf('publish-release:'));
const heredoc = /notes=\$\(cat <<EOF\n([\s\S]*?)\n\s*EOF\n/.exec(releaseJob);
assert(heredoc, 'The formal release job must build its notes from a heredoc');
const formalBody = heredoc[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n').replace(/\$\w+/g, 'x');
const formal = availableRelease({ tag_name: 'v4.1', body: formalBody }, '4.0.0');
assert(formal.highlights.length >= 4, 'The formal notes must list the summary bullets');
assert(formal.highlights.slice(0, 4).every(item => Array.from(item).length <= 24), 'Installed 3.4/4.0 clients clip the first four bullets at 24 characters');
assert(formal.highlights.every(item => !/sha-?256|https?:/i.test(item)), 'Checksums and links never become summary lines');
assert(!formal.moreCount, 'The formal notes fit in the update window');
for (const artifact of [pkg.build.artifactName, pkg.build.portable.artifactName, pkg.build.nsis.artifactName]) {
  assert(artifact.includes(`-${publicVersion}-`), 'Download filenames must contain the public release version');
  assert(!artifact.includes('${version}'), 'Raw internal versions must not leak into download filenames');
}
function bulletsAfter(text, marker) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex(line => line.includes(marker));
  assert(start >= 0, marker);
  const bullets = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed) { if (bullets.length) break; continue; }
    if (!trimmed.startsWith('- ')) break;
    bullets.push(trimmed.slice(2));
  }
  return bullets;
}
const noteBullets = bulletsAfter(fs.readFileSync(path.join(__dirname, '../docs/release-4.6.md'), 'utf8'), '## 更新摘要');
const preJob = workflow.slice(workflow.indexOf('publish-release-4-6-pre:'), workflow.indexOf('publish-release:'));
const preHeredoc = /notes=\$\(cat <<EOF\n([\s\S]*?)\n\s*EOF\n/.exec(preJob);
assert(preHeredoc, 'The 4.6 pre-release job must build its notes from a heredoc');
const preBody = preHeredoc[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
const preBullets = releaseSummary(preBody).items;
assert.deepEqual(preBullets, noteBullets, 'The 4.6 pre-release must publish the same summary');
assert.deepEqual(noteBullets, [
  '紅果帳號登入，同步紀錄與收藏',
  '收藏夾可新增、改名與刪除',
  '修正無法播放，在線載入更快',
  '修正下載檔案發生錯誤',
  '精簡提示，優化標籤與底部頁碼',
], 'The 4.6 summary is exactly these five lines, in this order');
assert(noteBullets.every(item => Array.from(item).length <= 15), 'Each 4.6 summary line fits the large-font update window');
console.log(`PASS ${checks} version pairs, equivalent versions, invalid versions and unpublished releases`);

for (const current of ['4.5.0', '4.6.0']) assert.equal(availableRelease({ tag_name: 'v4.6.1' }, current).version, '4.6.1');
assert.equal(availableRelease({ tag_name: 'v4.6.1' }, '4.6.1'), null);
const officialJob = workflow.slice(workflow.indexOf('  publish-release-4-6:'), workflow.indexOf('  publish-release-4-6-pre:'));
assert.match(officialJob, /tag=v4\.6\.1/);
assert.match(officialJob, /--title "4\.6 正式版"/);
assert.match(officialJob, /--prerelease=false --draft=false --latest/);
assert.match(officialJob, /downloader-4\.6\.1-win-x64-setup\.exe/);
assert.ok(officialJob.includes("'^version: 4\\.6\\.1$'"));
assert.doesNotMatch(officialJob, /release delete|delete-asset|cleanup-tag/);
const officialHeredoc = /notes=\$\(cat <<EOF\n([\s\S]*?)\n\s*EOF\n/.exec(officialJob);
assert(officialHeredoc);
assert.deepEqual(releaseSummary(officialHeredoc[1]).items, noteBullets);

const pre463Doc = bulletsAfter(fs.readFileSync(path.join(__dirname, '../docs/release-4.6.3.md'), 'utf8'), '## 更新摘要');
const pre463Job = workflow.slice(workflow.indexOf('  publish-release-4-6-3-pre:'), workflow.indexOf('  publish-release-4-6-5-pre:'));
const pre463Heredoc = /notes=\$\(cat <<EOF\n([\s\S]*?)\n\s*EOF\n/.exec(pre463Job);
assert(pre463Heredoc, 'The 4.6.3 pre-release job must build its notes from a heredoc');
const pre463Body = pre463Heredoc[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
assert.deepEqual(releaseSummary(pre463Body).items, pre463Doc, 'The 4.6.3 pre-release must publish the documented summary');
assert.deepEqual(pre463Doc, [
  '觀看紀錄與手機同步更快：定時自動更新',
  '觀看紀錄新增批次移除，可全選目前篩選的結果',
  '搜尋頁預設來源改為紅果，一次顯示全部搜尋結果',
  '搜尋結果分成「標題匹配」與「其他相關」，海報載入更快',
  '精簡搜尋頁提示文字，修正來源選單文字偏下',
], 'The 4.6.3 summary is exactly these five lines, in this order');
assert(pre463Doc.every(item => Array.from(item).length <= 72), 'Each 4.6.3 summary line fits the update window limit');
assert.match(pre463Job, /tag=installer-4\.6\.3-traditional-pre/);
assert.match(pre463Job, /--prerelease --latest=false --title "4\.6\.3 預發佈"/);
assert.match(pre463Job, /downloader-4\.6\.3-win-x64-setup\.exe/);
assert.ok(pre463Job.includes("'^version: 4\\.6\\.3$'"));
assert.match(pre463Job, /\)" != "\$tag"/, 'The pre-release must never become the latest release');
assert.doesNotMatch(pre463Job, /--latest(?!=false)|prerelease=false|cleanup-tag|release delete /);
assert.match(workflow, /startsWith\(github\.ref, 'refs\/heads\/windows\/4\.6\.3-pre-'\)/);
for (const current of ['4.6.0', '4.6.1']) {
  assert.equal(availableRelease({ tag_name: 'installer-4.6.3-traditional-pre', prerelease: true }, current), null, 'the pre-release is never offered by the updater');
}
for (const current of ['4.6.1', '4.6.3', '4.6.5']) assert.equal(availableRelease({ tag_name: 'v4.7' }, current).version, '4.7');
assert.equal(availableRelease({ tag_name: 'v4.6.1' }, '4.6.3'), null, 'a 4.6.3 pre-release install is not offered the older 4.6.1');

const pre465Doc = bulletsAfter(fs.readFileSync(path.join(__dirname, '../docs/release-4.6.5.md'), 'utf8'), '## 更新摘要');
const pre465Job = workflow.slice(workflow.indexOf('  publish-release-4-6-5-pre:'), workflow.indexOf('  publish-release-4-7:'));
const pre465Heredoc = /notes=\$\(cat <<EOF\n([\s\S]*?)\n\s*EOF\n/.exec(pre465Job);
assert(pre465Heredoc, 'The 4.6.5 pre-release job must build its notes from a heredoc');
const pre465Body = pre465Heredoc[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
assert.deepEqual(releaseSummary(pre465Body).items, pre465Doc, 'The 4.6.5 pre-release must publish the documented summary');
assert.deepEqual(pre465Doc, [
  '修復紅果短劇無法播放，恢復線上取址',
  '修復河馬短劇有集無鎖卻不能播，播放器可切換解析度，畫質最高 720P',
  '移除西飯來源，只保留紅果與河馬',
  '河馬海報載入更快，首屏更快出現',
  '河馬題材標籤整理成複合分類，篩選更清爽',
  '觀看紀錄與手機同步更快，並可批次移除紀錄',
  '搜尋預設紅果並顯示全部結果，分「標題匹配」與「其他相關」',
  '精簡提示文字，修正來源選單顯示',
], 'The 4.6.5 summary is exactly these eight lines, in this order');
assert.equal(pre465Doc.length, 8, 'The 4.6.5 summary integrates the 4.6.3 items into exactly eight points');
assert(pre465Doc.every(item => Array.from(item).length <= 72), 'Each 4.6.5 summary line fits the update window limit');
assert.match(pre465Job, /tag=installer-4\.6\.5-traditional-pre/);
assert.match(pre465Job, /--prerelease --latest=false --title "4\.6\.5 預發佈"/);
assert.match(pre465Job, /downloader-4\.6\.5-win-x64-setup\.exe/);
assert.ok(pre465Job.includes("'^version: 4\\.6\\.5$'"));
assert.match(pre465Job, /\)" != "\$tag"/, 'The pre-release must never become the latest release');
assert.doesNotMatch(pre465Job, /--latest(?!=false)|prerelease=false|cleanup-tag|release delete /);
assert.match(workflow, /startsWith\(github\.ref, 'refs\/heads\/windows\/4\.6\.5-pre-'\)/);
for (const current of ['4.6.0', '4.6.1', '4.6.3']) {
  assert.equal(availableRelease({ tag_name: 'installer-4.6.5-traditional-pre', prerelease: true }, current), null, 'the 4.6.5 pre-release is never offered by the updater');
}
assert.equal(availableRelease({ tag_name: 'v4.6.3' }, '4.6.5'), null, 'a 4.6.5 pre-release install is not offered the older 4.6.3');

const formal47Doc = bulletsAfter(fs.readFileSync(path.join(__dirname, '../docs/release-4.7.md'), 'utf8'), '## 更新摘要');
const readme47 = bulletsAfter(fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8'), '4.7 正式版：');
assert.deepEqual(formal47Doc, [
  '修復紅果短劇無法播放',
  '修復河馬短劇播放來源',
  '河馬短劇海報載入加快',
  '優化河馬短劇標籤篩選',
  '觀看紀錄與手機同步更快，且可批次移除紀錄',
  '搜尋預設紅果，並優化顯示清單',
  '精簡提示文字，修正來源選單顯示',
], 'The 4.7 summary is exactly these seven lines, in this order');
assert.deepEqual(readme47, formal47Doc, 'README must copy the 4.7 summary');
assert(formal47Doc.every(item => Array.from(item).length <= 24), 'Installed 4.0 clients show 4.7 summary lines without clipping');
const formal47Job = workflow.slice(workflow.indexOf('  publish-release-4-7:'), workflow.indexOf('  publish-release-4-7-5-pre:'));
assert(workflow.indexOf('  publish-release-4-7:') > workflow.indexOf('  publish-release-4-6-5-pre:'));
assert.match(workflow, /startsWith\(github\.ref, 'refs\/heads\/windows\/4\.7-release-'\)/);
assert.match(formal47Job, /tag=v4\.7\n/);
assert.match(formal47Job, /--draft --title "4\.7 正式版"/);
assert.match(formal47Job, /--prerelease=false --draft=false --latest\n/);
assert.match(formal47Job, /\.assets \| length'\)" = "4"/);
assert.match(formal47Job, /\)" = "\$tag"/, 'The 4.7 formal release must become the latest release');
assert.match(formal47Job, /downloader-4\.7-win-x64-setup\.exe/);
assert.match(formal47Job, /downloader-4\.7-win-x64\.zip/);
assert.ok(formal47Job.includes("'^version: 4\\.7\\.0$'"));
assert.doesNotMatch(formal47Job, /release delete|delete-asset|cleanup-tag|--clobber|--latest=false|--prerelease /);
const formal47Heredoc = /notes=\$\(cat <<EOF\n([\s\S]*?)\n\s*EOF\n/.exec(formal47Job);
assert(formal47Heredoc, 'The 4.7 formal release job must build its notes from a heredoc');
const formal47Body = formal47Heredoc[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
assert.deepEqual(releaseSummary(formal47Body).items, formal47Doc, 'The 4.7 formal release must publish the documented summary');
const formal47Release = availableRelease({ tag_name: 'v4.7', body: formal47Body.replace(/\$\w+/g, 'x') }, '4.0.0');
assert.deepEqual(formal47Release.highlights, formal47Doc);
assert(!formal47Release.moreCount);
assert.match(workflow, /HONGGUO_SKIP_PLAYBACK: \$\{\{ \(startsWith\(github\.ref, 'refs\/heads\/windows\/4\.7\.5-pre-'\)/);
assert.match(workflow, /startsWith\(github\.ref, 'refs\/heads\/windows\/4\.7-release-'\)/);
for (const current of ['4.0.0', '4.1.0', '4.3.0', '4.5.0', '4.6.0', '4.6.1', '4.6.3', '4.6.5']) {
  assert.equal(availableRelease({ tag_name: 'v4.7' }, current).version, '4.7', `${current} is offered 4.7`);
  assert.equal(availableRelease({ tag_name: '4.7.0' }, current).version, '4.7', `${current} accepts the 4.7.0 manifest`);
}
for (const tag of ['v4.7', 'v4.7.0', '4.7', '4.7.0']) assert.equal(availableRelease({ tag_name: tag }, '4.7.0'), null, `4.7 does not reinstall itself from ${tag}`);
for (const tag of ['v4.6.5', 'v4.6.1', 'v4.0', 'v3.4']) assert.equal(availableRelease({ tag_name: tag }, '4.7.0'), null, `4.7 is never offered the older ${tag}`);
for (const tag of ['installer-4.7-traditional-pre', 'v4.7-beta.1', 'v4.7.0-rc.1']) assert.equal(availableRelease({ tag_name: tag }, '4.6.5'), null);
assert.equal(availableRelease({ tag_name: 'v4.7', prerelease: true }, '4.6.5'), null);
assert.equal(availableRelease({ tag_name: 'v4.7', draft: true }, '4.6.5'), null);
assert.equal(availableRelease({ tag_name: 'v4.6.5' }, '4.6.5'), null);
assert.equal(pkg.version, '4.7.5');
assert.equal(publicVersion, '4.7.5');
for (const artifact of [pkg.build.artifactName, pkg.build.portable.artifactName, pkg.build.nsis.artifactName]) assert(!artifact.includes('4.6'));
assert.ok(JSON.stringify(pkg.build).includes('hongguo-downloader-4.7.5-win-x64-setup'));
assert.equal(availableRelease({ tag_name: 'v4.7' }, '4.7.5'), null, 'a 4.7.5 install is not offered the older 4.7 formal release');
for (const current of ['4.7', '4.7.0']) {
  assert.equal(availableRelease({ tag_name: 'v4.7.5' }, current).version, '4.7.5', `${current} can be offered 4.7.5`);
  assert.equal(availableRelease({ tag_name: 'installer-4.7.5-traditional-pre', prerelease: true }, current), null, 'the 4.7.5 pre-release tag is not the latest formal update');
}
const pre475Doc = bulletsAfter(fs.readFileSync(path.join(__dirname, '../docs/release-4.7.5.md'), 'utf8'), '## 更新摘要');
const pre475Job = workflow.slice(workflow.indexOf('  publish-release-4-7-5-pre:'));
const pre475Heredoc = /notes=\$\(cat <<EOF\n([\s\S]*?)\n\s*EOF\n/.exec(pre475Job);
assert(pre475Heredoc, 'The 4.7.5 pre-release job must build its notes from a heredoc');
const pre475Body = pre475Heredoc[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
assert.deepEqual(releaseSummary(pre475Body).items, pre475Doc, 'The 4.7.5 pre-release must publish the documented summary');
assert.deepEqual(pre475Doc, [
  '修復紅果在線播放',
  '優化在線播放取源',
], 'The 4.7.5 summary is exactly these two lines');
assert.equal(pre475Doc.length, 2, 'The 4.7.5 summary is exactly two points');
assert(pre475Doc.every(item => Array.from(item).length <= 72), 'Each 4.7.5 summary line fits the update window limit');
assert.match(pre475Job, /tag=installer-4\.7\.5-traditional-pre/);
assert.match(pre475Job, /--prerelease --latest=false --title "4\.7\.5 預發佈"/);
assert.match(pre475Job, /downloader-4\.7\.5-win-x64-setup\.exe/);
assert.match(pre475Job, /downloader-4\.7\.5-win-x64\.zip/);
assert.ok(pre475Job.includes("'^version: 4\\.7\\.5$'"));
assert.match(pre475Job, /\)" != "\$tag"/, 'The 4.7.5 pre-release must never become the latest release');
assert.doesNotMatch(pre475Job, /--latest(?!=false)|prerelease=false|cleanup-tag|release delete /);
assert.match(workflow, /startsWith\(github\.ref, 'refs\/heads\/windows\/4\.7\.5-pre-'\)/);
assert(workflow.indexOf('  publish-release-4-7-5-pre:') > workflow.indexOf('  publish-release-4-7:'));
const prompted = availableRelease({ tag_name: 'v4.7.5', body: pre475Body }, '4.7.0');
assert.equal(prompted.version, '4.7.5');
assert.deepEqual(prompted.highlights, pre475Doc, 'Installed 4.7 can be shown this pre-release summary');
assert(!prompted.moreCount);
