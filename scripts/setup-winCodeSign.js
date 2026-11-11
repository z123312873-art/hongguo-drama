

















const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '.eb-cache');
const LOCK = path.join(CACHE, 'winCodeSign', 'winCodeSign-2.6.0');
const ARCHIVE = path.join(CACHE, 'winCodeSign-2.6.0.7z');
const APP_BUILDER = path.join(ROOT, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');

const MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://registry.npmmirror.com/-/binary/electron-builder-binaries/';
const URL = `${MIRROR}winCodeSign-2.6.0/winCodeSign-2.6.0.7z`;


const SHA256 = 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4';
const SHA512 = '6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA==';

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('重定向过多'));
    const client = url.startsWith('http://') ? http : https;
    client.get(url, { headers: { 'User-Agent': 'hongguo-downloader-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function serveFile(file) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': fs.statSync(file).size, 'Content-Type': 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/winCodeSign-2.6.0.7z` });
    });
  });
}

if (process.platform !== 'win32') {
  console.log('非 Windows 平台，无需此步骤。');
  process.exit(0);
}

if (fs.existsSync(path.join(LOCK, 'windows-10', 'x64', 'signtool.exe'))) {
  console.log('winCodeSign 已就绪：' + LOCK);
  process.exit(0);
}

fs.mkdirSync(CACHE, { recursive: true });

console.log('正在下载并校验 winCodeSign…');

download(URL, ARCHIVE).then(() => {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(ARCHIVE)).digest('hex');
  if (digest !== SHA256) {
    fs.rmSync(ARCHIVE, { force: true });
    console.error('winCodeSign 压缩包 SHA-256 不匹配，已删除下载文件');
    process.exit(1);
  }
  return serveFile(ARCHIVE);
}).then(({ server, url }) => {
  console.log('正在解压 winCodeSign（跳过 macOS 符号链接的报错不影响 Windows 文件）...');

  const sevenZipDir = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64');
  const env = {
    ...process.env,
    ELECTRON_BUILDER_CACHE: CACHE + path.sep,
    PATH: sevenZipDir + path.delimiter + (process.env.PATH || ''),
  };
  execFile(
    APP_BUILDER,
    ['download-artifact', '--name', 'winCodeSign', '--url', url, '--sha512', SHA512],
    { cwd: ROOT, env },
    (err, stdout, stderr) => {
      server.close();



    const parent = path.join(CACHE, 'winCodeSign');
    if (!fs.existsSync(parent)) {
      console.error('解压目录不存在，app-builder 输出：');
      console.error(stderr || stdout || (err && err.message));
      process.exit(1);
    }

    const isUsable = (d) =>
      fs.existsSync(path.join(d, 'windows-10', 'x64', 'signtool.exe')) &&
      fs.existsSync(path.join(d, 'rcedit-x64.exe'));


    const dirs = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(parent, d.name));

    const complete = dirs.find(isUsable);
    if (!complete) {
      console.error('未找到解压完整的目录，app-builder 输出：');
      console.error(stderr || stdout || (err && err.message));
      console.error('现有子目录：' + dirs.join(', '));
      process.exit(1);
    }

    fs.rmSync(LOCK, { recursive: true, force: true });
    fs.cpSync(complete, LOCK, { recursive: true });
    dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
    fs.readdirSync(parent)
      .filter((f) => f.endsWith('.7z'))
      .forEach((f) => fs.rmSync(path.join(parent, f), { force: true }));

    console.log('完成：' + LOCK);
    }
  );
}).catch((error) => {
  fs.rmSync(ARCHIVE, { force: true });
  console.error('失败：' + error.message);
  process.exit(1);
});
