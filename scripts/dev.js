







const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const PREFERRED_PORT = 5173;


function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}


async function findFreePort(start) {
  let port = start;
  while (await checkPort(port)) port++;
  return port;
}


function waitPortReady(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      checkPort(port).then((busy) => {
        if (busy) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error('等待 Vite 启动超时'));
        }
      });
    }, 300);
  });
}

async function main() {
  const occupied = await checkPort(PREFERRED_PORT);
  const port = occupied ? await findFreePort(PREFERRED_PORT + 1) : PREFERRED_PORT;

  if (occupied) {
    console.log(`\n[启动检查] 端口 ${PREFERRED_PORT} 已被占用，自动改用端口 ${port}\n`);
  } else {
    console.log(`\n[启动检查] 端口 ${PREFERRED_PORT} 空闲，正常启动\n`);
  }


  const vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env },
  });

  vite.on('error', (e) => {
    console.error('[启动失败] 无法启动 Vite:', e.message);
    process.exit(1);
  });


  try {
    await waitPortReady(port);
  } catch (e) {
    console.error('[启动失败]', e.message);
    vite.kill();
    process.exit(1);
  }

  const electron = spawn('npx', ['electron', '.'], {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${port}` },
  });

  const cleanup = () => {
    try { vite.kill(); } catch (_) {}
    try { electron.kill(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  electron.on('exit', () => cleanup());
}

main().catch((e) => {
  console.error('[启动失败]', e);
  process.exit(1);
});
