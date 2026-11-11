






















const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(DIST, 'win-unpacked');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PRODUCT = (pkg.build && pkg.build.productName) || pkg.name;
const VERSION = pkg.version.replace(/^(\d+\.\d+)\.0$/, '$1');

const FOLDER_NAME = `${PRODUCT}-${VERSION}`;
const ZIP_PATH = path.join(DIST, `${PRODUCT}-${VERSION}-win-x64.zip`);
const STAGED = path.join(DIST, FOLDER_NAME);

function find7za() {
  const candidates = [
    path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'ia32', '7za.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}


function safeUnlink(p) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch (e) {
    console.warn('[zip] 删除文件失败：' + p + ' — ' + e.message);
    return false;
  }
}


function safeRemoveDir(dir) {
  if (!fs.existsSync(dir)) return true;
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Remove-Item -LiteralPath '${dir}' -Recurse -Force -ErrorAction SilentlyContinue`,
    ], { stdio: 'ignore' });
    return !fs.existsSync(dir);
  } catch (e) {
    console.warn('[zip] 删除目录失败：' + dir + ' — ' + e.message);
    return false;
  }
}

function main() {

  if (!fs.existsSync(SRC) && fs.existsSync(STAGED)) {
    console.log('[zip] 检测到上次异常退出遗留的目录，正在改回 win-unpacked…');
    fs.renameSync(STAGED, SRC);
  }

  if (fs.existsSync(SRC) && fs.existsSync(STAGED)) {
    console.log('[zip] 清理重名残留目录：' + FOLDER_NAME);
    safeRemoveDir(STAGED);
  }

  if (!fs.existsSync(SRC)) {
    console.error('[zip] 未找到 ' + SRC);
    console.error('[zip] 请先执行：npx electron-builder --win --dir');
    process.exit(1);
  }

  console.log('[zip] 准备打包：' + PRODUCT + ' ' + VERSION);

  let renamed = false;
  try {

    if (fs.existsSync(ZIP_PATH)) {
      console.log('[zip] 删除旧的 zip…');
      if (!safeUnlink(ZIP_PATH)) throw new Error('旧 zip 删除失败（可能被占用）');
    }

    fs.renameSync(SRC, STAGED);
    renamed = true;
    console.log('[zip] 已将 win-unpacked 临时更名为 ' + FOLDER_NAME);

    const sevenZip = find7za();
    if (sevenZip) {
      console.log('[zip] 压缩中（7-Zip）…');

      execFileSync(sevenZip, ['a', '-tzip', '-mx=5', '-bso0', '-bsp0', ZIP_PATH, FOLDER_NAME], {
        cwd: DIST,
        stdio: 'inherit',
      });
    } else {
      console.log('[zip] 压缩中（PowerShell Compress-Archive）…');
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command',
         `Compress-Archive -LiteralPath '${STAGED}' -DestinationPath '${ZIP_PATH}' -Force`],
        { stdio: 'inherit' }
      );
    }

    if (!fs.existsSync(ZIP_PATH)) throw new Error('压缩未生成文件');

    const size = fs.statSync(ZIP_PATH).size;
    console.log('[zip] 完成：' + ZIP_PATH);
    console.log('[zip]   大小：' + (size / 1048576).toFixed(1) + ' MB');
    console.log('[zip]   解压后顶层文件夹：' + FOLDER_NAME + '/（双击其中的 exe 即用）');
  } finally {

    if (renamed && fs.existsSync(STAGED) && !fs.existsSync(SRC)) {
      try {
        fs.renameSync(STAGED, SRC);
        console.log('[zip] 已恢复目录名为 win-unpacked');
      } catch (e) {
        console.warn('[zip] 恢复目录名失败（下次运行会自动修复）：' + e.message);
      }
    }
  }
}

try {
  main();
} catch (e) {
  console.error('[zip] 打包失败：' + (e && e.message ? e.message : e));
  process.exit(1);
}
