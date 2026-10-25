// Isolated main-process checks: exercise real task/IPC code without user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);
const dirs = [];
function fixture({ width = 1080, height = 1920, quality = 'auto' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-quality-'));
  dirs.push(root);
  const handlers = {}, calls = [], events = [], app = new EventEmitter();
  let settings = { root, download_quality: quality }, saved;
  Object.assign(app, { getVersion: () => 'test', getPath: () => root,
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const context = vm.createContext({ require: n => n === 'electron'
    ? { app, ipcMain: { handle: (n, f) => handlers[n] = f }, protocol: { registerSchemesAsPrivileged() {} } }
    : n === './src/native/hongguo' ? { fetchPlayUrlSingle: async (...args) => { calls.push(args); return { url: 'https://media.example/video.mp4' }; } }
    : n === './src/store' ? { getSettings: () => settings, saveSettings: s => settings = s,
      saveTasks: tasks => { saved = JSON.parse(JSON.stringify(tasks)); } } : req(n),
    __dirname: path.dirname(source), console: { log() {}, warn() {}, error() {} },
    process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout,
    testEvents: events, testReadStream: () => Readable.from([Buffer.alloc(200000)]), testDimensions: { w: width, h: height, duration: 12, codec: "h264" } });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  require('./fixtures/trusted-ipc.cjs')(context, handlers);
  const run = text => vm.runInContext(text, context);
  run(`globalThis.originalProbeVideoInfo = probeVideoInfo; sendToRenderer = (channel, data) => testEvents.push({channel, data: {...data}}); pumpQueue = () => {}; resolveFfmpeg = () => '/test/ffprobe';
    probeVideoInfo = async () => testDimensions;
    requestMedia = async () => ({headers: {'content-length': '200000'}, data: testReadStream()});
    seriesRegistry = [{series_id:'1',series_title:'测试剧',episodes:[{vid:'11',vid_index:1},{vid:'12',vid_index:2}]}];`);
  return { root, context, run, handlers, calls, events, saved: () => saved,
    setQuality: value => { settings.download_quality = value; } };
}
const payload = quality => ({ seriesId: '1', seriesTitle: '测试剧', episodes: [{vid:'11',vid_index:1}], ...(quality ? {quality} : {}) });
const checks = [
  ['batch snapshots chosen quality and passes it through to source lookup', async () => {
    const h = fixture({ quality: '720p' });
    assert.equal((await h.handlers['hongguo-download-batch']({}, payload('1080p'))).success, true);
    assert.equal(h.saved()[0].downloadQuality, '1080p');
    h.setQuality('auto');
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.calls[0][2].quality, '1080p');
    assert.equal(h.saved()[0].status, 'completed');
    assert.equal(h.saved()[0].actualQuality, '1080p');
  }],
  ['single download accepts override and falls back to saved default', async () => {
    const h = fixture({ quality: '720p' });
    await h.handlers['download-single-episode']({}, '1', 1, '1080p');
    await h.handlers['download-single-episode']({}, '1', 2);
    assert.equal(h.saved().find(t => t.hongguoInfo.vid === '11').downloadQuality, '1080p');
    assert.equal(h.saved().find(t => t.hongguoInfo.vid === '12').downloadQuality, '720p');
  }],
  ['download accepts lower measured quality and reports it without an early failure', async () => {
    const h = fixture({ width:720, height:1280 });
    await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    const t = h.saved()[0];
    assert.equal(t.status, 'completed', t.error);
    assert.equal(t.downloadQuality, '1080p');
    assert.equal(t.actualQuality, '720p');
    assert.match(t.qualityNotice, /已下载更低质量.*720P.*1080P/);
    assert.equal(h.events.some(e => e.channel === 'download-failed'),false);
  }],
  ['failed higher variants exhaust all tiers, including after four addresses, before reporting an error', async () => {
    const h = fixture();
    h.run(`hongguo.fetchPlayUrlSingle = async (_vid,_sid,options) => {
      if (!options.allowLowerQuality) return {url:null,error:'1080 unavailable'};
      const variants = Array.from({length:7},(_,i) => ({url:'https://media.example/'+i,width:i<5?1080:i===5?720:480,height:1920}));
      return {...variants[0],variants};
    }; requestMedia = async info => {
      if (!info.url.endsWith('/6')) throw Object.assign(new Error('bad stream'),{mediaRetryable:true});
      testDimensions = {w:480,h:854,duration:12,codec:'h264'};
      return {headers:{'content-length':'200000'},data:testReadStream()};
    };`);
    await h.handlers['hongguo-download-batch']({},payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status,'completed',h.saved()[0].error);
    assert.equal(h.saved()[0].actualQuality,'480p');
    const notices = h.events.filter(e=>e.channel==='download-progress'&&e.data.qualityNotice).map(e=>e.data.qualityNotice);
    assert(notices.some(s=>/正在下载更低质量.*720P/.test(s)));
    assert(notices.some(s=>/正在下载更低质量.*480P/.test(s)));
    assert.equal(h.events.filter(e=>e.channel==='download-failed').length,0);
  }],
  ['all tiers unavailable reports one failure only after lower candidates were attempted', async () => {
    const h = fixture();
    h.run(`globalThis.attempts=[]; hongguo.fetchPlayUrlSingle = async () => ({url:'https://media.example/high',width:1080,height:1920,variants:[{url:'https://media.example/low',width:360,height:640}]});
      requestMedia = async info => { attempts.push(info.url); throw new Error('invalid video'); };`);
    await h.handlers['hongguo-download-batch']({},payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status,'failed');
    assert(h.run("attempts.includes('https://media.example/low')"));
    assert.equal(h.events.filter(e=>e.channel==='download-failed').length,1);
    assert.equal(fs.existsSync(h.saved()[0].savePath),false);
  }],
  ['disk errors and cancellation never trigger a lower-quality download', async () => {
    for(const code of ['ENOSPC','EACCES','ENOTDIR','EMFILE','EBUSY','SECURITY_BLOCKED','ERR_CANCELED']) {
      const h = fixture();
      h.context.failureCode=code;
      h.run(`globalThis.attempts=0; hongguo.fetchPlayUrlSingle = async () => ({url:'https://media.example/high',variants:[{url:'https://media.example/low',width:480,height:854}]});
        requestMedia = async () => { attempts++; if(failureCode==='ERR_CANCELED') downloadTasks[0].cancelSource.cancel('stop'); throw Object.assign(new Error('stop'),{code:failureCode}); };`);
      await h.handlers['hongguo-download-batch']({},payload('1080p'));
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.run('attempts'),1,code);
      assert.equal(h.saved()[0].status,code==='ERR_CANCELED'?'stopped':'failed');
    }
  }],
  ['missing probe tool stops without downloading lower candidates', async () => {
    for (const tool of [null, '/nonexistent/hongguo-fixture-ffprobe']) {
      const h = fixture(); h.context.probeTool = tool;
      h.run(`globalThis.attempts=0; probeVideoInfo=originalProbeVideoInfo; resolveFfmpeg=()=>probeTool;
        hongguo.fetchPlayUrlSingle=async()=>({url:'https://media.example/high',variants:[{url:'https://media.example/low',width:480,height:854}]});
        requestMedia=async()=>{attempts++;return {headers:{'content-length':'200000'},data:testReadStream()};};`);
      await h.handlers['hongguo-download-batch']({},payload('1080p'));
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status,'failed');
      assert.equal(h.run('attempts'),1);
      assert.match(h.saved()[0].error,/工具/);
    }
  }],
  ['lost files and interrupted or stopped tasks never retain a download notice', async () => {
    const h = fixture({width:720,height:1280});
    await h.handlers['hongguo-download-batch']({},payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    fs.unlinkSync(h.saved()[0].savePath);
    const rows=await h.handlers['get-download-tasks']({});
    assert.equal(rows[0].status,'failed'); assert.equal(rows[0].qualityNotice,'');
    h.run(`store.getTasks = () => [{id:'interrupted',status:'downloading',qualityNotice:'正在下载更低质量片源'}, {id:'stopped',status:'stopped',qualityNotice:'正在下载更低质量片源'}]; loadDownloadTasks();`);
    assert.equal(h.run('downloadTasks[0].qualityNotice'),'');
    assert.equal(h.run('downloadTasks[1].qualityNotice'),'');
  }],
  ['unverifiable resolution fails closed for explicit quality', async () => {
    const h = fixture(); h.context.testDimensions = null;
    await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.match(h.saved()[0].error, /分辨率|清晰度/);
  }],
  ['existing low-resolution file remains unchanged and is not counted as 1080', async () => {
    const h = fixture({ width:720, height:1280 });
    await h.handlers['hongguo-download-batch']({}, payload());
    const t = h.saved()[0]; fs.writeFileSync(t.savePath, Buffer.alloc(200000, 42));
    h.run('downloadTasks[0].status = "completed"');
    const result = await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    assert.equal(result.success, false);
    assert.match(result.error, /已有|本地/);
    assert.equal(fs.readFileSync(t.savePath)[0], 42);
    assert.equal(h.run('downloadTasks[0].status'), 'completed');
  }],
  ['different quality cannot silently reuse an in-flight task', async () => {
    const h = fixture();
    await h.handlers['hongguo-download-batch']({}, payload('720p'));
    const result = await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    assert.equal(result.success, false);
    assert.equal(h.run('downloadTasks[0].downloadQuality'), '720p');
  }],
  ['invalid quality is rejected before adding any tasks', async () => {
    const h = fixture();
    assert.equal((await h.handlers['hongguo-download-batch']({}, payload('4k'))).success, false);
    assert.equal(h.run('downloadTasks.length'), 0);
  }],
  ['automatic downloads reject an invalid media probe before publishing', async () => {
    const h = fixture(); h.context.testDimensions = null;
    await h.handlers['hongguo-download-batch']({}, payload());
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.equal(fs.existsSync(h.saved()[0].savePath), false);
  }],
  ['all modes reject missing or nonfinite video duration', async () => {
    for (const quality of ['auto', '720p', '1080p']) for (const duration of [0, NaN, Infinity]) {
      const h = fixture(); h.context.testDimensions.duration = duration;
      await h.handlers['hongguo-download-batch']({}, payload(quality));
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'failed', `${quality} ${duration}`);
      assert.equal(fs.existsSync(h.saved()[0].savePath), false);
    }
  }],
  ['existing invalid file is retained and cannot be completed in auto mode', async () => {
    const h = fixture(); h.context.testDimensions = null;
    await h.handlers['hongguo-download-batch']({}, payload());
    const t = h.saved()[0]; fs.writeFileSync(t.savePath, Buffer.alloc(200000, 42));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.equal(fs.readFileSync(t.savePath)[0], 42);
    assert.equal(h.calls.length, 0);
  }],
  ['complete matching decrypted cache avoids a second media transfer', async () => {
    const h = fixture();
    await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', vidIndex:1, prefetch:true });
    assert.equal(h.run("onlineCache.has('11')"), true);
    h.run("requestMedia = async () => { throw new Error('unexpected duplicate media transfer'); }");
    await h.handlers['hongguo-download-batch']({}, payload());
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'completed', h.saved()[0].error);
    assert.equal(fs.statSync(h.saved()[0].savePath).size, 200000);
  }],
  ['mismatched or unconfirmed cache cannot be downloaded', async () => {
    for (const field of ["entry.vid = 'other'", "entry.seriesId = 'other'", "entry.source = 'hema'", "entry.complete = false"]) {
      const h = fixture();
      await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', prefetch:true });
      h.run(`{ const entry = onlineCache.get('11'); ${field}; }`);
      h.run("requestMedia = async () => { throw new Error('network required'); }");
      await h.handlers['hongguo-download-batch']({}, payload());
      await h.run('executeHongguoDownload(downloadTasks[0])');
      assert.equal(h.saved()[0].status, 'failed', field);
    }
  }],
  ['cached 720p is not published for 1080p and fetches the requested quality', async () => {
    const h = fixture({ width:720, height:1280 });
    await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', prefetch:true });
    h.run("requestMedia = async () => { testDimensions = { w:1080, h:1920, duration:12, codec:'h264' }; return { headers:{'content-length':'200000'}, data:testReadStream() }; }");
    await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'completed', h.saved()[0].error);
    assert.equal(h.saved()[0].actualQuality, '1080p');
    assert.equal(h.calls.at(-1)[2].quality, '1080p');
  }],
  ['cancel during cached media verification prevents publication', async () => {
    const h = fixture();
    await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', prefetch:true });
    await h.handlers['hongguo-download-batch']({}, payload());
    h.run("probeVideoInfo = async () => { downloadTasks[0].cancelSource.cancel('test cancel'); return testDimensions; }");
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'stopped');
    assert.equal(fs.existsSync(h.saved()[0].savePath), false);
    assert.equal(fs.existsSync(h.saved()[0].savePath + '.enc.tmp'), false);
  }],
  ['a file appearing during verification is never overwritten', async () => {
    const h = fixture();
    await h.handlers['hongguo-download-batch']({}, payload());
    h.run("probeVideoInfo = async () => { fs.writeFileSync(downloadTasks[0].savePath, 'preserve existing file'); return testDimensions; }");
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.equal(fs.readFileSync(h.saved()[0].savePath, 'utf8'), 'preserve existing file');
  }],

  ['matching 1080 cache satisfies explicit quality without refetching', async () => {
    const h = fixture();
    await h.handlers['prepare-online-play']({}, { vid:'11', seriesId:'1', prefetch:true });
    h.run("requestMedia = async () => { throw new Error('unexpected duplicate media transfer'); }");
    await h.handlers['hongguo-download-batch']({}, payload('1080p'));
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'completed', h.saved()[0].error);
    assert.equal(h.saved()[0].actualQuality, '1080p');
  }],
  ['third-party cache cannot bypass a newly locked episode', async () => {
    const h = fixture();
    await h.handlers['prepare-online-play']({}, { vid:'xifan:1:11', seriesId:'xifan:1', prefetch:true });
    h.run("hongguo.fetchPlayUrlSingle = async () => ({ url:null, error:'该集已锁定' }); downloadTasks = [{ id:'locked', type:'hongguo', filename:'locked.mp4', hongguoInfo:{ vid:'xifan:1:11', series_id:'xifan:1', series_title:'Fixture' } }]");
    await h.run('executeHongguoDownload(downloadTasks[0])');
    assert.equal(h.saved()[0].status, 'failed');
    assert.match(h.saved()[0].error, /锁定/);
    assert.equal(fs.existsSync(h.saved()[0].savePath), false);
  }],
  ['list refresh never starts a media probe', async () => {
    const h = fixture();
    await h.handlers['hongguo-download-batch']({}, payload());
    const t = h.saved()[0]; fs.writeFileSync(t.savePath, Buffer.alloc(200000));
    h.run("downloadTasks[0].status = 'completed'; probeVideoInfo = () => { throw new Error('list refresh must not probe media'); }");
    for (let i = 0; i < 3; i++) await h.handlers['get-download-tasks']({});
  }],

  ['unsupported hard links publish through exclusive copy on removable disks', async () => {
    const originalLink = fs.linkSync, originalCopy = fs.copyFileSync;
    try {
      for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS']) {
        const h = fixture(); let copies = 0;
        fs.linkSync = () => { throw Object.assign(new Error('hard link unavailable'), { code }); };
        fs.copyFileSync = (source, destination, flags) => { copies++; assert.equal(flags, fs.constants.COPYFILE_EXCL); return originalCopy(source, destination, flags); };
        await h.handlers['hongguo-download-batch']({}, payload());
        await h.run('executeHongguoDownload(downloadTasks[0])');
        assert.equal(h.saved()[0].status, 'completed', `${code}: ${h.saved()[0].error}`);
        assert.equal(copies, 1);
        assert.equal(fs.statSync(h.saved()[0].savePath).size, 200000);
        assert.equal(fs.existsSync(h.saved()[0].savePath + '.enc.tmp'), false);
      }
    } finally { fs.linkSync = originalLink; fs.copyFileSync = originalCopy; }
  }],
  ['publication preserves raced existing files with or without hard-link support', async () => {
    const originalLink = fs.linkSync, originalCopy = fs.copyFileSync;
    try {
      for (const code of ['EEXIST', 'ENOTSUP', 'EIO']) {
        const h = fixture(); let copies = 0;
        fs.linkSync = (source, destination) => {
          fs.writeFileSync(destination, 'preserve user file');
          throw Object.assign(new Error('cannot link'), { code });
        };
        fs.copyFileSync = (...args) => { copies++; return originalCopy(...args); };
        await h.handlers['hongguo-download-batch']({}, payload());
        await h.run('executeHongguoDownload(downloadTasks[0])');
        assert.equal(h.saved()[0].status, 'failed', code);
        assert.equal(copies, code === 'ENOTSUP' ? 1 : 0, 'only unsupported links may fall back');
        assert.equal(fs.readFileSync(h.saved()[0].savePath, 'utf8'), 'preserve user file');
        assert.equal(fs.existsSync(h.saved()[0].savePath + '.enc.tmp'), false);
      }
    } finally { fs.linkSync = originalLink; fs.copyFileSync = originalCopy; }
  }],

];
(async () => {
  let failures = 0;
  try { for (const [name, check] of checks) {
    try { await check(); console.log('PASS ' + name); }
    catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
  } } finally { for (const dir of dirs) fs.rmSync(dir, {recursive:true, force:true}); }
  console.log(`${checks.length - failures}/${checks.length} passed`);
  process.exitCode = failures ? 1 : 0;
})();
