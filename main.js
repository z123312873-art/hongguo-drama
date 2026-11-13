
const { app, BrowserWindow, ipcMain: rawIpcMain, dialog, shell, session, protocol, Menu, Notification, screen, safeStorage } = require('electron');
const path = require('path');
const IS_PREVIEW = require('./package.json').name === 'hongguo-experience-preview';
if (IS_PREVIEW) {
  app.setName('红果短剧预览');
  if (!app.commandLine.hasSwitch('user-data-dir')) {
    app.setPath('userData', path.join(app.getPath('appData'), 'hongguo-experience-preview'));
  }
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => app.emit('activate'));
const fs = require('fs');
const fsp = require('fs/promises');
const axios = require('axios');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID, createHash } = require('node:crypto');

const hongguo = require('./src/native/hongguo');
const { normalizeDownloadQuality, meetsDownloadQuality } = require('./src/native/download-quality');
const { decryptInWorker } = require('./src/native/decrypt-worker.cjs');
const { createContentKeyCapture } = require('./src/native/seekable-capture');
const store = require('./src/store');
const watchHistory = require('./src/native/watch-history');
const seriesSearch = require('./src/native/series-search');
const { fitWindowBounds, getWindowScale, saveWindowZoom, initialWindowSize, revealMaximized } = require('./src/native/window-layout');
const { createEpisodePanelController } = require('./src/native/episode-panel');
const { availableRelease, LATEST_API, LATEST_PAGE, RELEASES_URL, updateRedirectTag } = require('./src/native/app-update');
const { fetchPublicDetails, fetchPublicRatings } = require('./src/native/public-details');
const { fetchEpisodeComments } = require('./src/native/episode-comments');
const { fetchDanmaku, setDeviceIdentityFile } = require('./src/native/danmaku');
const mediaAccess = require('./src/native/media-access').createMediaAccess(process.env.VITE_DEV_SERVER_URL);
const rendererSecurity = require('./src/native/renderer-security').createRendererSecurity(
  path.join(__dirname, 'dist-react', 'index.html'), process.env.VITE_DEV_SERVER_URL);
const APP_VERSION = app.getVersion() || '1.0.0';

const APP_TITLE = IS_PREVIEW ? '红果短剧预览' : '红果短剧';
const { createStealthController } = require('./src/native/stealth-window');

let mainWindow = null;
let appUpdateInstaller = null;
let appUpdater = null;
let updateDownloadGeneration = 0;
let pendingUpdateOperations = 0;
let quitCleanup = null;
let quitReady = false;
let mergeTempCleanup = null;
const UPDATE_BLOCKED_CHANNELS = new Set(['hongguo-download-batch', 'download-single-episode', 'retry-task', 'retry-tasks', 'resume-all', 'merge-series', 'transcode-for-playback', 'prepare-online-play', 'save-settings']);
const ipcMain = {
  handle(channel, handler) {
    rawIpcMain.handle(channel, async (event, ...args) => {
      if (!rendererSecurity.isTrustedSender(event, mainWindow)) throw new Error('窗口请求无效');
      if (quitCleanup) return { success: false, error: '正在退出，请等待清理完成。' };
      if (appUpdateInstaller?.getState().status === 'installing' && UPDATE_BLOCKED_CHANNELS.has(channel)) {
        return { success: false, error: '正在安装更新，请等待应用重新启动。' };
      }
      const blocksUpdate = UPDATE_BLOCKED_CHANNELS.has(channel);
      if (blocksUpdate) pendingUpdateOperations++;
      try { return await handler(event, ...args); }
      finally { if (blocksUpdate) pendingUpdateOperations--; }
    });
  },
};
let storageError = null;
store.setErrorHandler?.(payload => {
  storageError = payload;
  sendToRenderer('storage-error', payload);
});






app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,PlatformHEVCEncoderSupport');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');





const STREAM_SCHEME = 'hongguo-stream';








const LOCAL_SCHEME = 'hongguo-local';
protocol.registerSchemesAsPrivileged([
  {
    scheme: STREAM_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
  {
    scheme: LOCAL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);


const onlineCache = new Map();
const ONLINE_MAX_BYTES = 300 * 1024 * 1024;
const onlinePreparing = new Map();
const onlineSessions = new Map();

const onlineCaptures = new Map();
const onlinePrefetchFiles = new Map();

function abortOnlineCapture(key) {
  const capture = onlineCaptures.get(key);
  if (!capture) return;
  onlineCaptures.delete(key);
  capture.abort();
}

function onlineCacheTotal() {
  let t = 0;
  for (const e of onlineCache.values()) t += e.size;
  return t;
}

function trimOnlineCache() {
  let total = onlineCacheTotal();
  while (total > ONLINE_MAX_BYTES && onlineCache.size > 1) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, e] of onlineCache) {
      if (e.lastUsed < oldest) { oldest = e.lastUsed; oldestKey = k; }
    }
    if (!oldestKey) break;
    total -= onlineCache.get(oldestKey).size;
    deleteOnlineCacheEntry(oldestKey);
  }
}

function releaseOnlineSession(id) {
  const session = onlineSessions.get(id);
  if (!session) return;
  onlineSessions.delete(id);
  disposeOnlineDisk(session.entry);
  for (const controller of session.requests) controller.abort();

  const captureKey = session.cacheKey || session.vid;
  if (onlineCaptures.has(captureKey) && ![...onlineSessions.values()].some(active => (active.cacheKey || active.vid) === captureKey)) {
    abortOnlineCapture(captureKey);
  }
  const pending = session.job;
  if (pending && ![...onlineSessions.values()].some(s => s.job === pending)) {
    pending.controller.abort();
    if (onlinePreparing.get(session.cacheKey || session.vid) === pending) onlinePreparing.delete(session.cacheKey || session.vid);
  }
}

function clearOnlineCache() {
  for (const id of [...onlineSessions.keys()]) releaseOnlineSession(id);
  for (const key of [...onlineCaptures.keys()]) abortOnlineCapture(key);
  for (const key of [...onlineCache.keys()]) deleteOnlineCacheEntry(key);
}




function disposeOnlineDisk(entry) {
  if (!entry?.disk || entry.disk.readers || [...onlineCache.values()].some(e => e.disk === entry.disk)
    || [...onlineSessions.values()].some(s => s.entry?.disk === entry.disk)) return;
  try { fs.rmSync(entry.disk.directory, { recursive:true, force:true }); } catch (_) {}
}
function deleteOnlineCacheEntry(key) {
  const entry = onlineCache.get(key); onlineCache.delete(key); disposeOnlineDisk(entry);
}
function checkCustomAccess(vid) {
  if (String(vid).startsWith('custom:')) require('./src/native/custom-source').assertEnabled(vid);
}
async function prepareHlsFile(playInfo, output, options = {}) {
  try { return await require('./src/native/hls-media').remuxHls({ url:playInfo.url, output, ffmpeg:resolveFfmpeg('ffmpeg'),
    headers:{ ...(playInfo.userAgent ? {'User-Agent':playInfo.userAgent} : {}), ...(playInfo.referer ? {Referer:playInfo.referer} : {}) },
    ...options, checkAccess:() => checkCustomAccess(playInfo.vid) }); }
  catch (error) {
    checkCustomAccess(playInfo.vid);
    if (!options.signal?.aborted && !options.cancelToken?.reason) error.mediaRetryable = true;
    throw error;
  }
}


let downloadTasks = [];
let downloadQueue = [];
let activeDownloads = 0;
const runningDownloads = new Set();
const runningDownloadPaths = new Set();
const downloadRuns = new Map();
let MAX_CONCURRENT_DOWNLOADS = 3;


function getDefaultSettings() {
  return {
    root: IS_PREVIEW ? path.join(app.getPath('userData'), 'downloads') : app.getPath('downloads'),

    name_format: '剧名 集数',
    max_concurrent: 3,
    download_quality: 'auto',
    custom_sources: [],

    auto_delete_watched: false,

    compat_mode: true,
    cache_next_episode: true,
    app_updates_enabled: true,
    watch_updates_enabled: true,
    watch_sequels_enabled: true,
    watch_notifications_enabled: false,



    proxy_enabled: false,
    proxy_mode: 'system',
    proxy_host: '127.0.0.1',
    proxy_port: 7890,
    proxy_username: '',
    proxy_password: '',
  };
}



const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const originalProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
let activeProxyAuth = null;
const sessionProxyConfigs = new WeakMap();


function snapshotProxyUrl(targetUrl = 'https://www.baidu.com') {
  let target;
  try { target = new URL(targetUrl); } catch (_) { return null; }
  if (!target.host) return null;
  const protocol = target.protocol.split(':', 1)[0];
  const hostname = target.host.replace(/:\d*$/, '');
  const port = parseInt(target.port) || { ftp: 21, gopher: 70, http: 80, https: 443, ws: 80, wss: 443 }[protocol] || 0;
  const env = key => originalProxyEnv[key.toLowerCase()] || originalProxyEnv[key.toUpperCase()] || '';
  const bypass = env('no_proxy').toLowerCase();
  if (bypass === '*') return null;
  if (bypass && bypass.split(/[,\s]/).some(entry => {
    if (!entry) return false;
    const match = entry.match(/^(.+):(\d+)$/);
    const host = match ? match[1] : entry;
    const bypassPort = match ? parseInt(match[2]) : 0;
    if (bypassPort && bypassPort !== port) return false;
    if (!/^[.*]/.test(host)) return hostname === host;
    return hostname.endsWith(host.startsWith('*') ? host.slice(1) : host);
  })) return null;
  const proxy = env(protocol + '_proxy') || env('all_proxy');
  return proxy ? (proxy.includes('://') ? proxy : `${protocol}://${proxy}`) : null;
}

function normalizeProxySettings(settings) {
  const copy = { ...settings };
  const host = String(copy.proxy_host || '').trim();
  if (!host.includes('@')) return copy;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
    if (url.username || url.password) {
      copy.proxy_username = decodeURIComponent(url.username);
      copy.proxy_password = decodeURIComponent(url.password);
      copy.proxy_host = host.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/]*@/i, '$1');
    }
  } catch (_) {

    copy.proxy_host = host.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/]*@/i, '$1');
  }
  return copy;
}








function resolveProxyConfig(settings) {
  const s = settings || {};
  if (s.proxy_enabled !== true) {
    return { mode: 'direct', url: null };
  }
  const mode = s.proxy_mode || 'system';
  if (mode === 'direct') {
    return { mode: 'direct', url: null };
  }
  if (mode === 'custom') {
    const host = String(s.proxy_host || '').trim();
    const port = String(s.proxy_port || '').trim();
    if (!host) return { mode: 'custom', url: null };

    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
      if (!port && !/:\d+\/?$/.test(host)) return { mode: 'custom', url: null };
      if (port) {
        if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { mode: 'custom', url: null };
        url.port = port;
      }
      if (String(s.proxy_username || '').trim()) {
        url.username = encodeURIComponent(String(s.proxy_username).trim());
        url.password = encodeURIComponent(String(s.proxy_password || ''));
      }
      return { mode: 'custom', url: url.toString().replace(/\/$/, '') };
    } catch (_) { return { mode: 'custom', url: null }; }
  }

  return { mode: 'system', url: snapshotProxyUrl() };
}

function publicProxyUrl(value) {
  if (!value) return null;
  try { const url = new URL(value); url.username = ''; url.password = ''; return url.toString(); }
  catch (_) { return '(代理地址已隐藏)'; }
}

function publicProxyError(message, settings, resolved) {
  let text = String(message || '代理连接失败').replace(/([a-z]+:\/\/)[^\s/]*@/gi, '$1[认证已隐藏]@');
  for (const secret of [settings.proxy_username, settings.proxy_password, resolved.url]) {
    if (secret) for (const value of new Set([String(secret), encodeURIComponent(String(secret))])) text = text.split(value).join('[已隐藏]');
  }
  return text;
}





function applyProxyToEnv(resolved) {
  require('./src/native/direct-connect').setDirectConnect(resolved.mode === 'direct');
  require('./src/native/playback-device').forgetFailedPlaybackDevice();
  for (const key of PROXY_ENV_KEYS) {
    if (resolved.mode === 'system') {
      if (originalProxyEnv[key] !== undefined) process.env[key] = originalProxyEnv[key];
      else delete process.env[key];
    } else if (resolved.mode === 'custom' && resolved.url && key.toLowerCase() !== 'no_proxy') {
      process.env[key] = resolved.url;
    } else {
      delete process.env[key];
    }
  }
}


function proxyRuleForSession(resolved) {
  let url;
  try { url = new URL(resolved.url); } catch (_) { return null; }
  const protocol = (url.protocol || 'http:').replace(/:$/, '').toLowerCase();
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostname = host.includes(':') ? `[${host}]` : host;
  if (!hostname) return null;
  const port = url.port;
  return {
    rule: port ? `${protocol}://${hostname}:${port}` : `${protocol}://${hostname}`,
    auth: url.username ? {
      host,
      port: port ? Number(port) : (protocol === 'https' ? 443 : protocol.startsWith('socks') ? 1080 : 80),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password || ''),
    } : null,
  };
}


async function applyProxyToSession(resolved, sessions = [session.defaultSession, appUpdater?.netSession]) {
  activeProxyAuth = null;
  let config = { mode: resolved.mode === 'direct' ? 'direct' : 'system' };
  if (resolved.mode === 'custom' && resolved.url) {
    const built = proxyRuleForSession(resolved);
    if (!built) throw new Error('代理地址无效');
    activeProxyAuth = built.auth;
    config = { mode: 'fixed_servers', proxyRules: built.rule };
  }
  const key = JSON.stringify([config, activeProxyAuth]);
  await Promise.all(sessions.filter(Boolean).map(async ses => {
    if (sessionProxyConfigs.get(ses) === key) return;
    await ses.setProxy(config);
    await ses.clearAuthCache?.();
    await ses.closeAllConnections?.();
    sessionProxyConfigs.set(ses, key);
  }));
}

function matchesProxyAuth(authInfo) {
  if (!authInfo?.isProxy || !activeProxyAuth) return false;
  const host = String(authInfo.host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === activeProxyAuth.host && Number(authInfo.port) === activeProxyAuth.port;
}

app.on('login', (event, _webContents, _details, authInfo, callback) => {
  if (!matchesProxyAuth(authInfo)) return;
  event.preventDefault();
  callback(activeProxyAuth.username, activeProxyAuth.password);
});


async function applyProxySettings(settings) {
  const resolved = resolveProxyConfig(settings);
  try { await applyProxyToSession(resolved); }
  catch (_) { throw new Error('设置网络代理失败，请重试。'); }
  applyProxyToEnv(resolved);
  console.log(`[Proxy] mode=${resolved.mode}`);
  return resolved;
}

function getCurrentSettings() {
  const saved = store.getSettings() || {};
  const merged = { ...getDefaultSettings(), ...saved };


  if (saved.app_updates_enabled === false && saved.app_update_channel !== 'self') merged.app_updates_enabled = true;

  const mc = parseInt(merged.max_concurrent, 10);
  MAX_CONCURRENT_DOWNLOADS = Number.isInteger(mc) && mc >= 1 && mc <= 10 ? mc : 3;
  return normalizeProxySettings({ ...merged, max_concurrent: MAX_CONCURRENT_DOWNLOADS });
}


function sanitizeFolderName(name) {
  let cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/^ +/, '');

  const chars = Array.from(cleaned);
  if (chars.length > 80) cleaned = chars.slice(0, 80).join('');
  cleaned = cleaned.replace(/[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(cleaned)) {
    cleaned = `_${cleaned}`.replace(/[. ]+$/g, '');
  }
  return cleaned;
}


function renderName(format, seriesTitle, vidIndex, epTitle) {
  const fmt = String(format || '').trim();
  if (!fmt) return null;
  const vars = {
    'series_title': String(seriesTitle || '').trim(),
    'vid_index': String(vidIndex).padStart(3, '0'),
    'ep_title': String(epTitle || '').trim(),
  };
  const zhMap = {
    '剧名': 'series_title',
    '集数': 'vid_index',
    '标题': 'ep_title',
  };
  const zhRe = /剧名|集数|标题/g;
  let name = fmt
    .replace(zhRe, (w) => zhMap[w] || w)
    .replace(/([A-Za-z]+(?:_[A-Za-z]+)*)/g, (tok) => (vars[tok] !== undefined ? (vars[tok] || '') : tok));
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  return name || null;
}


function loadDownloadTasks() {
  const saved = store.getTasks() || [];
  saved.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  downloadTasks = saved.map((task) => {
    const inProgress = task.status === 'downloading' || task.status === 'pending';
    return {
      ...task,
      status: inProgress ? 'failed' : task.status,
      error: inProgress ? '应用关闭时任务中断' : task.error,
      qualityNotice: task.status === 'completed' ? task.qualityNotice || '' : '',
    };
  });
}





function rebuildSeriesRegistryFromTasks() {
  const groups = new Map();
  for (const t of downloadTasks) {
    const info = t.hongguoInfo;
    if (!info || !info.series_id) continue;
    const sid = String(info.series_id);
    if (!groups.has(sid)) {
      groups.set(sid, {
        series_id: sid,
        series_title: info.series_title || '未命名短剧',
        cover: (t.videoInfo && t.videoInfo.cover) || '',
        episodes: new Map(),
      });
    }
    const g = groups.get(sid);
    const idx = Number(info.vid_index) || 0;
    if (!g.episodes.has(idx)) {
      g.episodes.set(idx, {
        vid: String(info.vid),
        vid_index: idx,
        title: info.ep_title || '',
        cover: (t.videoInfo && t.videoInfo.cover) || '',
      });
    }
  }

  let added = 0;
  for (const g of groups.values()) {
    const existing = seriesRegistry.find((s) => String(s.series_id) === g.series_id);
    const list = Array.from(g.episodes.values()).sort((a, b) => a.vid_index - b.vid_index);
    if (!existing) {
      seriesRegistry.push({
        series_id: g.series_id,
        series_title: g.series_title,
        cover: g.cover,
        total: list.length,
        episodes: list,
        updatedAt: 0,
        dismissed: false,
      });
      added++;
    } else if (!existing.dismissed && (!existing.episodes || existing.episodes.length < list.length)) {

      existing.episodes = list;
      existing.total = list.length;
      added++;
    }
  }
  if (added > 0) {
    saveSeriesRegistry();
    console.log(`[Series] 从下载任务回填 ${added} 部短剧档案`);
  }
}

function saveDownloadTasks() {
  const serializable = downloadTasks.map((task) => {
    const { cancelSource, writer, ...rest } = task;
    return rest;
  });
  store.saveTasks(serializable);
  sendToRenderer('download-queue-changed', {});
}


let seriesRegistry = [];

function loadSeriesRegistry() {
  seriesRegistry = store.getSeries() || [];
}

function saveSeriesRegistry() {
  store.saveSeries(seriesRegistry);
}





function upsertSeriesRegistry(data) {
  if (!data || !data.series_id || !Array.isArray(data.episodes) || data.episodes.length === 0) return false;
  const sid = String(data.series_id);
  if (/^[1-9]\d{5,24}$/.test(sid) && !require('./src/native/playback-catalog').validCatalog(data, sid)) return false;
  const idx = seriesRegistry.findIndex((s) => String(s.series_id) === sid);
  const entry = {
    series_id: sid,
    series_title: data.series_title || '未命名短剧',
    cover: data.cover || '',
    total: data.episodes.length,
    web_accessible_episodes: data.web_accessible_episodes ?? null,
    episodes: data.episodes.map((e) => ({
      vid: String(e.vid),
      vid_index: e.vid_index || 0,
      title: e.title || '',
      cover: e.cover || '',
      web_available: e.web_available ?? null,
      locked: e.locked === true,
    })),
    updatedAt: Date.now(),
    dismissed: false,
    forgotten: false,
  };
  if (idx === -1) seriesRegistry.unshift(entry);
  else seriesRegistry[idx] = { ...seriesRegistry[idx], ...entry, dismissed: false };
  saveSeriesRegistry();
  return true;
}


function visibleSeries() {
  return seriesRegistry.filter((s) => !s.dismissed);
}






function pumpQueue() {
  if (quitCleanup) return;
  downloadQueue = downloadQueue.filter(task => task.status === 'pending');
  for (const task of downloadQueue) repairTaskDestination(task);
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    const index = downloadQueue.findIndex(task => !runningDownloads.has(task.id) && !runningDownloadPaths.has(task.savePath));
    if (index < 0) break;
    const [task] = downloadQueue.splice(index, 1);
    runningDownloads.add(task.id);
    runningDownloadPaths.add(task.savePath);
    activeDownloads++;
    downloadRuns.set(task.id, runTask(task));
  }
}

async function runTask(task) {
  const destination = task.savePath;
  try {
    await executeDownload(task);
  } catch (error) {
    console.error('[Download Queue] 下载失败:', error);
  } finally {
    activeDownloads--;
    runningDownloads.delete(task.id);
    runningDownloadPaths.delete(destination);
    downloadRuns.delete(task.id);
    pumpQueue();
  }
}


function processDownloadQueue() {
  pumpQueue();
}


function enqueuePendingTasks() {
  const pending = downloadTasks.filter(
    (t) => t.status === 'pending' && !downloadQueue.some((q) => q.id === t.id)
  );
  for (const t of pending) downloadQueue.push(t);
  return pending.length;
}


const SOURCE_RETRY_DELAYS = [3, 8, 15].map(minutes => minutes * 60000);
const TRANSFER_RETRY_DELAYS = [10, 30, 60].map(seconds => seconds * 1000);
const sourceRetryTimers = new Map();

function isDeferrableSourceError(task, error) {
  if (!/^\d{1,30}$/.test(String(task.hongguoInfo?.vid || ''))) return false;
  if (error?.code === 'SOURCE_UNAVAILABLE') {
    const sources = Array.isArray(error.sources) ? error.sources : [];
    return !sources.some(item => item.code === 'SECURITY_BLOCKED') && sources.some(item =>
      item.source === 'web' || /^(?:TIMEOUT|NETWORK_ERROR|HTTP_(?:408|5\d\d))$/.test(item.code));
  }
  if (error?.mediaStatus === 408 || error?.mediaStatus >= 500 && error?.mediaStatus <= 599) return true;
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ERR_BAD_RESPONSE', 'ERR_STREAM_PREMATURE_CLOSE', 'EAI_AGAIN',
    'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ERR_NETWORK', 'MEDIA_TRANSFER_ERROR'].includes(error?.code)) return true;
  return [404, 410].includes(error?.mediaStatus) && normalizeDownloadQuality(task.downloadQuality) === 'auto';
}

function armSourceRetry(task) {
  clearTimeout(sourceRetryTimers.get(task.id));
  const at = task.retryAt;
  sourceRetryTimers.set(task.id, setTimeout(() => {
    sourceRetryTimers.delete(task.id);
    if (task.status !== 'failed' || task.retryAt !== at || !downloadTasks.includes(task)) return;
    repairTaskDestination(task);

    task.status = 'pending'; task.progress = 0; task.receivedBytes = 0; task.totalBytes = 0; task.cancelled = false;
    delete task.error;
    if (!downloadQueue.some((t) => t.id === task.id)) downloadQueue.push(task);
    try { saveDownloadTasks(); }
    catch (error) {

      task.status = 'failed'; task.error = storageError?.error || error.message;
      delete task.retryAt;
      downloadQueue = downloadQueue.filter(t => t.id !== task.id);
      sendToRenderer('download-queue-changed', {});
      return;
    }
    sendToRenderer('download-queue-changed', {});
    pumpQueue();
  }, Math.max(1000, at - Date.now())));
}


function clearSourceRetry(task) {
  clearTimeout(sourceRetryTimers.get(task.id));
  sourceRetryTimers.delete(task.id);
  delete task.retryAt;
  delete task.sourceRetries;
}

function cancelScheduledRetries(tasks) {
  let changed = false;
  for (const task of tasks) {
    if (task.status !== 'failed' || (!task.retryAt && !sourceRetryTimers.has(task.id))) continue;
    clearSourceRetry(task);
    const reason = String(task.error || '').replace(/ 将在 .*后自动重试（\d+\/\d+）。$/, '');
    task.error = `${reason ? reason + '；' : ''}已取消自动重试，请手动重试`;
    changed = true;
  }
  return changed;
}





function pauseAllTasks() {
  let stopped = 0;
  for (const task of downloadTasks) {
    if (task.status === 'failed' && task.retryAt) {
      clearSourceRetry(task);
      task.status = 'stopped';
      task.error = '已手动暂停';
      stopped++;
    } else if (task.status === 'pending') {
      clearSourceRetry(task);
      task.status = 'stopped';
      task.error = '已手动暂停';
      task.endTime = Date.now();
      stopped++;
    } else if (task.status === 'downloading') {
      task.cancelled = true;
      if (task.cancelSource) {
        try { task.cancelSource.cancel('用户一键暂停'); } catch (_) {}
      }
      if (task.writer) {
        try { task.writer.destroy(); } catch (_) {}
      }
      task.status = 'stopped';
      delete task.cancelSource;
      delete task.writer;
      stopped++;
    }
  }
  downloadQueue = [];
  saveDownloadTasks();
  sendToRenderer('download-queue-changed', {});
  return stopped;
}





function resumeAllTasks() {
  let count = 0;
  for (const task of downloadTasks) {
    if (task.status !== 'stopped' && task.status !== 'failed' && task.status !== 'pending' && !(task.status === 'completed' && !hasCompleteTaskFile(task))) continue;

    clearSourceRetry(task);
    repairTaskDestination(task);
    task.status = 'pending';
    task.progress = 0;
    task.receivedBytes = 0;
    task.totalBytes = 0;
    task.cancelled = false;
    delete task.error;
    delete task.cancelSource;
    delete task.writer;

    if (!downloadQueue.some((t) => t.id === task.id)) downloadQueue.push(task);
    count++;
  }
  if (count > 0) {
    saveDownloadTasks();
    pumpQueue();
  }
  sendToRenderer('download-queue-changed', {});
  return count;
}


async function executeDownload(task) {
  if (task.type === 'hongguo') {
    await executeHongguoDownload(task);
    return;
  }
  throw new Error('未知任务类型: ' + task.type);
}


async function verifyDownloadQuality(file, quality, existing = false) {
  quality = normalizeDownloadQuality(quality);
  const ffprobe = resolveFfmpeg('ffprobe');
  if (!ffprobe) throw Object.assign(new Error('视频检查工具不可用，请修复安装后重试'), { code: 'LOCAL_MEDIA_TOOL_ERROR' });
  const info = await probeVideoInfo(ffprobe, file, undefined, true);
  const prefix = existing ? '已有本地文件' : '片源文件';
  if (!info || ![info.w, info.h, info.duration].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error(`${prefix}缺少有效视频轨、分辨率或时长，未完成下载${existing ? '；文件已保留，请先自行检查或移除' : ''}`);
  }
  if (!meetsDownloadQuality({ width: info.w, height: info.h }, quality)) {
    throw new Error(`${prefix}实际为 ${Math.min(info.w, info.h)}P（${info.w}×${info.h}），不满足 ${quality.toUpperCase()}${existing ? '；文件已保留，如需重新下载请先自行移除本地文件' : '，未自动降级'}`);
  }
  return `${Math.min(info.w, info.h)}p`;
}

function publishDownloadFile(temporary, destination) {

  require('./src/native/merge-runner').publishMergedOutput(temporary, destination);
  fs.unlinkSync(temporary);
}

async function executeHongguoDownload(task) {
  const { id, hongguoInfo, filename } = task;
  const { vid, series_title } = hongguoInfo || {};
  const source = axios.CancelToken.source();
  task.cancelSource = source;
  let tmpPath, writer;
  const updatePhase = (phase, data = {}) => {
    task.phase = phase;
    task.phaseSeconds = Number.isFinite(data.seconds) ? Math.max(0, data.seconds) : 0;
    task.phaseBytes = Number.isFinite(data.bytes) ? Math.max(0, data.bytes) : 0;
    sendToRenderer('download-progress', { id, progress: task.progress, phase, phaseSeconds: task.phaseSeconds, phaseBytes: task.phaseBytes });
  };
  try {
    task.status = 'downloading'; task.cancelled = false; task.progress = 0; delete task.retryAt;
    delete task.qualityNotice; delete task.actualQuality;
    updatePhase('downloading');
    sendToRenderer('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0, qualityNotice: '', actualQuality: null });
    const settings = getCurrentSettings();

    const quality = normalizeDownloadQuality(task.downloadQuality);
    const allowLowerQuality = quality !== 'auto' && /^\d{1,30}$/.test(String(vid));
    const notifyQuality = pixels => {
      const lower = allowLowerQuality && pixels > 0 && pixels < Number.parseInt(quality, 10);
      const notice = lower ? `正在下载更低质量片源：${pixels}P（原选 ${quality.toUpperCase()}）` : '';
      if (task.qualityNotice === notice) return;
      task.qualityNotice = notice;
      sendToRenderer('download-progress', { id, qualityNotice: notice });
    };
    const root = String(settings.root || '').trim() || app.getPath('downloads');
    const downloadDir = task.customDir || seriesDownloadDir(root, hongguoInfo?.series_id, series_title);
    fs.mkdirSync(downloadDir, { recursive: true });
    const finalPath = task.savePath || path.join(downloadDir, filename);
    task.savePath = finalPath;

    const checkedPlayInfo = /^(xifan|hema|custom):/.test(String(vid))
      ? await hongguo.fetchPlayUrlSingle(vid, hongguoInfo?.series_id, { quality }) : null;
    if (checkedPlayInfo && !checkedPlayInfo.url) throw new Error(checkedPlayInfo.error || '来源未开放该集');

    source.token.throwIfRequested();
    if (fs.existsSync(finalPath)) {
      if (!hasCompleteTaskFile(task)) throw new Error('已有本地文件不完整或路径冲突，文件已保留，请先自行检查或移除');
      task.actualQuality = await verifyDownloadQuality(finalPath, quality, true);
      source.token.throwIfRequested();
      task.status = 'completed'; task.progress = 100; task.endTime = Date.now(); delete task.sourceRetries;
      saveDownloadTasks(); sendToRenderer('download-completed', { id, path: finalPath });
      return;
    }
    tmpPath = finalPath + '.enc.tmp';
    const cached = onlineCache.get(onlineCacheKey(vid, quality)) || onlineCache.get(String(vid));
    const sourceId = /^custom:[^:]+/.exec(String(vid))?.[0] || /^(xifan|hema):/.exec(String(vid))?.[1] || 'hongguo';
    let reusedCache = false;
    if (cached?.complete && cached.vid === String(vid) && cached.source === sourceId
      && cached.seriesId === String(hongguoInfo?.series_id || '') && cached.size > 0
      && (cached.filePath || Buffer.isBuffer(cached.buffer) && cached.buffer.length === cached.size)) {
      if (cached.filePath) {
        cached.disk.readers = (cached.disk.readers || 0) + 1;
        try { await fsp.copyFile(cached.filePath, tmpPath); }
        finally { cached.disk.readers--; disposeOnlineDisk(cached); }
      } else await fsp.writeFile(tmpPath, cached.buffer, { mode: 0o600 });
      source.token.throwIfRequested();
      try { task.actualQuality = await verifyDownloadQuality(tmpPath, qualityForDeliveredFile(quality, cached)); reusedCache = true; }
      catch (_) { fs.unlinkSync(tmpPath); }
      source.token.throwIfRequested();
      checkCustomAccess(vid);
      if (reusedCache) {
        publishDownloadFile(tmpPath, finalPath);
        task.receivedBytes = task.totalBytes = cached.size;
        cached.lastUsed = Date.now();
      }
    }
    if (!reusedCache) await withMediaRecovery(vid, hongguoInfo?.series_id, { playInfo: checkedPlayInfo, quality, allowLowerQuality, force: true, cancelToken: source.token }, async playInfo => {
      const acceptedQuality = allowLowerQuality ? 'auto' : qualityForDeliveredFile(quality, playInfo);
      source.token.throwIfRequested();
      notifyQuality(Math.min(Number(playInfo.width), Number(playInfo.height)));
      task.progress = 0; task.receivedBytes = 0; task.totalBytes = 0;
      updatePhase('downloading');
      sendToRenderer('download-progress', { id, progress: 0, receivedBytes: 0, totalBytes: 0 });
      if (playInfo.format === 'hls') {
        await prepareHlsFile(playInfo,tmpPath,{cancelToken:source.token,onProgress:received => { task.receivedBytes = received; sendToRenderer('download-progress',{id,progress:0,receivedBytes:received,totalBytes:0}); }});
        task.actualQuality = await verifyDownloadQuality(tmpPath, acceptedQuality);
        if (allowLowerQuality) notifyQuality(Number.parseInt(task.actualQuality, 10));
        source.token.throwIfRequested(); checkCustomAccess(vid);
        publishDownloadFile(tmpPath,finalPath);
        return;
      }
      const response = await requestMedia(playInfo, { cancelToken: source.token });
      source.token.throwIfRequested();
      const totalLength = Number(response.headers['content-length']) || 0;
      task.totalBytes = totalLength;
      writer = fs.createWriteStream(tmpPath); task.writer = writer;
      let received = 0, lastProgress = 0;
      response.data.on('data', chunk => {
        received += chunk.length; task.receivedBytes = received;
        task.progress = totalLength ? Math.min(99, Math.floor(received / totalLength * 100)) : 0;
        if (Date.now() - lastProgress >= 150 || received === totalLength) {
          sendToRenderer('download-progress', { id, progress: task.progress, receivedBytes: received, totalBytes: totalLength });
          lastProgress = Date.now();
        }
      });

      await pipeline(response.data, writer);
      source.token.throwIfRequested();
      if (!received || (totalLength && received !== totalLength)) throw mediaTransferError('视频下载不完整，请重试');
      if (playInfo.contentKey) {
        const decodedPath = tmpPath + '.decoded';
        try {
          const phase = playInfo.codec === 'bytevc2' || playInfo.transcode === 'bytevc2' ? 'transcoding' : 'finalizing';
          updatePhase(phase);
          await decryptContentKeyFile(tmpPath, decodedPath, playInfo.contentKey, { cancelToken: source.token, codec: playInfo.codec, transcode: playInfo.transcode, onProgress: data => updatePhase(phase, data) });
          updatePhase('verifying');
          task.actualQuality = await verifyDownloadQuality(decodedPath, acceptedQuality);
          if (allowLowerQuality) notifyQuality(Number.parseInt(task.actualQuality, 10));
          source.token.throwIfRequested();
          publishDownloadFile(decodedPath, finalPath);
        } finally { try { fs.unlinkSync(decodedPath); } catch (_) {} }
        fs.unlinkSync(tmpPath);
      } else if (playInfo.spadeA) {
        const key = hongguo.deriveKey(playInfo.spadeA);
        if (!key) throw new Error('Key 派生失败');

        const decodedPath = tmpPath + '.decoded';
        try {
          updatePhase('finalizing');
          await decryptInWorker({ srcPath: tmpPath, dstPath: decodedPath, key }, { cancelToken: source.token });
          updatePhase('verifying');
          task.actualQuality = await verifyDownloadQuality(decodedPath, acceptedQuality);
          if (allowLowerQuality) notifyQuality(Number.parseInt(task.actualQuality, 10));
          source.token.throwIfRequested();
          publishDownloadFile(decodedPath, finalPath);
        }
        finally { try { fs.unlinkSync(decodedPath); } catch (_) {} }
        fs.unlinkSync(tmpPath);
      } else {
        updatePhase('verifying');
        task.actualQuality = await verifyDownloadQuality(tmpPath, acceptedQuality);
        if (allowLowerQuality) notifyQuality(Number.parseInt(task.actualQuality, 10));
        source.token.throwIfRequested();
        publishDownloadFile(tmpPath, finalPath);
      }
    });
    task.status = 'completed'; task.progress = 100; task.endTime = Date.now(); delete task.sourceRetries;
    if (task.qualityNotice) task.qualityNotice = task.qualityNotice.replace('正在下载', '已下载');
    saveDownloadTasks(); sendToRenderer('download-completed', { id, path: finalPath, actualQuality: task.actualQuality, qualityNotice: task.qualityNotice || '' });
  } catch (error) {
    if (writer && !writer.destroyed) writer.destroy();
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    task.qualityNotice = '';

    if (source.token.reason || axios.isCancel(error) || task.cancelled) {
      if (task.status !== 'pending') {
        task.status = 'stopped'; task.error = ''; task.endTime = Date.now();
        sendToRenderer('download-stopped', { id, qualityNotice: '' });
      }
    } else {
      const retries = task.sourceRetries || 0;
      task.status = 'failed'; task.error = error.message; task.endTime = Date.now();
      if (retries < SOURCE_RETRY_DELAYS.length && isDeferrableSourceError(task, error)) {
        const delays = error.code === 'SOURCE_UNAVAILABLE' || [404, 410].includes(error.mediaStatus)
          ? SOURCE_RETRY_DELAYS : TRANSFER_RETRY_DELAYS;
        const delay = delays[retries];
        task.sourceRetries = retries + 1; task.retryAt = Date.now() + delay;
        const wait = delays === SOURCE_RETRY_DELAYS ? `${delay / 60000} 分钟` : `${delay / 1000} 秒`;
        task.error = `${error.message} 将在 ${wait}后自动重试（${retries + 1}/${SOURCE_RETRY_DELAYS.length}）。`;
        armSourceRetry(task);
      }
      sendToRenderer('download-failed', { id, error: task.error, retryAt: task.retryAt || null, sourceRetries: task.sourceRetries || 0, qualityNotice: '' });
    }
    saveDownloadTasks();
  } finally {
    if (task.cancelSource === source) delete task.cancelSource;
    if (task.writer === writer) delete task.writer;
  }
}


function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}


ipcMain.handle('hongguo-resolve', async (event, input) => {
  try {
    const seriesId = await hongguo.resolveSeriesId(input);
    const data = await hongguo.fetchEpisodeList(seriesId);
    if (upsertSeriesRegistry(data) === false) return { success: false, error: '分集資料不完整，已保留原有紀錄。請稍後再試。' };
    return { success: true, data };
  } catch (error) {
    console.error('[Hongguo] 解析失败:', error.message);
    return { success: false, error: error.message };
  }
});


const SEARCH_SITE = 'https://hongguoduanju.com';
const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const SEARCH_TIMEOUT_MS = 15000;

function sourcePageUrl(value) {
  const url = new URL(value);
  if (url.origin !== SEARCH_SITE || url.username || url.password) throw new Error('仅允许打开红果来源页面');
  return url.href;
}

let searchWindow = null;
let sniffWindow = null;
let searchWindowReady = null;

function getSearchWindow(background = false) {
  const current = background ? sniffWindow : searchWindow;
  if (current && !current.isDestroyed()) return current;
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    title: '搜索 - 红果短剧',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try { win.loadURL(sourcePageUrl(url)).catch(() => {}); } catch (_) {}
    return { action: 'deny' };
  });
  for (const name of ['will-navigate', 'will-redirect']) {
    win.webContents.on(name, (event, url) => {
      try { sourcePageUrl(url); } catch (_) { event.preventDefault(); }
    });
  }
  win.on('closed', () => {
    if (searchWindow === win) searchWindow = null;
    if (sniffWindow === win) sniffWindow = null;
  });
  if (background) sniffWindow = win;
  else searchWindow = win;
  return win;
}






const SNIFFER_JS = `(() => {
  const out = [];
  const seen = new Set();
  const links = Array.from(document.querySelectorAll('a')).filter((a) =>
    /series_id=\\d{6,}/.test(a.getAttribute('href') || '')
  );
  for (const a of links) {
    const m = (a.getAttribute('href') || '').match(/series_id=(\\d{6,})/);
    if (!m) continue;
    const sid = m[1];
    if (seen.has(sid)) continue;
    seen.add(sid);

    const img = a.querySelector('img');
    let title = (img && img.getAttribute('alt')) || '';
    if (!title) {
      const t = a.querySelector('[class*="title"]');
      title = (t ? t.textContent : a.textContent || '').trim();
    }

    let cover = '';
    const pic = a.querySelector('picture');
    if (pic) {
      const src = pic.querySelector('source[srcset]');
      if (src) cover = (src.getAttribute('srcset') || '').split(' ')[0];
    }
    if (!cover && img) cover = img.getAttribute('src') || img.getAttribute('data-src') || '';

    let episode_count = 0;
    const epEl = a.querySelector('[class*="episode"]');
    if (epEl) {
      const em = (epEl.textContent || '').match(/(\\d+)\\s*集/);
      if (em) episode_count = parseInt(em[1], 10);
    }

    const tags = Array.from(a.querySelectorAll('[class*="tag-text"]'))
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 4);

    out.push({
      series_id: sid,
      series_title: title.trim(),
      cover: cover,
      episode_count: episode_count,
      tags: tags,
    });
  }
  return JSON.stringify(out);
})()`;





const BROWSE_META_JS = `(() => {
  const out = { page: 1, totalPages: 0, total: 0, genres: [] };

  try {
    const html = document.documentElement.innerHTML;
    const m = html.match(/"pagination":\\s*\\{[^}]*"total":(\\d+)[^}]*"pageNum":(\\d+)[^}]*"pageSize":(\\d+)[^}]*"totalPages":(\\d+)/);
    if (m) {
      out.total = parseInt(m[1], 10);
      out.page = parseInt(m[2], 10);
      out.totalPages = parseInt(m[4], 10);
    }
  } catch (e) {}

  if (!out.totalPages) {
    let maxPage = 0;
    document.querySelectorAll('a[href*="page="]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/[?&]page=(\\d+)/);
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    });
    out.totalPages = maxPage;
  }

  const seen = new Set();
  document.querySelectorAll('a[href*="/category/"]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\\/category\\/[a-z0-9\\-]+\\/([a-z0-9\\-]+)/);
    if (!m) return;
    const slug = m[1];
    const label = (a.textContent || '').trim();
    if (!label || label.length > 8 || seen.has(slug)) return;
    seen.add(slug);
    out.genres.push({ slug: slug, label: label });
  });

  return JSON.stringify(out);
})()`;


async function runSniffOnUrl(url, label, timeoutMs = SEARCH_TIMEOUT_MS) {
  const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : SEARCH_TIMEOUT_MS;

  const task = async () => {
    const win = getSearchWindow(true);

    const pollDeadline = Date.now() + budget * 0.8;
    let expired = false;
    const timeoutError = new Error('搜索超时，请稍后重试');
    const assertActive = () => {
      if (expired) throw timeoutError;
      if (win.isDestroyed()) throw new Error('搜索窗口已关闭，请重试');
    };
    const evaluate = async script => {
      assertActive();
      const value = await win.webContents.executeJavaScript(script, true);
      assertActive();
      return value;
    };
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        if (!win.isDestroyed()) win.destroy();
        reject(timeoutError);
      }, budget);
    });
    const sniff = async () => {
      console.log(`[${label}] 打开:`, url);
      try {
        await win.loadURL(url, { userAgent: SEARCH_UA });
      } catch (e) {

        console.warn(`[${label}] loadURL 返回异常（继续尝试读取）:`, e.message);
      }
      assertActive();

      let last = [];
      while (true) {
        assertActive();
        try {
          const raw = await evaluate(SNIFFER_JS);
          last = JSON.parse(raw || '[]');
        } catch (e) {
          assertActive();
          last = [];
        }
        if (last.length > 0 || Date.now() >= pollDeadline) break;
        await new Promise((r) => setTimeout(r, 400));
      }

      let meta = { page: 1, totalPages: 0, total: 0, genres: [] };
      try {
        meta = JSON.parse((await evaluate(BROWSE_META_JS)) || '{}');
      } catch (_) {}
      assertActive();

      if (!last.length) {
        let pageTitle = '';
        try { pageTitle = await evaluate('document.title'); } catch (_) {}
        assertActive();
        return { success: true, results: [], pageTitle, meta };
      }

      const results = last
        .filter((r) => r.series_id && r.series_title)
        .map((r) => ({
          ...r,
          url: `${SEARCH_SITE}/detail?series_id=${r.series_id}`,
        }));

      console.log(`[${label}] 命中 ${results.length} 部`);
      return { success: true, results, meta };
    };
    try { return await Promise.race([sniff(), timeout]); }
    finally { clearTimeout(timer); }
  };


  const prev = searchWindowReady || Promise.resolve();
  const next = prev.then(task, task);
  searchWindowReady = next.catch(() => {});
  return next;
}

async function runSearchSniff(keyword) {
  return require('./src/native/hongguo-catalog-search').searchHongguoCatalog(keyword, {
    sniff: (query) => runSniffOnUrl(`${SEARCH_SITE}/search/${encodeURIComponent(query)}`, 'Search', 8000),
  });
}


const BROWSE_CATEGORIES = [
  { slug: 'real-drama', label: '真人剧' },
  { slug: 'comic-drama', label: '漫剧' },
  { slug: 'ai-drama', label: 'AI剧' },
  { slug: 'comic', label: '漫画' },
  { slug: 'hot-drama', label: '综合热播榜', group: 'rank' },
  { slug: 'hot-real-drama', label: '真人热播榜', group: 'rank' },
  { slug: 'hot-comic-drama', label: '漫剧热播榜', group: 'rank' },
  { slug: 'hot-ai-drama', label: 'AI 热播榜', group: 'rank' },
];

ipcMain.handle('browse-categories', async () => BROWSE_CATEGORIES);
ipcMain.handle('browse-genres', async (_event, options) => {
  if (!BROWSE_CATEGORIES.some(item => item.slug === options?.category)) return { success: false, error: '請重新選擇分類。' };
  return require('./src/native/catalog').browseGenres({ category: options.category, forceRefresh: options.forceRefresh === true }, (authInfo, callback) => {
    if (matchesProxyAuth(authInfo)) callback(activeProxyAuth.username, activeProxyAuth.password);
    else callback();
  });
});

async function invalidateCustomSource(id) {
  require('./src/native/custom-source').cancelRequests(id);
  const prefix = `custom:${id}:`;
  for (const [streamId, session] of [...onlineSessions]) if (session.vid.startsWith(prefix)) releaseOnlineSession(streamId);
  for (const [key, job] of [...onlinePreparing]) if (key.startsWith(prefix)) { job.controller.abort(); onlinePreparing.delete(key); }
  for (const key of [...onlineCaptures.keys()]) if (key.startsWith(prefix)) abortOnlineCapture(key);
  for (const key of [...onlineCache.keys()]) if (key.startsWith(prefix)) deleteOnlineCacheEntry(key);
  for (const job of compatPreparing.values()) if (job.sourceVid.startsWith(prefix)) cancelCompatJob(job);
  await Promise.all(downloadTasks.filter(task => String(task.hongguoInfo?.vid).startsWith(prefix) && isTaskInFlight(task)).map(task => stopTaskAndWait(task).catch(() => {})));
  try { saveDownloadTasks(); } catch (_) {                                                                     }
}
ipcMain.handle('get-custom-sources', async () => ({success:true,sources:getCurrentSettings().custom_sources || []}));
ipcMain.handle('get-media-sources', async () => ({success:true,sources:[
  {id:'hongguo',label:'红果'},{id:'xifan',label:'西饭'},{id:'hema',label:'河马'},
  ...(getCurrentSettings().custom_sources || []).filter(source => source.enabled).map(source => ({id:`custom:${source.id}`,label:source.name,custom:true})),
]}));
ipcMain.handle('save-custom-source', async (_event,draft) => {
  try {
    const source = require('./src/native/custom-source').validateSource(draft);
    const settings = getCurrentSettings(), sources = settings.custom_sources || [];
    if (source.id && !sources.some(item => item.id === source.id)) throw new Error('播放源不存在');
    source.id ||= randomUUID();
    const next = sources.some(item => item.id === source.id) ? sources.map(item => item.id === source.id ? source : item) : [...sources,source];
    store.saveSettings({...settings,custom_sources:next});
    await invalidateCustomSource(source.id);
    return {success:true,source};
  } catch (error) { return {success:false,error:error.message}; }
});
ipcMain.handle('delete-custom-source', async (_event,id) => {
  try {
    const settings = getCurrentSettings();
    if (!(settings.custom_sources || []).some(source => source.id === id)) throw new Error('播放源不存在');
    store.saveSettings({...settings,custom_sources:settings.custom_sources.filter(source => source.id !== id)});
    await invalidateCustomSource(id); return {success:true};
  } catch (error) { return {success:false,error:error.message}; }
});
ipcMain.handle('test-custom-source', async (_event,draft) => {
  try { return await require('./src/native/custom-source').testCustomSource(draft); }
  catch (error) { return {success:false,error:error.message}; }
});


ipcMain.handle('browse-list', async (_event, options) => {
  const source = String(options?.source || '');
  const listed = await require(source.startsWith('custom:') ? './src/native/custom-source' : source === 'hema' ? './src/native/hema'
    : source === 'xifan' ? './src/native/xifan' : './src/native/catalog').browseList(options, (authInfo, callback) => {
      if (matchesProxyAuth(authInfo)) callback(activeProxyAuth.username, activeProxyAuth.password);
      else callback();
    });

  if (source.startsWith('custom:') || source === 'hema' || source === 'xifan' || !listed?.success || !Array.isArray(listed.results)) return listed;
  try {
    const releases = require('./src/native/hongguo-app-new');
    if (typeof releases.premiereIds !== 'function' || typeof releases.warmNewReleases !== 'function') return listed;
    if (!releases.premiereReady()) releases.warmNewReleases()?.catch?.(() => {});
    const ids = releases.premiereReady() ? releases.premiereIds() : null;
    if (ids && typeof ids.has === 'function') {
      for (const item of listed.results) {
        if (item && ids.has(String(item.series_id))) item.is_premiere = true;
      }
    }
  } catch {                        }
  return listed;
});

ipcMain.handle('list-premieres', async () => {
  try {
    const releases = require('./src/native/hongguo-app-new');
    if (typeof releases.premiereIds !== 'function' || typeof releases.warmNewReleases !== 'function') return { success: false, ids: [] };
    if (!releases.premiereReady()) {
      await Promise.race([
        Promise.resolve(releases.warmNewReleases()).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 4000)),
      ]);
    }
    return { success: true, ids: [...(releases.premiereIds() || [])] };
  } catch {
    return { success: false, ids: [] };
  }
});

let releaseProbe;
function getReleaseProbe() {
  if (!releaseProbe) {
    const { createReleaseProbe } = require('./src/native/release-availability');
    releaseProbe = createReleaseProbe({
      lookup: async (id) => {
        const { confirmedOffline } = require('./src/native/release-availability');
        try {
          const detail = await require('./src/native/hongguo').fetchEpisodeList(id);
          return Array.isArray(detail?.episodes) && detail.episodes.length > 0;
        } catch (error) {
          if (confirmedOffline(error)) return false;
          throw error;
        }
      },
    });
  }
  return releaseProbe;
}

let upcomingGeneration = 0;
ipcMain.handle('browse-upcoming', async (event) => {
  const sender = event.sender;
  const generation = ++upcomingGeneration;
  const send = (payload) => { if (generation === upcomingGeneration && !sender.isDestroyed()) sender.send('upcoming-page', payload); };
  try {
    const { fetchUpcomingPage, absorbUpcoming, MAX_PAGES } = require('./src/native/upcoming');
    const { releaseProbeIds, scheduleReleaseDrops, visibleUpcoming } = require('./src/native/release-availability');
    const { requestMetadata } = require('./src/native/app-source');
    const probe = getReleaseProbe();
    const gone = new Set();
    let state = { raw: [], items: [], offset: 0, sessionId: '', done: false };
    const visible = () => visibleUpcoming(state.items, { known: id => probe.known(id), gone });
    const publish = () => send({ items: visible(), done: state.done });
    const drops = scheduleReleaseDrops({
      ask: id => probe.ask(id),
      shouldStop: () => generation !== upcomingGeneration,
      onPlayable: id => { gone.add(String(id)); publish(); },
      onUnavailable: () => publish(),
      onUnknown: () => publish(),
    });
    const enqueue = () => {
      for (const item of state.items) {
        if (probe.known(item.series_id) === true) gone.add(String(item.series_id));
      }
      drops.push(releaseProbeIds(state.items).filter(id => probe.known(id) === undefined));
    };
    for (let page = 0; page < MAX_PAGES && !state.done; page += 1) {
      if (generation !== upcomingGeneration) return { success: true };
      const batch = await fetchUpcomingPage({ offset: state.offset, sessionId: state.sessionId }, (apiPath, values) => requestMetadata(apiPath, values));
      state = absorbUpcoming(state, batch, Date.now());
      if (page + 1 >= MAX_PAGES) state = { ...state, done: true };
      enqueue();
      publish();
    }
    return { success: true };
  } catch (error) {
    const hint = require('./src/native/cert-hint').certificateMessage(error);
    send({ done: true, error: hint || error?.message || '即将上线的短剧暂时载入失败' });
    return { success: false, error: hint || error?.message || '即将上线的短剧暂时载入失败' };
  }
});

ipcMain.handle('inspect-release', async (_event, entries) => {
  const list = Array.isArray(entries) ? entries : [];
  const now = Date.now();
  const probe = getReleaseProbe();
  const results = [];
  const seen = new Set();
  for (const entry of list) {
    const id = String(entry?.id || '').trim();
    const online = Number(entry?.online_time);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!Number.isFinite(online) || online <= 0 || online > now) {
      results.push({ id, playable: false, skipped: true });
      continue;
    }
    results.push({ id, playable: await probe.ask(id) });
  }
  return { success: true, results };
});



function prewarmBrowseLists() {
  const catalog = require('./src/native/catalog');
  const login = (authInfo, callback) => {
    if (matchesProxyAuth(authInfo)) callback(activeProxyAuth.username, activeProxyAuth.password);
    else callback();
  };
  for (const options of [{ category: 'hot-drama', page: 1 }, { category: 'real-drama', page: 1 }, { category: 'real-drama', page: 2 }]) {
    catalog.browseList(options, login).catch(() => {});
  }
  try { require('./src/native/hongguo-app-new').warmNewReleases()?.catch?.(() => {}); } catch {                      }
  try { resolveLibrempeg(); } catch {                         }
}

const comicReply = (work) => async (_event, payload) => {
  try { return { success: true, ...(await work(payload && typeof payload === 'object' ? payload : {})) }; }
  catch (error) {
    const hint = require('./src/native/comic').withNetworkHint;
    return { success: false, error: error?.message ? hint(error, getCurrentSettings().proxy_enabled === true) : '漫画服务暂时不可用', code: String(error?.code || '') };
  }
};
ipcMain.handle('comic-snapshot', comicReply(async () => ({ snapshot: require('./src/native/comic').service().snapshot() })));
ipcMain.handle('comic-extras', comicReply(async (payload) => require('./src/native/comic').service().extras({ exclude: payload.exclude, limit: payload.limit })));
ipcMain.handle('comic-episodes', comicReply(async (payload) => ({ ...(await require('./src/native/comic').service().episodes(payload.seriesId)) })));
ipcMain.handle('comic-chapter', comicReply(async (payload) => ({ ...(await require('./src/native/comic').service().chapter({ itemId: payload.itemId, width: payload.width, priority: payload.priority })) })));
ipcMain.handle('comic-image', comicReply(async (payload) => ({ ...(await require('./src/native/comic').service().image({ itemId: payload.itemId, index: payload.index })) })));
ipcMain.handle('comic-cancel-prefetch', comicReply(async () => ({ cancelled: require('./src/native/comic').service().cancelPrefetch() })));

function catalogQuery(keyword) {
  const typed = String(keyword || '').trim();
  const simplified = require('./src/native/script-query').toSimplified(typed).trim();
  return simplified || typed;
}

const SEARCH_LAST_PAGE = 50;
function searchPageOf(value) {
  return Number.isInteger(value) && value >= 1 && value <= SEARCH_LAST_PAGE ? value : 1;
}

async function searchAtSource(keyword, options = {}) {
  const page = searchPageOf(options?.page);
  if (String(options?.source).startsWith('custom:')) return require('./src/native/custom-source').searchSeries(keyword, { ...options, page });
  if (options?.source === 'hema') return require('./src/native/hema').search(catalogQuery(keyword), page);
  if (options?.source === 'xifan') return require('./src/native/xifan').search(catalogQuery(keyword), page);
  if (options?.source && options.source !== 'hongguo') throw new Error('不支持的搜索来源');
  if (page === 1) return runSearchSniff(keyword);
  const found = await require('./src/native/hongguo-search').searchHongguo(catalogQuery(keyword), { page, timeout: 8000 });
  return { success: true, results: found.results || [], page, total: found.total || 0, totalPages: found.totalPages || 0, hasMore: found.hasMore === true, keyword: found.keyword || '', channel: 'web' };
}

ipcMain.handle('search-series', async (event, keyword, options = {}) => {
  try {
    const page = searchPageOf(options?.page);
    if (page > 1) {
      const kw = String(keyword || '').trim();
      if (!kw || kw.length > 200) return { success: false, results: [], error: '请输入 1 至 200 字的搜索词' };
      const more = await searchAtSource(kw, { source: options?.source, page });
      return more?.success ? more : { success: false, results: [], error: more?.error || '搜索暂不可用' };
    }
    return await seriesSearch.searchSeries(keyword, kw => searchAtSource(kw, { ...options, page: 1 }));
  } catch (error) {
    console.error('[Search] 失败:', error.message);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('find-series-sequels', async (_event, seriesId, options = {}) => {
  const entry = seriesRegistry.find(item => String(item.series_id) === String(seriesId));
  if (!entry) return { success: false, results: [], error: '未找到该剧档案，请先打开剧集详情。' };
  return seriesSearch.findSeriesSequels(entry, seriesRegistry.filter(item => !item.forgotten),
    kw => searchAtSource(kw, { source: watchHistory.sourceOf(String(entry.series_id)) }),
    { localOnly: options?.localOnly === true });
});


ipcMain.handle('search-resolve', async (event, seriesId) => {
  try {
    if (!seriesId) return { success: false, error: '缺少 series_id' };
    const data = await hongguo.fetchEpisodeList(String(seriesId));
    if (watchHistory.sourceOf(String(seriesId)) === 'hongguo' && !require('./src/native/playback-catalog').validCatalog(data, String(seriesId))) return { success: false, error: '分集資料不完整，已保留原有紀錄。請稍後再試。' };
    if (upsertSeriesRegistry(data) === false) return { success: false, error: '分集資料不完整，已保留原有紀錄。請稍後再試。' };
    return { success: true, data };
  } catch (error) {
    console.error('[Search] 拉取分集失败:', error.message);
    return { success: false, error: error.message };
  }
});


ipcMain.handle('search-window-show', async (event, visible, sourceUrl) => {
  let target;
  try { if (sourceUrl) target = sourcePageUrl(sourceUrl); }
  catch (error) { return { success: false, error: error.message }; }
  const win = getSearchWindow();
  if (target) {
    try { await win.loadURL(target, { userAgent: SEARCH_UA }); }
    catch (error) { return { success: false, error: error.message }; }
  }
  if (visible) {
    win.show();
    win.focus();
  } else {
    win.hide();
  }
  return { success: true };
});


ipcMain.handle('get-series-list', async (event, options) => {
  const list = visibleSeries();

  return options?.downloadedOnly === true
    ? list.filter(series => collectSeriesEpisodeFiles(series.series_id, series.series_title).ordered.length > 0)
    : list;
});


ipcMain.handle('remove-series', async (event, seriesId) => {
  const sid = String(seriesId);
  const entry = seriesRegistry.find((s) => String(s.series_id) === sid);
  if (!entry) return { success: false, error: '未找到该剧' };
  entry.dismissed = true;
  saveSeriesRegistry();
  return { success: true };
});


ipcMain.handle('forget-series', async (_event, seriesId) => {
  try {
    const sid = String(seriesId);
    if (!seriesRegistry.some(entry => String(entry.series_id) === sid)) return { success: false, error: '未找到该剧' };
    const next = seriesRegistry.map(entry => String(entry.series_id) === sid ? { ...entry, dismissed: true, forgotten: true } : entry);
    store.saveSeries(next);
    seriesRegistry = next;
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});


ipcMain.handle('purge-empty-series', async () => {
  let removed = 0;
  for (const s of seriesRegistry) {
    if (s.dismissed) continue;
    const files = collectSeriesEpisodeFiles(s.series_id, s.series_title);
    const hasDiskFile = [...files.episodePaths, ...files.mergedPaths].some(file => {
      try { return fs.statSync(file).size > 1024 * 100; } catch (_) { return false; }
    });
    if (!hasDiskFile && !files.scanFailed) {
      s.dismissed = true;
      removed++;
    }
  }
  if (removed > 0) saveSeriesRegistry();
  return { success: true, count: removed };
});






function rescanDownloadsFromDisk() {
  let added = 0;
  for (const s of seriesRegistry) {
    const sid = String(s.series_id);
    let scanned;
    try {
      scanned = collectSeriesEpisodeFiles(sid, s.series_title);
    } catch (_) {
      continue;
    }
    if (!scanned.dir || !scanned.ordered.length) continue;

    const existing = new Set(
      downloadTasks
        .filter((t) => t.hongguoInfo && String(t.hongguoInfo.series_id) === sid)
        .map((t) => Number(t.hongguoInfo.vid_index))
    );

    for (const f of scanned.ordered) {
      if (existing.has(f.vid_index)) continue;
      const ep = (s.episodes || []).find((e) => Number(e.vid_index) === f.vid_index);
      let size = 0;
      try { size = fs.statSync(f.path).size; } catch (_) {}
      downloadTasks.unshift({
        id: 'rescanned_' + randomUUID(),
        batchId: 'rescanned',
        savePath: f.path,
        customDir: scanned.dir,
        filename: f.filename,
        title: `《${s.series_title}》第${String(f.vid_index).padStart(3, '0')}集`,
        platform: 'hongguo',
        type: 'hongguo',
        status: 'completed',
        progress: 100,
        receivedBytes: size,
        totalBytes: size,
        startTime: Date.now(),
        videoInfo: {
          author: s.series_title,
          title: `《${s.series_title}》第${String(f.vid_index).padStart(3, '0')}集`,
          cover: s.cover || '',
          aweme_id: ep ? ep.vid : '',
        },
        hongguoInfo: {
          vid: ep ? ep.vid : '',
          series_id: sid,
          series_title: s.series_title,
          vid_index: f.vid_index,
          ep_title: ep ? ep.title : '',
        },
      });
      existing.add(f.vid_index);
      added++;
    }
  }
  if (added > 0) saveDownloadTasks();
  console.log(`[Rescan] 从磁盘补回 ${added} 条下载记录`);
  return { success: true, count: added };
}

ipcMain.handle('rescan-downloads', async () => {
  try {
    return rescanDownloadsFromDisk();
  } catch (error) {
    console.error('[Rescan] 失败:', error.message);
    return { success: false, error: error.message };
  }
});


ipcMain.handle('restore-dismissed-series', async () => {
  let n = 0;
  for (const s of seriesRegistry) {
    if (s.dismissed && !s.forgotten) { s.dismissed = false; n++; }
  }
  if (n > 0) saveSeriesRegistry();
  return { success: true, count: n };
});

ipcMain.handle('dismissed-count', async () => seriesRegistry.filter((s) => s.dismissed && !s.forgotten).length);


let mergeTasks = [];
const mergeRuns = new Map();

function resolveFfmpeg(name) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;

  const devLookup = typeof app !== 'undefined' && app.isPackaged !== true;
  const candidates = [

    process.resourcesPath ? path.join(process.resourcesPath, 'bin', executable) : null,
    path.join(__dirname, 'build', 'ffmpeg', `${process.platform}-${process.arch}`, executable),
    path.join(__dirname, 'build', 'ffmpeg', executable),
  ];
  if (devLookup) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const bare = process.platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir;
      if (bare) candidates.push(path.join(bare, executable));
    }
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      fs.accessSync(c, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch (_) {}
  }

  if (!devLookup || process.platform !== 'win32' || !process.env.LOCALAPPDATA) return null;
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    if (base && fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (!/ffmpeg/i.test(d)) continue;
        const exe = path.join(base, d);
        const found = findFileRecursive(exe, `${name}.exe`, 6);
        if (found) return found;
      }
    }
  } catch (_) {}
  return null;
}

function resolveLibrempeg() {
  const found = resolveFfmpeg('librempeg');
  try { require('./src/native/app-source').setBytevc2Ready(Boolean(found)); } catch {                    }
  return found;
}

function findFileRecursive(dir, fileName, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const r = findFileRecursive(path.join(dir, e.name), fileName, depth - 1);
    if (r) return r;
  }
  return null;
}

function probeDuration(ffprobePath, file, task) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const child = execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { timeout: 30000 },
      (err, stdout) => {
        if (task?.child === child) delete task.child;
        if (err) return resolve(0);
        const d = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(d) ? d : 0);
      });
    if (task) task.child = child;
  });
}

function probeVideoInfo(ffprobePath, file, task, rejectToolErrors = false) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const child = execFile(ffprobePath, ['-v', 'error', '-show_data_hash', 'sha256',
      '-show_entries', 'stream=codec_type,codec_name,codec_tag_string,profile,level,width,height,pix_fmt,sample_aspect_ratio,r_frame_rate,time_base,extradata_hash,sample_rate,channels,channel_layout,bit_rate,color_range,color_space,color_transfer,color_primaries,field_order:format=duration,bit_rate,size', '-of', 'json', file],
      { timeout: 30000 }, (err, stdout) => {
        if (task?.child === child) delete task.child;
        if (err) {
          if (rejectToolErrors && (typeof err.code === 'string' || err.killed)) {
            return reject(Object.assign(new Error('视频检查工具无法运行，请检查安装与权限后重试'), { code: 'LOCAL_MEDIA_TOOL_ERROR', cause: err }));
          }
          return resolve(null);
        }
        try { resolve(require('./src/native/merge-plan').readMergeInfo(JSON.parse(stdout))); }
        catch (_) { resolve(null); }
      });
    if (task) task.child = child;
  });
}

ipcMain.handle('get-ffmpeg-status', async () => {
  const ff = resolveFfmpeg('ffmpeg');
  const fp = resolveFfmpeg('ffprobe');
  return { success: true, ffmpeg: ff, ffprobe: fp, available: !!ff && !!fp };
});

function pathInside(root, target) {
  if (!root || !target) return false;
  let base = path.resolve(String(root));
  let file = path.resolve(String(target));
  try { if (fs.existsSync(base)) base = fs.realpathSync(base); } catch (_) {}
  try { if (fs.existsSync(file)) file = fs.realpathSync(file); } catch (_) {}
  if (process.platform === 'win32') {
    base = base.toLowerCase();
    file = file.toLowerCase();
  }
  const rel = path.relative(base, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function mediaRoots() {
  const roots = [];
  try {
    const root = String(getCurrentSettings().root || '').trim();
    if (root) roots.push(root);
  } catch (_) {}
  try {
    const downloads = app.getPath('downloads');
    if (downloads) roots.push(downloads);
  } catch (_) {}
  return roots;
}

function isInsideMediaRoot(target) {
  return mediaRoots().some((root) => pathInside(root, target));
}

function isRecordedMediaFile(target, episode) {
  try {
    if (!fs.lstatSync(target).isFile()) return false;
    const matches = (recorded, dir) => typeof recorded === 'string'
      && path.relative(path.resolve(recorded), path.resolve(target)) === ''
      && pathInside(dir || path.dirname(recorded), target);
    if (downloadTasks.some(task => matches(task.savePath, task.customDir)
      && (!episode || (hasCompleteTaskFile(task)
        && String(task.hongguoInfo?.series_id) === String(episode.seriesId)
        && Number(task.hongguoInfo?.vid_index) === Number(episode.vidIndex)
        && (!episode.vid || String(task.hongguoInfo?.vid) === String(episode.vid)))))) return true;
    return !episode && mergeTasks.some(task => matches(task.output));
  } catch (_) { return false; }
}


ipcMain.handle('show-in-folder', async (event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath.trim()) return { success: false, error: '缺少路径' };
    const resolved = path.resolve(filePath);
    const recorded = isRecordedMediaFile(resolved);
    if (!isInsideMediaRoot(resolved) && !recorded) return { success: false, error: '只能打开下载目录中的文件' };
    let target = resolved;
    if (!fs.existsSync(target)) target = path.dirname(resolved);
    if ((!isInsideMediaRoot(target) && !recorded) || !fs.existsSync(target)) return { success: false, error: '路径不存在' };
    const stat = fs.statSync(target);
    if (!stat.isFile() && !stat.isDirectory()) return { success: false, error: '路径不存在' };
    shell.showItemInFolder(target);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-merge-tasks', async () => mergeTasks.map(({ child, ...rest }) => rest));

function seriesDownloadDir(root, seriesId, seriesTitle) {
  const title = sanitizeFolderName(seriesTitle) || '未命名短剧';
  const suffix = createHash('sha256').update(String(seriesId)).digest('hex').slice(0, 12);
  return path.join(root, String(seriesId).startsWith('hema:') ? '河马短剧' : String(seriesId).startsWith('xifan:') ? '西饭短剧' : '红果短剧', `${title}-${suffix}`);
}


function resolveSeriesDir(seriesId, seriesTitle, covers) {
  const fromTask = covers.find((t) => t.customDir && fs.existsSync(t.customDir));
  if (fromTask) return fromTask.customDir;
  const fromFile = covers.find(t => t.savePath && fs.existsSync(path.dirname(t.savePath)));
  if (fromFile) return path.dirname(fromFile.savePath);
  const settings = getCurrentSettings();
  const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : app.getPath('downloads');
  const guess = seriesDownloadDir(root, seriesId, seriesTitle);
  if (fs.existsSync(guess)) return guess;

  if (!/^(xifan|hema|custom):/.test(String(seriesId))) {
    const title = sanitizeFolderName(seriesTitle) || '未命名短剧';
    const owners = seriesRegistry.filter(s => sanitizeFolderName(s.series_title) === title);
    const legacy = path.join(root, '红果短剧', title);
    if (owners.length <= 1 && fs.existsSync(legacy)) return legacy;
  }
  return null;
}

function hasCompleteTaskFile(task) {
  if (!task?.savePath || task.pathConflict) return false;
  if (downloadTasks.some(other => other !== task && other.savePath === task.savePath && String(other.hongguoInfo?.vid) !== String(task.hongguoInfo?.vid))) return false;
  try { const stat = fs.statSync(task.savePath); return stat.isFile() && stat.size > 1024 * 100; }
  catch (_) { return false; }
}

function repairTaskDestination(task) {
  const conflicts = downloadTasks.filter(other => other !== task && other.savePath === task.savePath && String(other.hongguoInfo?.vid) !== String(task.hongguoInfo?.vid));
  if (conflicts.length) for (const item of [task, ...conflicts]) item.pathConflict = true;
  if (!task.pathConflict) return;
  const settings = getCurrentSettings(), info = task.hongguoInfo || {};
  task.customDir = seriesDownloadDir(settings.root || app.getPath('downloads'), info.series_id, info.series_title);
  const filename = uniqueEpisodeFilename(settings, info.series_title, { vid_index: info.vid_index, title: info.ep_title });
  const suffix = createHash('sha256').update(String(info.vid)).digest('hex').slice(0, 8);
  task.filename = filename.replace(/\.mp4$/, `-${suffix}.mp4`);
  task.savePath = path.join(task.customDir, task.filename);
  task.pathConflict = false;
}

function uniqueEpisodeFilename(settings, title, episode) {
  const index = String(episode.vid_index).padStart(3, '0');
  const format = settings.name_format || '';
  const rendered = renderName(format, title, episode.vid_index, episode.title) || title;
  return `${rendered}${/集数|vid_index/.test(format) ? '' : `_第${index}集`}.mp4`;
}

function episodeFilePaths(file) {
  return [file, file + '.enc.tmp', file + '.enc.tmp.decoded'];
}

function ownsEpisodeFiles(file, owners) {
  const paths = new Set(episodeFilePaths(file));
  return !downloadTasks.some(task => paths.has(task.savePath) && !owners.includes(task))
    && !mergeTasks.some(task => paths.has(task.output));
}






function collectSeriesEpisodeFiles(seriesId, seriesTitle) {
  const sid = String(seriesId);
  const tasks = downloadTasks.filter(
    (t) => t.hongguoInfo && String(t.hongguoInfo.series_id) === sid && t.savePath
  );
  const dir = resolveSeriesDir(sid, seriesTitle, tasks);

  const byIndex = new Map();
  const exists = (p) => {
    try { return fs.existsSync(p) && fs.statSync(p).size > 1024 * 100; } catch (_) { return false; }
  };


  for (const t of tasks) {
    if (!hasCompleteTaskFile(t) || !ownsEpisodeFiles(t.savePath, tasks)) continue;
    const idx = Number(t.hongguoInfo.vid_index) || 0;
    if (!idx) continue;
    const prev = byIndex.get(idx);
    if (!prev || (t.startTime || 0) > (prev.startTime || 0)) {
      byIndex.set(idx, { vid_index: idx, startTime: t.startTime || 0, path: t.savePath, filename: t.filename || path.basename(t.savePath) });
    }
  }




  const sharedDirectory = dir && (downloadTasks.some(task => String(task.hongguoInfo?.series_id) !== sid && task.savePath && path.dirname(task.savePath) === dir)
    || mergeTasks.some(task => String(task.seriesId) !== sid && task.output && path.dirname(task.output) === dir));
  const registeredPaths = new Set([...downloadTasks.map(task => task.savePath), ...mergeTasks.map(task => task.output)].filter(Boolean));
  const episodePaths = new Set(tasks.map(task => task.savePath).filter(file => ownsEpisodeFiles(file, tasks)));
  const episodeNames = new Map();
  const formats = new Set([getCurrentSettings().name_format, '剧名 集数', '剧名 集数 标题', '剧名']);
  const entry = seriesRegistry.find(series => String(series.series_id) === sid);

  const ambiguousTitle = sharedDirectory && (seriesRegistry.some(series => String(series.series_id) !== sid && sanitizeFolderName(series.series_title) === sanitizeFolderName(seriesTitle))
    || downloadTasks.some(task => String(task.hongguoInfo?.series_id) !== sid && task.savePath && path.dirname(task.savePath) === dir && sanitizeFolderName(task.hongguoInfo?.series_title || '') === sanitizeFolderName(seriesTitle)));
  if (!ambiguousTitle) for (const episode of entry?.episodes || []) {
    for (const name_format of formats) {
      if (sharedDirectory && !/剧名|\bseries_title\b/.test(name_format || '')) continue;
      episodeNames.set(uniqueEpisodeFilename({ name_format }, seriesTitle, episode), Number(episode.vid_index));
    }
  }
  let names = [], scanFailed = 0;
  if (dir) {
    try { names = fs.readdirSync(dir); } catch (_) { scanFailed = 1; }
    for (const name of episodeNames.keys()) {
      const full = path.join(dir, name);
      if (ownsEpisodeFiles(full, tasks)) episodePaths.add(full);
    }
    for (const n of names) {
      if (!/\.mp4$/i.test(n) || n.includes('合集')) continue;
      const m = !sharedDirectory && n.match(/(\d{1,4})\.mp4$/i);
      const idx = episodeNames.get(n) || (m ? parseInt(m[1], 10) : 0);
      if (!idx || byIndex.has(idx)) continue;
      const full = path.join(dir, n);
      if (registeredPaths.has(full) || !ownsEpisodeFiles(full, tasks)) continue;
      if (exists(full)) byIndex.set(idx, { vid_index: idx, path: full, filename: n });
    }
  }
  for (const episode of byIndex.values()) episodePaths.add(episode.path);
  const temporaryPaths = new Set();
  for (const file of episodePaths) {
    if (!isFileInUse(file)) { temporaryPaths.add(file + '.enc.tmp'); temporaryPaths.add(file + '.enc.tmp.decoded'); }
  }
  const foreignOutputs = new Set(mergeTasks.filter(task => String(task.seriesId) !== sid).map(task => task.output));
  const mergedPaths = new Set(mergeTasks.filter(task => String(task.seriesId) === sid && task.output && !foreignOutputs.has(task.output)
    && !downloadTasks.some(download => download.savePath === task.output)).map(task => task.output));
  const concatPaths = new Set();
  if (dir && !sharedDirectory) {
    const safeTitle = sanitizeFolderName(seriesTitle);
    for (const name of names) {
      const full = path.join(dir, name);
      if (!safeTitle || foreignOutputs.has(full) || downloadTasks.some(task => task.savePath === full)) continue;
      const stem = name.replace(/(?: \(\d+\))?\.mp4$/, '');
      if (name.endsWith('.mp4') && (stem === `${safeTitle}_合集` || stem === `${safeTitle} 合集`)) mergedPaths.add(full);
      if (name === `${safeTitle}.ffconcat.txt`) concatPaths.add(full);
    }
  }

  return {
    dir, sharedDirectory, episodeNames, episodePaths, temporaryPaths, mergedPaths, concatPaths, scanFailed,
    ordered: [...byIndex.values()].sort((a, b) => a.vid_index - b.vid_index),
  };
}

ipcMain.handle('merge-series', async (event, seriesId, outputName, options) => {
  try {
    if (mergeTempCleanup) await mergeTempCleanup;
    const sid = String(seriesId);
    const entry = seriesRegistry.find(s => String(s.series_id) === sid);
    const seriesTitle = entry?.series_title || downloadTasks.find(t => String(t.hongguoInfo?.series_id) === sid)?.hongguoInfo.series_title || '未命名短剧';
    const { dir, ordered } = collectSeriesEpisodeFiles(sid, seriesTitle);
    if (!ordered.length) return { success: false, error: '该剧还没有已下载完成的分集' };
    const ffmpegPath = resolveFfmpeg('ffmpeg'), ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath || !ffprobePath) return { success: false, error: '未找到完整 FFmpeg 工具，无法检查并合并分集' };
    if (mergeTasks.some(t => t.status === 'running')) return { success: false, error: '已有合并任务正在运行，请等待完成或先取消' };
    const outDir = dir || path.dirname(ordered[0].path);
    const baseName = outputName && String(outputName).trim() ? sanitizeFolderName(outputName) : `${sanitizeFolderName(seriesTitle)}_合集`;
    if (!baseName || baseName === '.' || baseName === '..') return { success: false, error: '请输入有效输出名称' };
    let output = path.join(outDir, `${baseName}.mp4`);
    for (let number = 2; fs.existsSync(output); number++) output = path.join(outDir, `${baseName} (${number}).mp4`);
    const totalBytes = ordered.reduce((sum, e) => sum + fs.statSync(e.path).size, 0);
    const id = 'merge_' + randomUUID();
    const task = { id, seriesId: sid, seriesTitle, output, outputName: path.basename(output), total: ordered.length,
      done: 0, checked: 0, progress: 0, status: 'running', stage: 'checking', stageText: '检查分集', totalBytes,
      totalDuration: 0, codecWarning: '', error: '', startTime: Date.now(), elapsedSeconds: 0, speed: 0, etaSeconds: null };
    mergeTasks.unshift(task);
    if (!saveMergeTasks()) { mergeTasks = mergeTasks.filter(t => t.id !== id); return { success: false, error: '无法保存合并任务，请检查存储错误提示后重试' }; }
    sendToRenderer('merge-task-added', { ...task });
    const { runMerge } = require('./src/native/merge-runner');
    const run = (async () => {
      try {
        await runMerge({ task, ordered, outDir, ffmpegPath, ffprobePath, probe: probeVideoInfo,
          pickEncoder: pickH264Encoder, compatible: !!options?.compatible,
          update: () => { const { child, ...data } = task; sendToRenderer('merge-progress', data); } });
      } catch (error) {
        task.status = task.cancelled ? 'stopped' : 'failed';
        task.stage = task.status; task.stageText = task.cancelled ? '已取消' : '合并失败';
        task.error = task.cancelled ? '已取消' : error.message;
      } finally {
        task.endTime = Date.now();
        if (!saveMergeTasks()) task.storageWarning = '合并记录未保存，导出文件状态请以磁盘为准';
        sendToRenderer(task.status === 'completed' ? 'merge-completed' : 'merge-failed', { id, path: output, error: task.error, verified: task.verified, storageWarning: task.storageWarning });
      }
    })().catch(error => console.error('[Merge] 任务通知失败:', error.message)).finally(() => mergeRuns.delete(id));
    mergeRuns.set(id, run);
    return { success: true, id, output, outputName: task.outputName, count: ordered.length, totalBytes, totalDuration: 0, codecWarning: '' };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('cancel-merge', async (event, id) => {
  const task = mergeTasks.find(m => m.id === id);
  if (!task) return { success: false, error: '任务不存在' };
  if (task.status !== 'running') return { success: false, error: '任务已结束' };
  task.cancelled = true;
  require('./src/native/merge-runner').stopMergeChildren(task);
  return { success: true };
});

ipcMain.handle('delete-merge-task', async (event, id) => {
  const task = mergeTasks.find(m => m.id === id);
  if (task?.status === 'running') return { success: false, error: '请先取消合并，再移除记录' };
  const previous = mergeTasks;
  mergeTasks = mergeTasks.filter(m => m.id !== id);
  if (!saveMergeTasks()) { mergeTasks = previous; return { success: false, error: '无法保存任务记录' }; }
  return { success: true };
});

function saveMergeTasks() {
  try { store.saveMergeTasks(mergeTasks.map(({ child, ...rest }) => rest)); return true; }
  catch (error) { console.error('[Merge] 保存任务失败:', error.message); return false; }
}

function loadMergeTasks() {
  try {
    mergeTasks = (store.getMergeTasks() || []).map(t => t.status === 'running'
      ? { ...t, status: 'stopped', stage: 'stopped', stageText: '已中断', error: '应用关闭时中断', endTime: Date.now() } : t);
  } catch (_) { mergeTasks = []; }
  const directories = [...new Set(mergeTasks.filter(task => typeof task.output === 'string' && path.isAbsolute(task.output)).map(task => path.dirname(task.output)))];
  mergeTempCleanup = require('./src/native/merge-runner').cleanupMergeTemps(directories)
    .catch(() => console.warn('[Merge] 部分遗留临时文件未能清理'))
    .finally(() => { mergeTempCleanup = null; });
}






ipcMain.handle('get-series-episodes', async (event, seriesId) => {
  try {
    const sid = String(seriesId);
    const entry = seriesRegistry.find((s) => String(s.series_id) === sid);
    const tasks = downloadTasks.filter((t) => t.hongguoInfo && String(t.hongguoInfo.series_id) === sid);


    const taskByIndex = new Map();
    for (const t of tasks) {
      const idx = Number(t.hongguoInfo.vid_index);
      const prev = taskByIndex.get(idx);
      if (!prev || (t.startTime || 0) > (prev.startTime || 0)) taskByIndex.set(idx, t);
    }

    const baseEpisodes =
      entry && entry.episodes.length
        ? entry.episodes
        : tasks.map((t) => ({
            vid: t.hongguoInfo.vid,
            vid_index: t.hongguoInfo.vid_index,
            title: t.hongguoInfo.ep_title || '',
          }));



    const seriesTitle = (entry && entry.series_title) ||
      (tasks[0] && tasks[0].hongguoInfo.series_title) || '未命名短剧';
    let scannedByIndex = new Map();
    let seriesDir = null;
    try {
      const scanned = collectSeriesEpisodeFiles(sid, seriesTitle);
      seriesDir = scanned.dir;
      for (const e of scanned.ordered) scannedByIndex.set(Number(e.vid_index), e);
    } catch (_) {}

    const episodes = baseEpisodes
      .map((ep) => {
        const idx = Number(ep.vid_index);
        const t = taskByIndex.get(idx);
        let status = 'missing';
        let fileUrl = null;
        let progress = 0;
        let fileSize = 0;
        let savePath = null;

        if (t && t.savePath) {
          savePath = t.savePath;
          if (fs.existsSync(t.savePath)) {
            fileSize = fs.statSync(t.savePath).size;
          }
          if (hasCompleteTaskFile(t)) {
            status = 'completed';
            fileUrl = localPlayUrl(t.savePath);
          } else if (t.status === 'downloading') {
            status = 'downloading';
            progress = t.progress || 0;
          } else if (t.status === 'pending') {
            status = 'pending';
          } else {
            status = t.status === 'completed' ? 'missing' : t.status;
          }
        }


        if (status === 'missing') {
          const f = scannedByIndex.get(idx);
          if (f) {
            savePath = f.path;
            fileUrl = localPlayUrl(f.path);
            try { fileSize = fs.statSync(f.path).size; } catch (_) {}
            status = 'completed';
          }
        }

        return {
          vid: ep.vid,
          vid_index: idx,
          title: ep.title || '',
          web_available: ep.web_available ?? null,
          locked: ep.locked === true,
          taskId: t ? t.id : null,
          error: t?.error || '',
          retryAt: t?.retryAt || null,
          actualQuality: t?.actualQuality || null,
          phase: status === 'downloading' ? t?.phase || 'downloading' : '',
          phaseSeconds: t?.phaseSeconds || 0,
          phaseBytes: t?.phaseBytes || 0,
          status,
          progress,
          fileSize,
          fileUrl,
          savePath,
        };
      })
      .sort((a, b) => a.vid_index - b.vid_index);

    const completedCount = episodes.filter((e) => e.status === 'completed').length;
    return {
      success: true,
      data: {
        series_id: sid,
        series_title: seriesTitle,
        cover: (entry && entry.cover) || '',
        seriesDir,
        web_accessible_episodes: entry?.web_accessible_episodes ?? null,
        total: episodes.length,
        completedCount,
        episodes,
      },
    };
  } catch (error) {
    console.error('[Player] 读取分集失败:', error.message);
    return { success: false, error: error.message };
  }
});


ipcMain.handle('save-playback-position', async (event, seriesId, vidIndex, currentTime, metadata) => {  try {
    const map = store.getPlayback() || {};
    const sid = String(seriesId);
    const series = seriesRegistry.find(item => String(item.series_id) === sid);
    if (!series) return { success: false, error: '未找到短剧档案' };
    map[sid] = watchHistory.recordPlayback(map[sid], series, Number(vidIndex), Number(currentTime), Date.now(), metadata);
    store.savePlayback(map);
    scheduleCloudUpload(sid);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-playback-position', async (event, seriesId) => {
  const map = store.getPlayback() || {};
  const sid = String(seriesId);
  const local = map[sid] || null;

  const userId = syncedAccountId();
  const cloud = userId && cloudHistory.userId === userId ? (cloudHistory.rows || []).find(row => row.series_id === sid) : null;
  if (cloud && (!local || !(Number(local.updatedAt) >= cloud.updatedAt))) {
    return { ...(local || {}), vid_index: cloud.vid_index, currentTime: cloud.currentTime, updatedAt: cloud.updatedAt, watched: true };
  }
  return local;
});





ipcMain.handle('play-series', async (event, payload) => {
  const { seriesId, vidIndex } = payload || {};
  const sid = String(seriesId || '');
  let entry = seriesRegistry.find(item => String(item.series_id) === sid);
  if (payload?.resume === true && /^[1-9]\d{5,24}$/.test(sid) && watchHistory.sourceOf(sid) === 'hongguo') {
    const target = Number(vidIndex) || store.getPlayback()?.[sid]?.vid_index || 0;
    let availableLocal = false;
    try { availableLocal = !!entry && collectSeriesEpisodeFiles(sid, entry.series_title).ordered.some(item => target > 0 ? Number(item.vid_index) === target : true); } catch {}
    if (!availableLocal) {
      try {
        const fresh = await hongguo.fetchEpisodeList(sid);
        if (!require('./src/native/playback-catalog').validCatalog(fresh, sid)) throw new Error('INVALID_CATALOG');
        if (target > 0 && !fresh.episodes.some(item => Number(item.vid_index) === target)) {
          let local = false;
          try { local = !!entry && collectSeriesEpisodeFiles(sid, entry.series_title).ordered.some(item => Number(item.vid_index) === target); } catch {}
          if (!local) return { success: false, code: 'HISTORY_EPISODE_UNAVAILABLE', error: '來源目前沒有這一集，已保留觀看進度。請稍後重試或手動選集。' };
        } else {
          upsertSeriesRegistry(fresh);
          entry = seriesRegistry.find(item => String(item.series_id) === sid);
        }
      } catch {
        if (!entry?.episodes?.some(item => Number(item.vid_index) === target)) return { success: false, error: '暫時無法更新分集，已保留觀看進度。請稍後再試。' };
      }
    }
  }
  if (!entry) return { success: false, code: 'SERIES_NOT_FOUND', error: '未找到短剧档案，请重新打开详情' };
  if (entry.dismissed) {
    const wasForgotten = entry.forgotten;
    try { entry.dismissed = false; entry.forgotten = false; saveSeriesRegistry(); }
    catch (error) { entry.dismissed = true; entry.forgotten = wasForgotten; return { success: false, error: error.message }; }
  }
  sendToRenderer('navigate', {
    page: 'player',
    payload: { seriesId: seriesId ? String(seriesId) : '', vidIndex: Number(vidIndex) || 0, resume: payload?.resume === true },
  });
  return { success: true };
});


function playbackQuality(value = 'auto', vid = '') {
  if (!['auto', '720p', '1080p'].includes(value)) throw new Error('在线播放清晰度无效，请选择自动、720p 或 1080p');
  if (value !== 'auto' && /^(xifan|hema|custom):/.test(String(vid))) throw new Error('此来源暂不支持指定在线播放清晰度，请选择自动');
  return value;
}

function qualityForDeliveredFile(requested, info) {
  const delivered = info?.deliveredQuality || info?.quality;
  if (info?.qualityLimited === true && ['auto', '720p', '1080p'].includes(delivered)) return delivered;
  return requested;
}

function onlineCacheKey(vid, quality = 'auto') {
  return quality === 'auto' ? String(vid) : `${vid}:${quality}`;
}



function mediaRange(range, size) {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return false;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
  return { start, end };
}

function bufferedMediaResponse(request, buffer) {
  const range = mediaRange(request.headers.get('range'), buffer.length);
  if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buffer.length}` } });
  const { start, end } = range || { start: 0, end: buffer.length - 1 };
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${buffer.length}`;
  return new Response(request.method === 'HEAD' ? null : buffer.subarray(start, end + 1), { status: range ? 206 : 200, headers });
}


async function requestMedia(playInfo, options = {}) {
  const url = new URL(playInfo.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('无效播放地址');
  checkCustomAccess(playInfo.vid);
  const custom = playInfo.source === 'custom';
  const web = playInfo.source === 'web';
  const config = { method: 'GET', url: url.href, responseType: 'stream', timeout: 60000, ...options,
    ...require('./src/native/direct-connect').directAxiosOptions(),
    ...((web || custom) ? require('./src/native/web-media-guard').webMediaRequestOptions(url.href) : {}),
    headers: { 'User-Agent': playInfo.userAgent || (web ? hongguo.WEB_UA : hongguo.UA), 'Accept-Encoding': 'identity',
      ...((playInfo.referer || web) ? { Referer: playInfo.referer || hongguo.WEB_REFERER } : {}), ...options.headers } };
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { response = await axios(config); break; }
    catch (error) {
      error.response?.data?.destroy?.();
      const status = error.response?.status;
      const cancelled = config.signal?.aborted || config.cancelToken?.reason || axios.isCancel(error);
      if (!cancelled && (error.code === 'ERR_WEB_MEDIA_ADDRESS' || error.cause?.code === 'ERR_WEB_MEDIA_ADDRESS')) {
        hongguo.markWebMediaFailure?.(playInfo);
        throw Object.assign(mediaTransferError('官网片源地址不安全，正在尝试其他片源'), { code: 'ERR_WEB_MEDIA_ADDRESS' });
      }
      const retryable = web ? [404, 410].includes(status) || status >= 500 && status <= 599 : status === 403;
      if (!cancelled && attempt === 0 && retryable) {
        if (['app', 'api'].includes(playInfo.source) && config.headers.Referer) delete config.headers.Referer;
        else if (['app', 'api'].includes(playInfo.source) && !config.headers.Referer) config.headers.Referer = hongguo.VIDEO_REFERER;
        continue;
      }
      if (!cancelled && config.method === 'GET' && (retryable || status === 403)) hongguo.markWebMediaFailure?.(playInfo);
      if (!cancelled && status) {
        const failure = new Error(`片源请求失败（HTTP ${status}），请重新连接片源`);
        failure.mediaRetryable = [403, 404, 408, 410].includes(status) || status >= 500 && status <= 599;
        failure.mediaStatus = status;
        throw failure;
      }
      throw error;
    }
  }
  if ([200, 206].includes(response.status) && /(?:text\/html|application\/json)/i.test(response.headers['content-type'] || '')) {
    response.data.destroy();
    throw mediaTransferError('片源返回了错误页面，请重新获取片源');
  }
  if (config.method === 'GET' && !config.headers.Range && response.status === 206) {
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
    if (!range || Number(range[1]) + 1 !== Number(range[2])) {
      response.data.destroy();
      throw mediaTransferError('视频响应不完整，请重新获取片源');
    }
    response.headers['content-length'] = range[2];
  }
  return response;
}

function mediaTransferError(message) {
  return Object.assign(new Error(message), { code: 'MEDIA_TRANSFER_ERROR', mediaRetryable: true });
}

function awaitMediaOperation(promise, signal, timeout = 0) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (settle, value) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); settle(value);
    };
    const abort = () => finish(reject, Object.assign(new Error('已取消媒体请求'), { code: 'ERR_CANCELED' }));
    if (timeout) timer = setTimeout(() => finish(reject, mediaTransferError('获取片源超时，请稍后重试')), timeout);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();

    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}


async function withMediaRecovery(vid, seriesId, options, consume) {
  try { resolveLibrempeg(); } catch {                         }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  options.cancelToken?.subscribe(abort);
  const cancelled = () => {
    options.cancelToken?.throwIfRequested();
    if (options.signal?.aborted || controller.signal.aborted) throw Object.assign(new Error('已取消媒体请求'), { code: 'ERR_CANCELED' });
  };
  const recoverable = error => error?.mediaRetryable || error?.code === 'SOURCE_UNAVAILABLE'
    || ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ERR_BAD_RESPONSE', 'ERR_STREAM_PREMATURE_CLOSE', 'EAI_AGAIN'].includes(error?.code);
  const rounds = options.recover !== false && /^\d{1,30}$/.test(String(vid)) ? 3 : 1;
  if (/^\d{1,30}$/.test(String(vid))) require('./src/native/app-source').warmPlayback();
  const refused = error => error?.code === 'SOURCE_UNAVAILABLE' && error.sources?.length > 0
    && error.sources.some(item => item?.code === 'EMPTY_RESPONSE' || item?.code === 'DEVICE_REGISTRATION_FAILED')
    && error.sources.every(item => ['EMPTY_RESPONSE', 'DEVICE_REGISTRATION_FAILED', 'INVALID_RESPONSE', 'PREVIEW_ONLY', 'MISSING_MODEL', 'HTTP_404', 'HTTP_410'].includes(item?.code));
  let lastError, transfers = 0, refusedRounds = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      if (refusedRounds >= 2) break;
      cancelled();
      if (round) {
        let timer;
        try { await awaitMediaOperation(new Promise(resolve => { timer = setTimeout(resolve, round * 500); }), controller.signal); }
        finally { clearTimeout(timer); }
      }
      cancelled();
      let info;
      try {
        info = !round && options.playInfo || await awaitMediaOperation(hongguo.fetchPlayUrlSingle(vid, seriesId,
          { quality: options.quality, allowLowerQuality: options.allowLowerQuality, force: options.force || round > 0 }), controller.signal, 30000);
      } catch (error) {
        cancelled();
        if (require('./src/native/playback-policy').codecExhausted(error)) throw error;
        if (!recoverable(error)) throw error;
        lastError = error;
        if (refused(error)) refusedRounds++;
        continue;
      }
      cancelled();
      if (!info?.url) {
        lastError = Object.assign(new Error(info?.error || '未获取到有效播放地址'), { code: info?.code, sources: info?.sources });
        if (require('./src/native/playback-policy').codecExhausted(lastError) || !recoverable(lastError) || info?.locked) throw lastError;
        if (refused(lastError)) refusedRounds++;
        continue;
      }
      const seen = new Set();
      for (const candidate of [info, ...(options.recover === false ? [] : info.variants || info.candidates || [])]) {
        const identity = JSON.stringify([candidate.url, candidate.contentKey, candidate.spadeA, candidate.userAgent, candidate.referer]);
        if (!candidate.url || seen.has(identity)) continue;
        seen.add(identity);
        cancelled();
        transfers++;
        try {
          const value = await consume(candidate);
          cancelled();
          return value;
        } catch (error) {
          cancelled();

          const terminal = error?.path || error?.dest
            || /^(?:EACCES|EPERM|ENOSPC|EDQUOT|EROFS|EIO|ENOENT|EEXIST|ENOTDIR|EISDIR|EMFILE|ENFILE|EBUSY|ENAMETOOLONG|EMLINK|EFBIG|LOCAL_MEDIA_TOOL_ERROR|SECURITY_BLOCKED|ERR_WEB_MEDIA_ADDRESS)$/.test(error?.code);
          if (options.allowLowerQuality && terminal || (!recoverable(error) && !options.allowLowerQuality)) throw error;
          lastError = error;
          hongguo.markWebMediaFailure?.(candidate);
          if (transfers >= 4 && !options.allowLowerQuality) throw lastError;
        }
      }
    }
    throw lastError;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    options.cancelToken?.unsubscribe(abort);
  }
}


function mediaWithCors(handler) {
  return async request => {
    const headers = mediaAccess.corsHeaders(request);
    if (!headers) return new Response('forbidden origin', { status: 403 });
    const response = await handler(request);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  };
}

function diskMediaResponse(request,entry,session) {
  const range = mediaRange(request.headers.get('range'),entry.size);
  if (range === false) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${entry.size}`}});
  const {start,end} = range || {start:0,end:entry.size-1};
  const headers = {'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':String(end-start+1)};
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${entry.size}`;
  if (request.method === 'HEAD') return new Response(null,{status:range?206:200,headers});
  const reader = fs.createReadStream(entry.filePath,{start,end}), controller = new AbortController();
  entry.disk.readers = (entry.disk.readers || 0) + 1;
  const abort = () => controller.abort();
  controller.signal.addEventListener('abort',() => reader.destroy());
  session.requests.add(controller); request.signal.addEventListener('abort',abort,{once:true});
  reader.once('close',() => {
    session.requests.delete(controller); request.signal.removeEventListener('abort',abort);
    entry.disk.readers--; disposeOnlineDisk(entry);
  });
  if (request.signal.aborted) abort();
  return new Response(Readable.toWeb(reader),{status:range?206:200,headers});
}

function registerStreamProtocol() {
  protocol.handle(STREAM_SCHEME, mediaWithCors(async (request) => {
    const url = new URL(request.url);
    const id = url.pathname.replace(/^\/+/, '');
    const session = url.hostname === 'play' && onlineSessions.get(id);
    if (!session || !session.entry) return new Response('not ready', { status: 404 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const entry = session.entry;
    try { checkCustomAccess(session.vid); } catch (_) { releaseOnlineSession(id); return new Response('source disabled',{status:403}); }
    if (entry.filePath) return diskMediaResponse(request,entry,session);
    entry.lastUsed = Date.now();
    if (entry.buffer) {
      if (session.mediaStarted && entry.mediaIdentity && session.mediaIdentity !== entry.mediaIdentity) return new Response('media changed', { status: 502 });
      return bufferedMediaResponse(request, entry.buffer);
    }
    const range = request.headers.get('range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return new Response(null, { status: 416 });
    const controller = new AbortController();
    session.requests.add(controller);
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const cleanup = () => { session.requests.delete(controller); request.signal.removeEventListener('abort', abort); };
    try {
      return await withMediaRecovery(session.vid, entry.seriesId,
        { playInfo: entry.playInfo, quality: entry.quality, signal: controller.signal, recover: !session.mediaStarted }, async playInfo => {
        const identity = JSON.stringify([playInfo.url, playInfo.contentKey, playInfo.spadeA]);
        const checkIdentity = () => {
          if (session.mediaStarted && session.mediaIdentity !== identity) throw new Error('片源已变化，请重新连接播放');
        };
        checkIdentity();
        if (playInfo.format === 'hls') {
          if (!entry.hlsJob) {
            entry.hlsIdentity = identity;
            entry.hlsJob = (async () => {
              const prepared = {...entry}; delete prepared.hlsJob;
              await prepareHlsEntry(playInfo,prepared,controller.signal,received => sendToRenderer('online-play-progress',
                {vid:session.vid,seriesId:entry.seriesId,vidIndex:entry.vidIndex,requestId:session.requestId,received,total:0,percent:0,phase:'downloading'}));
              try { checkIdentity(); } catch (error) { disposeOnlineDisk(prepared); throw error; }
              Object.assign(entry,prepared,{mediaIdentity:identity,vid:session.vid,source:/^custom:[^:]+/.exec(session.vid)?.[0] || 'hongguo',complete:true});
              delete entry.playInfo;
              onlineCache.set(session.cacheKey || session.vid,entry); trimOnlineCache();
            })().catch(error => { delete entry.hlsJob; delete entry.hlsIdentity; throw error; });
          }
          if (entry.hlsIdentity !== identity) throw new Error('片源已变化，请重新连接播放');
          await entry.hlsJob; checkIdentity();
          session.mediaStarted = true; session.mediaIdentity = identity;
          cleanup(); return diskMediaResponse(request,entry,session);
        }

        if (playInfo.contentKey && !playInfo.spadeA) {
          if (request.method === 'HEAD') { cleanup(); return new Response(null, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' } }); }
          const cachedCapture = onlineCache.get(session.cacheKey || session.vid);
          const finished = adoptPrefetchFile(session.cacheKey || session.vid)
            || (cachedCapture?.filePath && cachedCapture.mediaIdentity === identity ? cachedCapture : null);
          if (finished) {
            entry.filePath = finished.filePath;
            entry.disk = finished.disk;
            entry.size = finished.size;
            entry.mediaIdentity = identity;
            entry.complete = true;
            delete entry.playInfo;
            onlineCache.set(session.cacheKey || session.vid, entry);
            trimOnlineCache();
            session.mediaStarted = true;
            session.mediaIdentity = identity;
            cleanup();
            return diskMediaResponse(request, entry, session);
          }
          abortPrefetchFile(session.cacheKey || session.vid);
          const child = startContentKeyStream(playInfo, controller.signal, startOnlineCapture(session, entry, playInfo, identity));
          session.mediaStarted = true; session.mediaIdentity = identity;
          child.stdout.once('close', cleanup);
          return new Response(Readable.toWeb(child.stdout), { status: 200, headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' } });
        }
        if (playInfo.spadeA || playInfo.contentKey) {
          const buffer = await fetchDecryptedEpisodeOnce(session.vid, null, entry.seriesId, playInfo, controller.signal);
          checkIdentity();
          entry.buffer = buffer; entry.size = buffer.length; entry.mediaIdentity = identity; delete entry.playInfo;
          session.mediaStarted = true; session.mediaIdentity = identity;
          cleanup();
          return bufferedMediaResponse(request, buffer);
        }
        const upstream = await requestMedia(playInfo, { method: request.method, signal: controller.signal,
          headers: range ? { Range: range } : {}, validateStatus: status => [200, 206, 416].includes(status) });
        try { checkIdentity(); } catch (error) { upstream.data.destroy(); throw error; }
        entry.playInfo = playInfo;
        upstream.data.once('error', () => {
          if (!controller.signal.aborted) hongguo.markWebMediaFailure?.(playInfo);
        });
        upstream.data.once('close', cleanup);
        const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' };
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          if (upstream.headers[name]) headers[name] = upstream.headers[name];
        }
        if (request.method === 'HEAD' || upstream.status === 416) {
          if (request.method === 'HEAD' && upstream.status !== 416) { session.mediaStarted = true; session.mediaIdentity = identity; }
          upstream.data.destroy(); cleanup();
          return new Response(null, { status: upstream.status, headers });
        }

        session.mediaStarted = true;
        session.mediaIdentity = identity;
        return new Response(Readable.toWeb(upstream.data, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }), { status: upstream.status, headers });
      });
    } catch (error) {
      cleanup();
      if (error.code === 'MEDIA_TOO_LARGE') sendToRenderer('online-play-progress', { requestId: session.requestId, code: error.code, error: error.message });
      return new Response('media unavailable', { status: controller.signal.aborted ? 499 : 502 });
    }
  }));
}


function localPlayUrl(filePath) {
  if (!filePath) return null;
  return mediaAccess.localUrl(filePath);
}








function registerLocalProtocol() {
  protocol.handle(LOCAL_SCHEME, mediaWithCors(async (request) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      const filePath = mediaAccess.resolveLocal(request.url);
      if (!filePath) {
        return new Response('bad path', { status: 400, headers: { 'Content-Type': 'text/plain' } });
      }

      if (!/\.(mp4|m4v|mov|webm)$/i.test(filePath)) {
        return new Response('forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } });
      }

      let size = 0;
      try {
        size = (await fsp.stat(filePath)).size;
      } catch (_) {
        console.warn('[Local] 文件不存在:', filePath);
        return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
      }

      const range = mediaRange(request.headers.get('range'), size);
      if (range === false) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      if (range) {
        const { start, end } = range;
        return new Response(request.method === 'HEAD' ? null : fs.createReadStream(filePath, { start, end }), {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }

      return new Response(request.method === 'HEAD' ? null : fs.createReadStream(filePath), {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(size),
        },
      });
    } catch (e) {
      console.error('[Local] 读取失败:', e.message);
      return new Response('error', { status: 500, headers: { 'Content-Type': 'text/plain' } });
    }
  }));
}

function abortPrefetchFile(key) {
  const job = onlinePrefetchFiles.get(key);
  if (!job || job.adopted) return;
  onlinePrefetchFiles.delete(key);
  job.controller.abort();
  const directory = job.disk?.directory;
  job.promise?.catch(() => {});
  if (directory) fs.rm(directory, { recursive: true, force: true }, () => {});
}

function adoptPrefetchFile(key) {
  const job = onlinePrefetchFiles.get(key);
  if (!job?.done || !job.filePath) return null;
  job.adopted = true;
  onlinePrefetchFiles.delete(key);
  let size = 0;
  try { size = fs.statSync(job.filePath).size; } catch { size = 0; }
  if (!size) {
    const directory = job.disk?.directory;
    if (directory) fs.rm(directory, { recursive: true, force: true }, () => {});
    return null;
  }
  return { filePath: job.filePath, disk: job.disk, size };
}



function beginBytevc2Prefetch(key, playInfo, signal) {
  const existing = onlinePrefetchFiles.get(key);
  if (existing) return existing;
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const job = { controller, done: false, adopted: false, filePath: '', disk: null, promise: null };
  const abort = () => abortPrefetchFile(key);
  signal?.addEventListener('abort', abort, { once: true });
  job.promise = (async () => {
    let directory = '';
    let response;
    try {
      directory = await fsp.mkdtemp(path.join(app.getPath('temp'), 'hongguo-online-'));
      job.disk = { directory, readers: 0 };
      const filePath = path.join(directory, 'video.mp4');
      const input = path.join(directory, 'encrypted.mp4');
      response = await requestMedia(playInfo, { signal: controller.signal });
      const total = Number(response.headers['content-length']) || 0;
      if (total > ONLINE_MAX_BYTES) {
        response.data.destroy();
        throw Object.assign(new Error('本集过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' });
      }
      await pipeline(response.data, fs.createWriteStream(input, { mode: 0o600 }), { signal: controller.signal });
      await decryptContentKeyFile(input, filePath, playInfo.contentKey, {
        signal: controller.signal, codec: playInfo.codec, transcode: playInfo.transcode, profile: 'prefetch',
      });
      await fsp.unlink(input).catch(() => {});
      const size = (await fsp.stat(filePath)).size;
      if (!size) throw new Error('媒体解密没有生成可用文件');
      if (onlinePrefetchFiles.get(key) !== job) {
        fs.rm(directory, { recursive: true, force: true }, () => {});
        return;
      }
      job.filePath = filePath;
      job.done = true;
    } catch {
      response?.data?.destroy?.();
      if (onlinePrefetchFiles.get(key) === job) onlinePrefetchFiles.delete(key);
      if (!job.adopted && directory) fs.rm(directory, { recursive: true, force: true }, () => {});
    }
  })();
  onlinePrefetchFiles.set(key, job);
  if (signal?.aborted) abortPrefetchFile(key);
  return job;
}





function startOnlineCapture(session, entry, playInfo, identity) {
  const key = session.cacheKey || session.vid;
  const existing = onlineCaptures.get(key);
  if (existing && existing.identity === identity) return existing;
  if (existing) abortOnlineCapture(key);
  if (onlineCache.get(key)?.filePath) return null;
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(app.getPath('temp'), 'hongguo-online-'));
    const capture = createContentKeyCapture({ playInfo, request: requestMedia, maxBytes: ONLINE_MAX_BYTES, directory,
      decrypt: (input, output, options) => decryptContentKeyFile(input, output, playInfo.contentKey, { ...options, codec: playInfo.codec, transcode: playInfo.transcode }) });
    capture.identity = identity;
    onlineCaptures.set(key, capture);
    const base = { ...entry };
    delete base.playInfo;
    capture.finished = capture.result.then(async ({ filePath, size }) => {

      if (onlineCaptures.get(key) !== capture) { await capture.discard(); throw Object.assign(new Error('已取消播放'), { code: 'ERR_CANCELED' }); }
      onlineCaptures.delete(key);
      if (onlineCache.has(key)) { await capture.discard(); return onlineCache.get(key); }
      capture.adopt();
      const source = /^custom:[^:]+/.exec(session.vid)?.[0] || /^(xifan|hema):/.exec(session.vid)?.[1] || 'hongguo';
      const finished = { ...base, filePath, size, disk: { directory, readers: 0 }, vid: session.vid, source, mediaIdentity: identity, complete: true, lastUsed: Date.now() };
      onlineCache.set(key, finished); trimOnlineCache();
      return finished;
    }, error => {
      if (onlineCaptures.get(key) === capture) onlineCaptures.delete(key);
      if (error?.code === 'MEDIA_TOO_LARGE') sendToRenderer('online-play-progress', { requestId: session.requestId, code: error.code, error: error.message });
      throw error;
    });
    capture.finished.catch(() => {});
    return capture;
  } catch (_) {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    return null;
  }
}

function startContentKeyStream(playInfo, signal, capture = null) {
  if (!/^[a-f\d]{32}$/i.test(playInfo.contentKey || '')) throw new Error('片源解密密钥格式无效');
  const plan = require('./src/native/transcode-args').streamPlan(playInfo);
  const executable = plan.tool === 'librempeg' ? resolveLibrempeg() : resolveFfmpeg('ffmpeg');
  if (!executable) throw new Error(plan.tool === 'librempeg'
    ? require('./src/native/app-source').NEWER_CODEC_UNREADY
    : '未找到内置 FFmpeg，无法准备该片源。请重新下载完整发行包并运行；若已自行安装 FFmpeg，请完全退出软件后重启再试');
  const { spawn } = require('child_process');
  const child = spawn(executable, plan.args,
  { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const stop = () => { if (!child.killed) child.kill('SIGTERM'); };
  signal?.addEventListener('abort', stop, { once: true });
  child.once('close', () => signal?.removeEventListener('abort', stop));
  if (child.stdin) {

    child.stdin.on('error', () => {});
    if (capture?.readable) {

      const reader = capture.reader();
      reader.once('error', () => { if (!child.killed) child.kill('SIGTERM'); });
      child.once('close', () => reader.destroy());
      reader.pipe(child.stdin);
    } else {
      require('./src/native/content-key-feed').feedContentKey(playInfo, child.stdin, signal, {
        request: requestMedia, maxBytes: ONLINE_MAX_BYTES,
      }).catch(() => { if (!child.killed) child.kill('SIGTERM'); });
    }
  }
  return child;
}


async function decryptContentKeyFile(input, output, contentKey, { signal, cancelToken, codec, transcode, profile, onProgress, timeoutMs, idleTimeoutMs } = {}) {
  if (typeof contentKey !== 'string' || !/^[a-f\d]{32}$/i.test(contentKey)) throw new Error('片源解密密钥格式无效');
  if (signal?.aborted) throw new Error('已取消媒体解密');
  cancelToken?.throwIfRequested();
  const transcoding = codec === 'bytevc2' || transcode === 'bytevc2';
  const executable = transcoding ? resolveLibrempeg() : resolveFfmpeg('ffmpeg');
  if (!executable) throw new Error(transcoding
    ? require('./src/native/app-source').NEWER_CODEC_UNREADY
    : '未找到内置 FFmpeg，无法准备该片源。请重新下载完整发行包并运行；若已自行安装 FFmpeg，请完全退出软件后重启再试');
  const args = transcoding
    ? (profile === 'prefetch'
      ? require('./src/native/transcode-args').bytevc2PrefetchArgs(contentKey, input, output)
      : require('./src/native/transcode-args').bytevc2FileArgs(contentKey, input, output))
    : ['-y', '-hide_banner', '-loglevel', 'error', '-decryption_key', contentKey, '-i', input, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output];
  try {
    const { spawn } = require('child_process');
    const child = spawn(executable, ['-progress', 'pipe:1', '-nostats', ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (profile === 'prefetch' && child.pid) {
      try { require('os').setPriority(child.pid, 10); } catch (_) {}
    }
    await require('./src/native/media-finalize').waitForMediaProcess(child, { signal, cancelToken, onProgress, timeoutMs, idleTimeoutMs });
    if (signal?.aborted) throw new Error('已取消媒体解密');
    cancelToken?.throwIfRequested();
    if ((await fsp.stat(output)).size === 0) throw new Error('媒体解密没有生成可用文件');
  } catch (error) {
    try { await fsp.unlink(output); } catch (_) {}
    throw error;
  }
}


async function fetchDecryptedEpisode(vid, onProgress, seriesId, playInfo, signal, maxBytes = ONLINE_MAX_BYTES, force = false, quality = 'auto') {
  return withMediaRecovery(vid, seriesId, { playInfo, signal, force, quality }, candidate =>
    fetchDecryptedEpisodeOnce(vid, onProgress, seriesId, candidate, signal, maxBytes));
}

async function fetchDecryptedEpisodeOnce(vid, onProgress, seriesId, playInfo, signal, maxBytes = ONLINE_MAX_BYTES) {
  maxBytes = Math.min(maxBytes, ONLINE_MAX_BYTES);
  const tooLarge = () => Object.assign(new Error('本集过大，请下载后播放'), { code: 'MEDIA_TOO_LARGE' });
  if (playInfo?.format === 'hls') throw new Error('HLS 视频必须先准备为本地媒体文件');
  if (!playInfo?.url) throw new Error(playInfo?.error || '未获取到有效播放地址');
  if (signal?.aborted) throw new Error('已取消播放');
  if (playInfo.contentKey && !/^[a-f\d]{32}$/i.test(playInfo.contentKey)) throw new Error('片源解密密钥格式无效');
  const response = await requestMedia(playInfo, { signal });
  const total = Number(response.headers['content-length']) || 0;
  if (total > maxBytes) { response.data.destroy(); throw tooLarge(); }
  const chunks = [];
  let received = 0, lastProgress = 0;
  if (playInfo.contentKey) {
    let temporary;
    try {
      temporary = await fsp.mkdtemp(path.join(app.getPath('temp'), 'hongguo-decrypt-'));
      const input = path.join(temporary, 'encrypted.mp4'), output = path.join(temporary, 'decoded.mp4');
      response.data.on('data', chunk => {
        received += chunk.length;
        if (received > maxBytes) { response.data.destroy(tooLarge()); return; }
        if (onProgress && (Date.now() - lastProgress >= 150 || received === total)) {
          onProgress(received, total); lastProgress = Date.now();
        }
      });
      await pipeline(response.data, fs.createWriteStream(input, { mode: 0o600 }), { signal });
      if (!received || (total && received !== total)) throw mediaTransferError('视频下载不完整，请重试');
      if (onProgress) onProgress(received, received, 'decrypting');
      await decryptContentKeyFile(input, output, playInfo.contentKey, { signal, codec: playInfo.codec, transcode: playInfo.transcode });
      if ((await fsp.stat(output)).size > maxBytes) throw tooLarge();
      return await fsp.readFile(output);
    } finally {
      response.data.destroy();
      if (temporary) await fsp.rm(temporary, { recursive: true, force: true });
    }
  }
  for await (const chunk of response.data) {
    received += chunk.length;
    if (received > maxBytes) { response.data.destroy(); throw tooLarge(); }
    chunks.push(chunk);
    if (onProgress && (Date.now() - lastProgress >= 150 || received === total)) {
      onProgress(received, total); lastProgress = Date.now();
    }
  }
  if (signal?.aborted) throw new Error('已取消播放');
  if (!received || (total && received !== total)) throw mediaTransferError('视频下载不完整，请重试');
  let buf = Buffer.concat(chunks);
  if (playInfo.spadeA) {
    if (onProgress) onProgress(buf.length, buf.length, 'decrypting');
    const key = hongguo.deriveKey(playInfo.spadeA);
    if (!key) throw new Error('密钥派生失败');
    buf = await decryptInWorker({ buffer: buf, key }, { signal });
  }
  return buf;
}

async function prepareHlsEntry(playInfo,entry,signal,onProgress) {
  entry.disk = {directory:await fsp.mkdtemp(path.join(app.getPath('temp'),'hongguo-online-')),readers:0};
  entry.filePath = path.join(entry.disk.directory,'video.mp4');
  try {
    await prepareHlsFile(playInfo,entry.filePath,{signal,onProgress});
    await verifyDownloadQuality(entry.filePath,entry.quality || 'auto');
    if (signal.aborted) throw new Error('已取消播放');
    entry.size = fs.statSync(entry.filePath).size;
  } catch (error) { disposeOnlineDisk(entry); throw error; }
}

ipcMain.handle('prepare-online-play', async (event, payload) => {
  const { vid, seriesId, vidIndex, requestId, prefetch = false, force = false, seekable = false } = payload || {};
  if (!vid) return { success: false, error: '缺少 vid' };
  let quality;
  try { quality = playbackQuality(payload.quality, vid); } catch (error) { return { success: false, error: error.message }; }
  const sourceVid = String(vid), key = onlineCacheKey(sourceVid, quality), streamId = randomUUID();
  const session = { vid: sourceVid, seriesId: String(seriesId || ''), vidIndex: Number(vidIndex), cacheKey: key, requestId, requests: new Set(), entry: null };
  onlineSessions.set(streamId, session);
  try {
    checkCustomAccess(sourceVid);
    const checkedPlayInfo = /^(xifan|hema|custom):/.test(sourceVid) ? await hongguo.fetchPlayUrlSingle(sourceVid, seriesId, { force, quality }) : null;
    if (!onlineSessions.has(streamId)) throw new Error('已取消播放');
    if (checkedPlayInfo && !checkedPlayInfo.url) throw new Error(checkedPlayInfo.error || '来源未开放该集');
    if (force) { abortOnlineCapture(key); deleteOnlineCacheEntry(key); }
    let entry = onlineCache.get(key), cached = !!entry;
    if (!entry && seekable && onlineCaptures.has(key)) {

      await onlineCaptures.get(key).finished.catch(() => {});
      if (!onlineSessions.has(streamId)) throw new Error('已取消播放');
      entry = onlineCache.get(key); cached = !!entry;
    }
    if (!entry) {
      let job = onlinePreparing.get(key);
      if (!job || (force && !job.force) || (seekable && !job.seekable)) {
        const controller = new AbortController();
        job = { controller, force, seekable };
        job.promise = (async () => {
          const progress = (received,total,phase) => {
            for (const active of onlineSessions.values()) if (active.cacheKey === key) {
              sendToRenderer('online-play-progress',{vid:sourceVid,seriesId,vidIndex,requestId:active.requestId,
                received,total,percent:total?Math.floor(received/total*100):0,phase:phase||'downloading'});
            }
          };
          const prepared = await withMediaRecovery(sourceVid,seriesId,{playInfo:checkedPlayInfo,quality,force,signal:controller.signal},async playInfo => {
            const entry = {quality,deliveredQuality:playInfo.quality,qualityLimited:playInfo.qualityLimited===true,notice:playInfo.notice||'',size:0,lastUsed:Date.now(),seriesId:String(seriesId||''),vidIndex:Number(vidIndex)||0};
            if (playInfo.format === 'hls') await prepareHlsEntry(playInfo,entry,controller.signal,received => progress(received,0));
            else if (!seekable && playInfo.contentKey && !playInfo.spadeA) {
              if (!/^[a-f\d]{32}$/i.test(playInfo.contentKey)) throw new Error('片源解密密钥格式无效');
              const transcoding = playInfo.codec === 'bytevc2' || playInfo.transcode === 'bytevc2';
              if (prefetch && transcoding) beginBytevc2Prefetch(key, playInfo, controller.signal);
              else if (prefetch) startOnlineCapture(session, entry, playInfo, JSON.stringify([playInfo.url, playInfo.contentKey, playInfo.spadeA]));
              return {...entry,playInfo};
            }
            else if (!seekable && !prefetch && !playInfo.spadeA && !playInfo.contentKey) return {...entry,playInfo};
            else {
              entry.buffer = await fetchDecryptedEpisodeOnce(sourceVid,progress,seriesId,playInfo,controller.signal);
              entry.size = entry.buffer.length;
            }
            if (controller.signal.aborted) throw new Error('已取消播放');
            Object.assign(entry,{vid:sourceVid,source:/^custom:[^:]+/.exec(sourceVid)?.[0] || /^(xifan|hema):/.exec(sourceVid)?.[1] || 'hongguo',complete:true});
            return entry;
          });
          prepared.lastUsed = Date.now();

          for (const active of onlineSessions.values()) if (active.job === job) active.entry = {...prepared};
          if (prepared.complete && onlinePreparing.get(key) === job) { onlineCache.set(key,prepared); trimOnlineCache(); }
          return prepared;
        })().finally(() => { if (onlinePreparing.get(key) === job) onlinePreparing.delete(key); });
        onlinePreparing.set(key, job);
      }
      session.job = job;
      entry = await job.promise;
    }
    if (!onlineSessions.has(streamId)) throw new Error('已取消播放');
    session.entry = { ...entry }; entry.lastUsed = Date.now();
    const transcoding = !!(entry.playInfo && (entry.playInfo.codec === 'bytevc2' || entry.playInfo.transcode === 'bytevc2'));
    return { success: true, url: `${STREAM_SCHEME}://play/${streamId}`, streamId, size: entry.size,
      cached, streaming: !!entry.playInfo, transcoding, notice: entry.notice || '' };
  } catch (error) {
    releaseOnlineSession(streamId);
    const sources = Array.isArray(error.sources) ? error.sources.map(item => ({
      source: item?.source, code: item?.code, message: item?.message,
    })) : undefined;
    const emptyDirect = sources?.length && sources.every(item => item.code === 'EMPTY_RESPONSE' || item.code === 'DEVICE_REGISTRATION_FAILED')
      && getCurrentSettings().proxy_enabled !== true;
    const message = emptyDirect ? `${error.message} 可到「設定」檢查網路或代理。` : error.message;
    return { success: false, error: message, code: error.code, ...(sources ? { sources } : {}) };
  }
});

ipcMain.handle('release-online-play', async (event, payload = {}) => {
  for (const [id, session] of [...onlineSessions]) {
    if ((payload.streamId && id === payload.streamId) || (payload.requestId && session.requestId === payload.requestId)) releaseOnlineSession(id);
  }
  return { success: true };
});

ipcMain.handle('online-cache-status', async () => {
  const items = [...onlineCache.entries()].map(([vid, e]) => ({
    vid, size: e.size, vidIndex: e.vidIndex, seriesId: e.seriesId,
  }));
  return { success: true, count: items.length, bytes: onlineCacheTotal(), items };
});

ipcMain.handle('clear-online-cache', async () => {
  clearOnlineCache();
  return { success: true };
});


const COMPAT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
let compatDir = null;
let compatEncoder = null;

function getCompatDir() {
  if (!compatDir) {
    compatDir = path.join(app.getPath('userData'), 'compat-cache');
    try { fs.mkdirSync(compatDir, { recursive: true }); } catch (_) {}

    try {
      for (const name of fs.readdirSync(compatDir)) {
        if ((name.startsWith('.tmp_') && name.endsWith('.mp4')) || name.endsWith('.mp4.part')) {
          try { fs.unlinkSync(path.join(compatDir, name)); } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return compatDir;
}

function compatFileName(seriesId, vidIndex, quality = 'auto') {
  if (!['string', 'number'].includes(typeof vidIndex) || !/^[1-9]\d*$/.test(String(vidIndex))
    || !Number.isSafeInteger(Number(vidIndex))) throw new Error('集数必须是有效正整数');
  return `${sanitizeFolderName(String(seriesId))}_${String(Number(vidIndex)).padStart(3, '0')}${quality === 'auto' ? '' : `_${playbackQuality(quality)}`}.mp4`;
}

function compatPathFor(seriesId, vidIndex, quality = 'auto') {
  return path.join(getCompatDir(), compatFileName(seriesId, vidIndex, quality));
}

function compatCacheStatus() {
  const dir = getCompatDir();
  let files = 0;
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.mp4') || f.startsWith('.tmp_')) continue;
      try { bytes += fs.statSync(path.join(dir, f)).size; files++; } catch (_) {}
    }
  } catch (_) {}
  return { dir, files, bytes };
}

function trimCompatCache(currentOutput) {
  const dir = getCompatDir();
  const protectedFiles = new Set([currentOutput]);
  for (const [output, job] of compatPreparing) {
    protectedFiles.add(output);
    for (const file of job.files || []) protectedFiles.add(file);
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.mp4') && !f.startsWith('.tmp_'))
      .map((f) => {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        return { p, size: st.size, at: st.atimeMs || st.mtimeMs };
      });
  } catch (_) { return; }
  let total = entries.reduce((s, e) => s + e.size, 0);
  if (total <= COMPAT_MAX_BYTES) return;
  entries.sort((a, b) => a.at - b.at);
  for (const e of entries) {
    if (total <= COMPAT_MAX_BYTES) break;
    if (protectedFiles.has(e.p)) continue;
    try { fs.unlinkSync(e.p); total -= e.size; } catch (_) {}
  }
}


async function pickH264Encoder(ffmpegPath, task) {
  if (compatEncoder) return compatEncoder;
  const { execFile } = require('child_process');

  const list = await new Promise((resolve) => {
    const child = execFile(ffmpegPath, ['-hide_banner', '-encoders'], { timeout: 20000 }, (err, stdout) => {
      if (task?.child === child) delete task.child;
      resolve(String(stdout || ''));
    });
    if (task) task.child = child;
  });
  if (task?.cancelled) throw new Error('已取消');

  const candidates = (process.platform === 'darwin'
    ? ['h264_videotoolbox', 'libx264']
    : ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'libx264']).filter((e) =>
    list.includes(e)
  );
  if (!candidates.includes('libx264')) candidates.push('libx264');

  const works = (enc) =>
    new Promise((resolve) => {
      const child = execFile(
        ffmpegPath,
        ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
         '-frames:v', '1', '-c:v', enc, '-f', 'null', '-'],
        { timeout: 25000 },
        (err) => { if (task?.child === child) delete task.child; resolve(!err); }
      );
      if (task) task.child = child;
    });

  for (const enc of candidates) {
    if (task?.cancelled) throw new Error('已取消');
    if (await works(enc)) {
      compatEncoder = enc;
      break;
    }
    console.log('[Compat] 编码器不可用，跳过:', enc);
  }
  if (!compatEncoder) compatEncoder = 'libx264';
  console.log('[Compat] 使用编码器:', compatEncoder);
  return compatEncoder;
}





const compatPreparing = new Map();
const compatRequests = new Map();
let compatClearing = null;
const compatCancelled = () => ({ success: false, cancelled: true, error: '已取消转码' });
function cancelCompatJob(job) {
  job.cancelled = true;
  job.controller.abort();
}
ipcMain.handle('cancel-transcode-for-playback', async (_event, payload = {}) => {
  if (!payload.seriesId || payload.vidIndex == null) return { success: false };
  let key;
  try { key = compatPathFor(payload.seriesId, payload.vidIndex, playbackQuality(payload.quality, payload.vid || payload.seriesId)); }
  catch (error) { return { success: false, error: error.message }; }
  const request = payload.requestId ? compatRequests.get(String(payload.requestId)) : null;

  if (payload.requestId && (!request || request.key !== key)) return { success: true };
  const job = request ? request.job : compatPreparing.get(key);
  if (request) request.cancelled = true;
  if (job && (!request || [...job.requests.values()].every(item => item.cancelled))) {
    cancelCompatJob(job);
    await job.promise;
  }
  return { success: true };
});
ipcMain.handle('transcode-for-playback', async (event, payload = {}) => {
  if (!payload.seriesId || payload.vidIndex == null) return { success: false, error: '缺少剧集信息' };
  let key;
  try { key = compatPathFor(payload.seriesId, payload.vidIndex, playbackQuality(payload.quality, payload.vid || payload.seriesId)); }
  catch (error) { return { success: false, error: error.message }; }
  const requestId = String(payload.requestId || randomUUID());
  const existing = compatRequests.get(requestId);
  if (existing) return existing.key === key ? existing.promise : { success: false, error: '请求标识已用于其他剧集' };

  const previous = compatPreparing.get(key);
  let job = previous;
  if (job && !job.cancelled && job.sourceVid !== String(payload.vid || '')) return { success: false, error: '该集已有不同来源的准备请求，请稍后重试' };
  if (!job || job.cancelled) {
    job = { controller: new AbortController(), cancelled: false, requests: new Map(), files: new Set(), sourceVid: String(payload.vid || '') };
    const clearing = compatClearing;
    job.promise = Promise.resolve().then(async () => {
      if (previous) await previous.promise;
      if (clearing) await clearing;
      if (job.cancelled) return compatCancelled();
      return transcodeForPlayback(payload, job);
    }).catch(error => ({ success: false, error: error.message })).finally(() => {
      if (compatPreparing.get(key) === job) compatPreparing.delete(key);
    });
    compatPreparing.set(key, job);
  }
  const request = { key, job, requestId, cancelled: false };
  job.requests.set(requestId, request);
  compatRequests.set(requestId, request);
  request.promise = job.promise.then(result => ({ ...(request.cancelled ? compatCancelled() : result), requestId })).finally(() => {
    job.requests.delete(requestId);
    if (compatRequests.get(requestId) === request) compatRequests.delete(requestId);
  });
  return request.promise;
});

async function transcodeForPlayback(payload, job = { controller: new AbortController() }) {
  let tmpInput, tmpOut, diskInput;
  const signal = job.controller.signal;
  const checkCancelled = () => { if (signal.aborted) throw new Error('已取消转码'); };
  const abortPreparation = () => {
    const child = job.child;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch (_) {}
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  };
  const reportProgress = data => {
    if (!job.requests) return sendToRenderer('transcode-progress', { ...data, requestId: payload.requestId });
    for (const request of job.requests.values()) {
      if (!request.cancelled) sendToRenderer('transcode-progress', { ...data, requestId: request.requestId });
    }
  };
  signal.addEventListener('abort', abortPreparation, { once: true });
  try {
    checkCancelled();
    const { seriesId, vidIndex, filePath, force } = payload || {};
    const quality = playbackQuality(payload.quality, payload.vid || seriesId);
    if (!seriesId || vidIndex == null) return { success: false, error: '缺少剧集信息' };
    const out = compatPathFor(seriesId, vidIndex, quality);
    job.files ||= new Set();
    if (filePath) job.files.add(filePath);
    if (filePath && fs.existsSync(filePath) && !isInsideMediaRoot(filePath) && !isRecordedMediaFile(filePath, payload)) {
      return { success: false, error: '只能转码下载目录中的视频' };
    }
    if (!(filePath && fs.existsSync(filePath)) && (/^(xifan|hema|custom):/.test(String(seriesId)) || /^(xifan|hema|custom):/.test(String(payload.vid)))) {
      const current = await hongguo.fetchEpisodeList(seriesId);
      checkCancelled();
      const episode = current.episodes.find(ep => Number(ep.vid_index) === Number(vidIndex));
      if (!episode || (payload.vid && payload.vid !== episode.vid)) return { success: false, error: '分集来源不匹配' };
      if (episode.locked) return { success: false, error: '该集已锁定，请在来源平台解锁' };
    }

    if (!force && fs.existsSync(out) && fs.statSync(out).size > 1024 * 100) {

      try { fs.utimesSync(out, new Date(), new Date()); } catch (_) {}
      return { success: true, url: localPlayUrl(out), size: fs.statSync(out).size, cached: true };
    }

    const ffmpegPath = resolveFfmpeg('ffmpeg');
    const ffprobePath = resolveFfmpeg('ffprobe');
    if (!ffmpegPath) return { success: false, error: '未找到 ffmpeg，无法转码' };


    let inputPath = filePath || null;
    if (!inputPath || !fs.existsSync(inputPath)) {
      const vid = payload.vid;
      if (!vid) return { success: false, error: '既没有本地文件，也没有 vid' };
      const cached = !force && onlineCache.get(onlineCacheKey(vid, quality));
      if (cached?.filePath) { diskInput = cached; cached.disk.readers++; inputPath = cached.filePath; }
      else {
        const playInfo = String(vid).startsWith('custom:') ? await hongguo.fetchPlayUrlSingle(String(vid),seriesId,{force:!!force,quality}) : null;
        tmpInput = path.join(getCompatDir(), `.tmp_${randomUUID()}.mp4`);
        if (playInfo) await withMediaRecovery(vid,seriesId,{playInfo,signal,quality},async candidate => {
          if (candidate.format === 'hls') await prepareHlsFile(candidate,tmpInput,{signal});
          else {
            const buf = await fetchDecryptedEpisodeOnce(String(vid),()=>{},seriesId,candidate,signal);
            checkCancelled(); fs.writeFileSync(tmpInput,buf);
          }
        });
        else {
          const buf = cached?.buffer || await fetchDecryptedEpisode(String(vid), () => {}, seriesId, playInfo, signal, ONLINE_MAX_BYTES, !!force, quality);
          checkCancelled(); fs.writeFileSync(tmpInput,buf);
        }
        inputPath = tmpInput;
      }
    }

    if (quality !== 'auto') await verifyDownloadQuality(inputPath, quality);
    const duration = ffprobePath ? await probeDuration(ffprobePath, inputPath, job) : 0;
    checkCancelled();
    let encoder = force ? 'libx264' : await pickH264Encoder(ffmpegPath, job);
    checkCancelled();

    const started = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      checkCancelled();

      const encArgs = encoder === 'libx264'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-level', '4.2']
        : encoder === 'h264_videotoolbox'
        ? ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-pix_fmt', 'yuv420p']
        : encoder === 'h264_nvenc'
        ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '23', '-b:v', '0']
        : encoder === 'h264_qsv'
        ? ['-c:v', 'h264_qsv', '-global_quality', '23']
        : encoder === 'h264_amf'
        ? ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23']
        : ['-c:v', encoder, '-cq', '23'];

      tmpOut = out + '.part';
      try { fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut); } catch (_) {}

      const { spawn } = require('child_process');
      const args = [
        '-y', '-hide_banner', '-i', inputPath,
        ...encArgs,
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats',
        '-f', 'mp4', tmpOut,
      ];

      console.log(`[Compat] 转码 第${vidIndex}集  编码器=${encoder}  时长=${duration.toFixed(0)}s`);
      let stderrTail = '';
      const code = await new Promise((resolve) => {
        const child = spawn(ffmpegPath, args, { windowsHide: true });
        let killTimer;
        const abort = () => {
          try { child.kill('SIGTERM'); } catch (_) {}
          killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
          killTimer.unref?.();
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const m = line.match(/^out_time_us=(\d+)/);
            if (m && duration > 0) {
              const sec = parseInt(m[1], 10) / 1e6;
              const pct = Math.max(0, Math.min(99, Math.floor((sec / duration) * 100)));
              reportProgress({ seriesId: String(seriesId), vidIndex: Number(vidIndex), percent: pct });
            }
          }
        });
        child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-1500); });
        child.on('error', (e) => { stderrTail += ' | spawn: ' + e.message; resolve(-1); });
        child.on('close', (c) => {
          signal.removeEventListener('abort', abort);
          clearTimeout(killTimer);
          resolve(c);
        });
      });
      checkCancelled();

      if (code !== 0 || !fs.existsSync(tmpOut)) {
        try { fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut); } catch (_) {}
        const tail = stderrTail.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
        console.warn('[Compat] 转码失败 code=', code, tail);
        if (encoder !== 'libx264') {
          encoder = 'libx264';
          continue;
        }
        return { success: false, error: `软件转码失败（ffmpeg 退出码 ${code}）${tail ? '：' + tail : ''}` };
      }
      break;
    }

    fs.renameSync(tmpOut, out);
    trimCompatCache(out);
    const size = fs.statSync(out).size;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[Compat] 完成 ${(size / 1048576).toFixed(1)}MB  用时 ${elapsed}s`);

    reportProgress({ seriesId: String(seriesId), vidIndex: Number(vidIndex), percent: 100, done: true });
    return { success: true, url: localPlayUrl(out), size, elapsed: Number(elapsed), encoder };
  } catch (error) {
    if (signal.aborted) return compatCancelled();
    console.error('[Compat] 转码失败:', error.message);
    return { success: false, error: error.message, code: error.code };
  } finally {
    signal.removeEventListener('abort', abortPreparation);
    if (diskInput) { diskInput.disk.readers--; disposeOnlineDisk(diskInput); }
    for (const temporary of [tmpInput, tmpOut]) {
      if (temporary) { try { await fsp.unlink(temporary); } catch (_) {} }
    }
  }
}

ipcMain.handle('compat-cache-status', async () => {
  const st = compatCacheStatus();
  return { success: true, ...st, maxBytes: COMPAT_MAX_BYTES };
});

ipcMain.handle('clear-compat-cache', async () => {
  if (compatClearing) return compatClearing;
  const jobs = [...compatPreparing.values()];
  for (const job of jobs) cancelCompatJob(job);
  const clearing = Promise.all(jobs.map(job => job.promise)).then(() => {
    const dir = getCompatDir();
    let freed = 0, count = 0, failed = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.mp4') && !f.endsWith('.part')) continue;
        const p = path.join(dir, f);
        try { const size = fs.statSync(p).size; fs.unlinkSync(p); freed += size; count++; } catch (_) { failed++; }
      }
    } catch (_) { failed++; }
    return { success: failed === 0, count, freed, error: failed ? '部分兼容缓存删除失败，请稍后重试' : undefined };
  }).finally(() => { if (compatClearing === clearing) compatClearing = null; });
  compatClearing = clearing;
  return clearing;
});


ipcMain.handle('decode-capability', async () => ({
  ffmpegEncoder: compatEncoder || null,
  compatDir: getCompatDir(),
}));







async function enqueueEpisodes({ seriesId, seriesTitle, episodes, cover, quality }) {
  if (!Array.isArray(episodes) || episodes.length === 0) return 0;
  const settings = getCurrentSettings();
  const downloadQuality = normalizeDownloadQuality(quality ?? settings.download_quality);
  if (/^(xifan|hema|custom):/.test(String(seriesId))) {
    const current = await hongguo.fetchEpisodeList(seriesId);
    episodes = episodes.map(requested => {
      const ep = current.episodes.find(item => item.vid === requested.vid && Number(item.vid_index) === Number(requested.vid_index));
      if (!ep) throw new Error('分集不属于所选来源，请重新打开剧集');
      if (ep.locked) throw new Error('该集已锁定，请在来源平台解锁');
      return ep;
    });
  } else if (episodes.some(ep => /^(xifan|hema|custom):/.test(String(ep.vid)))) {
    throw new Error('剧集来源不匹配');
  }


  for (const ep of episodes) {
    const dup = downloadTasks.find(t => String(t.hongguoInfo?.vid) === String(ep.vid));
    if (!dup) continue;
    if (['pending', 'downloading'].includes(dup.status) && normalizeDownloadQuality(dup.downloadQuality) !== downloadQuality) {
      throw new Error('同一集已有其他清晰度的下载任务，请先停止该任务再重新选择');
    }
    if (dup.status === 'completed' && hasCompleteTaskFile(dup)) {
      dup.actualQuality = await verifyDownloadQuality(dup.savePath, downloadQuality, true);
    }
  }
  const root = (settings.root && String(settings.root).trim()) ? String(settings.root).trim() : app.getPath('downloads');
  const cleanSeriesTitle = sanitizeFolderName(seriesTitle) || '红果短剧';
  const downloadDir = seriesDownloadDir(root, seriesId, cleanSeriesTitle);
  try { fs.mkdirSync(downloadDir, { recursive: true }); } catch (_) {}

  const batchId = 'hongguobatch_' + randomUUID();
  const firstCover = cover || (episodes[0] && episodes[0].cover) || '';

  const batchInfo = {
    batchId,
    platform: 'hongguo',
    nickname: `《${cleanSeriesTitle}》`,
    avatar: firstCover,
    totalCount: episodes.length,
    createTime: Date.now(),
  };

  let created = 0;
  const changedTasks = [];
  const previousQueue = downloadQueue.slice();
  for (const ep of episodes) {
    const epIndexStr = String(ep.vid_index).padStart(3, '0');
    const filename = uniqueEpisodeFilename(settings, cleanSeriesTitle, ep);
    const finalPath = path.join(downloadDir, filename);


    const dup = downloadTasks.find(
      (t) => t.hongguoInfo && String(t.hongguoInfo.vid) === String(ep.vid)
    );
    if (dup) {

      if (dup.status === 'stopped' || dup.status === 'failed' || (dup.status === 'completed' && !hasCompleteTaskFile(dup))) {
        changedTasks.push({ task: dup, previous: { ...dup } });
        repairTaskDestination(dup);
        dup.status = 'pending';
        dup.cancelled = false;
        dup.progress = 0;
        dup.receivedBytes = 0;
        dup.totalBytes = 0;
        dup.downloadQuality = downloadQuality;
        delete dup.actualQuality;
        delete dup.error;
        if (!downloadQueue.some((t) => t.id === dup.id)) downloadQueue.push(dup);
        created++;
      }
      continue;
    }

    const task = {
      id: randomUUID(),
      batchId,
      batchInfo,
      savePath: finalPath,
      customDir: downloadDir,
      title: `《${cleanSeriesTitle}》第${epIndexStr}集${ep.title ? ' ' + ep.title : ''}`,
      filename,
      platform: 'hongguo',
      type: 'hongguo',
      downloadQuality,
      status: 'pending',
      progress: 0,
      receivedBytes: 0,
      totalBytes: 0,
      startTime: Date.now(),
      videoInfo: {
        author: cleanSeriesTitle,
        title: `《${cleanSeriesTitle}》第${epIndexStr}集`,
        cover: ep.cover || firstCover,
        aweme_id: ep.vid,
      },
      hongguoInfo: {
        vid: ep.vid,
        series_id: seriesId,
        series_title: cleanSeriesTitle,
        vid_index: ep.vid_index,
        ep_title: ep.title,
      },
    };

    downloadTasks.unshift(task);
    downloadQueue.push(task);
    sendToRenderer('download-task-added', task);
    created++;
  }

  try { saveDownloadTasks(); }
  catch (error) {

    downloadTasks = downloadTasks.filter(task => task.batchId !== batchId);
    for (const { task, previous } of changedTasks) Object.assign(task, previous);
    downloadQueue = previousQueue;
    sendToRenderer('download-queue-changed', {});
    throw error;
  }
  pumpQueue();
  return created;
}

ipcMain.handle('hongguo-download-batch', async (event, payload) => {
  try {
    const { seriesId, seriesTitle, episodes, quality } = payload || {};
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return { success: false, error: '未选择集数' };
    }
    const count = await enqueueEpisodes({ seriesId, seriesTitle, episodes, quality });
    return { success: true, count, requested: episodes.length };
  } catch (error) {
    console.error('[Hongguo] 提交批量下载失败:', error.message);
    return { success: false, error: error.message };
  }
});


ipcMain.handle('download-single-episode', async (event, seriesId, vidIndex, quality) => {
  try {
    const entry = seriesRegistry.find((s) => String(s.series_id) === String(seriesId));
    if (!entry) return { success: false, error: '未找到该剧档案，请先解析一次' };
    const ep = entry.episodes.find((e) => Number(e.vid_index) === Number(vidIndex));
    if (!ep) return { success: false, error: '未找到该集' };
    const count = await enqueueEpisodes({
      seriesId: entry.series_id,
      seriesTitle: entry.series_title,
      episodes: [{ ...ep, cover: entry.cover }],
      cover: entry.cover,
      quality,
    });
    return { success: true, count };
  } catch (error) {
    console.error('[Player] 下载单集失败:', error.message);
    return { success: false, error: error.message };
  }
});


let historyRefresh = null;
const HISTORY_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

function historyRows() {
  return watchHistory.listHistory(seriesRegistry, store.getPlayback(), getCurrentSettings().watch_sequels_enabled !== false);
}


const cloudHistoryApi = require('./src/native/cloud-history');
const CLOUD_HISTORY_TTL = 60 * 1000;
const CLOUD_HISTORY_FRESH_MS = 15 * 1000;
const CLOUD_UPLOAD_DELAY_MS = 1500;
const CLOUD_UPLOAD_INTERVAL_MS = 20 * 1000;
const CLOUD_UPLOAD_QUIT_MS = 3000;
const HISTORY_REMOVE_LIMIT = 100;
let cloudHistory = { userId: '', rows: null, fetchedAt: 0, error: '', pending: null };
const cloudUploads = new Map();

function cloudRequest() {
  const code = accountCode();
  return (method, path, query, body) => code.request(method, path, query, body);
}

async function loadCloudHistory(force = false) {
  const userId = syncedAccountId();
  if (!userId) return null;
  if (cloudHistory.userId !== userId) cloudHistory = { userId, rows: null, fetchedAt: 0, error: '', pending: null };
  if (!force && cloudHistory.rows && Date.now() - cloudHistory.fetchedAt < CLOUD_HISTORY_TTL) return cloudHistory;
  if (cloudHistory.pending) return cloudHistory.pending;
  const state = cloudHistory;
  let summary;
  state.pending = cloudHistoryApi.fetchHistory(cloudRequest(), { onSummary: value => { summary = value; } }).then(rows => {
    if (cloudHistory !== state) return cloudHistory;
    Object.assign(state, { rows, reportedTotal: summary?.reportedTotal ?? null, fetchedAt: Date.now(), error: '' });
    persistAccountSession();
    return state;
  }, error => {
    if (cloudHistory === state) state.error = String(error?.message || '手机历史暂时读不到');
    return state;
  }).finally(() => { state.pending = null; });
  return state.pending;
}


function uploadEntryFor(sid, record, userId) {
  const series = seriesRegistry.find(item => String(item.series_id) === sid);
  const episode = (series?.episodes || []).find(item => Number(item.vid_index) === record.vid_index);
  const cloud = cloudHistory.userId === userId ? (cloudHistory.rows || []).find(row => row.series_id === sid) : null;
  return {
    series_id: sid, vid_index: record.vid_index, currentTime: Number(record.currentTime) || 0, updatedAt: record.updatedAt,
    total: Math.max(Number(series?.total) || 0, series?.episodes?.length || 0, Number(record.knownTotal) || 0, Number(record.remote?.total) || 0),
    cloudVid: String(episode?.vid || episode?.video_id || cloud?.cloudVid || ''),
    seasonIndex: cloud?.seasonIndex || 0, multiSeason: cloud?.multiSeason === true, duration: cloud?.duration || 0,
  };
}



let historySync = null;
let historyRemoval = null;
async function syncCloudHistory(force = false) {
  while (historyRemoval) await historyRemoval;
  if (historySync) return historySync;
  historySync = (async () => {
    const state = await loadCloudHistory(force);
    if (!state?.rows || state.error) return state;
    if (!force && state.mergedAt === state.fetchedAt) return state;
    const userId = state.userId;
    const plan = cloudHistoryApi.reconcileHistory({ playback: store.getPlayback(), cloudRows: state.rows, userId });
    store.savePlayback(plan.playback);
    const sent = [];
    const failures = [];
    for (const sid of plan.toUpload.slice(0, 30)) {
      if (syncedAccountId() !== userId) return state;
      const record = store.getPlayback()[sid];
      if (!record) continue;
      try { await cloudHistoryApi.uploadEntry(cloudRequest(), uploadEntryFor(sid, record, userId)); sent.push(sid); }
      catch (error) { failures.push(error.message); }
    }
    if (sent.length) {
      try {
        let summary;
        const rows = await cloudHistoryApi.fetchHistory(cloudRequest(), { onSummary: value => { summary = value; } });
        state.reportedTotal = summary?.reportedTotal ?? null;
        if (cloudHistory === state) Object.assign(state, { rows, fetchedAt: Date.now() });
        const listed = new Set(rows.map(row => row.series_id));
        const map = store.getPlayback();
        for (const sid of sent) if (map[sid] && listed.has(sid)) map[sid] = { ...map[sid], cloudSynced: userId };
        store.savePlayback(map);
      } catch (error) { failures.push(error.message); }
    }
    const countNotice = state.reportedTotal > state.rows.length ? `帳號回報 ${state.reportedTotal} 部，已讀取 ${state.rows.length} 部；分類以已讀取記錄計算。` : '';
    Object.assign(state, { mergedAt: state.fetchedAt, notice: [countNotice, plan.notice].filter(Boolean).join('；'),
      uploadError: failures.length ? `有 ${failures.length} 部没有同步到手机，稍后会再试（${failures[0]}）` : '' });
    return state;
  })().finally(() => { historySync = null; });
  return historySync;
}



async function watchHistoryView(force = false) {
  if (!signedInRecord()) return { success: true, results: historyRows(), sync: { mode: 'local' } };
  const state = await syncCloudHistory(force);
  const local = historyRows();
  if (!state) return { success: true, results: local, sync: { mode: 'local', error: '登录已过期或这台电脑没有保存会话，请重新登录后同步手机历史' } };
  if (!state.rows) return { success: true, results: local, sync: { mode: 'local', error: `手机历史暂时读不到，先显示这台电脑的记录（${state.error || '请稍后重试'}）` } };
  const errors = [state.error ? `刚才没有更新成功，显示的是 ${new Date(state.fetchedAt).toLocaleTimeString('zh-CN')} 合并的结果` : '', state.uploadError || ''].filter(Boolean);
  return {
    success: true,
    results: local.map(row => ({ ...row, synced: watchHistory.sourceOf(String(row.series_id)) === 'hongguo' ? row.cloudSynced === state.userId : undefined })),
    sync: { mode: 'cloud', userId: state.userId, syncedAt: state.fetchedAt, accountCount: state.rows.length, reportedTotal: state.reportedTotal, ...(errors.length ? { error: errors.join('；') } : {}), ...(state.notice ? { notice: state.notice } : {}) },
  };
}


function scheduleCloudUpload(seriesId) {
  const userId = syncedAccountId();
  if (!userId) return;
  const sid = String(seriesId);
  if (watchHistory.sourceOf(sid) !== 'hongguo') return;
  let slot = cloudUploads.get(sid);
  if (!slot || slot.userId !== userId) {
    if (slot) clearTimeout(slot.timer);
    slot = { userId, timer: null, running: null, dirty: false, sentAt: 0 };
    cloudUploads.set(sid, slot);
  }
  if (slot.running) { slot.dirty = true; return; }
  if (slot.timer !== null) return;
  const wait = Math.max(CLOUD_UPLOAD_DELAY_MS, slot.sentAt + CLOUD_UPLOAD_INTERVAL_MS - Date.now());
  slot.timer = setTimeout(() => runCloudUpload(sid, slot), wait);
}

function runCloudUpload(sid, slot) {
  if (cloudUploads.get(sid) !== slot) return Promise.resolve();
  if (slot.running) return slot.running;
  clearTimeout(slot.timer);
  slot.timer = null;
  slot.dirty = false;
  slot.running = (async () => {
    if (syncedAccountId() !== slot.userId) return;
    const record = store.getPlayback()[sid];
    if (!record) return;
    try {
      await cloudHistoryApi.uploadEntry(cloudRequest(), uploadEntryFor(sid, record, slot.userId));
      if (cloudHistory.userId === slot.userId) cloudHistory.fetchedAt = 0;
      sendToRenderer('watch-history-updated', {});
    } catch (error) {
      console.warn('[History] 手机历史同步失败:', error.message);
    }
  })().finally(() => {
    slot.running = null;
    slot.sentAt = Date.now();
    if (cloudUploads.get(sid) !== slot || !slot.dirty) return;
    slot.dirty = false;
    scheduleCloudUpload(sid);
  });
  return slot.running;
}

function cancelCloudUpload(sid) {
  const slot = cloudUploads.get(sid);
  if (!slot) return null;
  clearTimeout(slot.timer);
  cloudUploads.delete(sid);
  return slot.running;
}

function clearCloudUploads() {
  for (const slot of cloudUploads.values()) clearTimeout(slot.timer);
  cloudUploads.clear();
}

function flushCloudUploads(limitMs = CLOUD_UPLOAD_QUIT_MS) {
  const jobs = [];
  for (const [sid, slot] of cloudUploads) {
    if (slot.running) {
      jobs.push(slot.dirty ? slot.running.then(() => {
        const next = cloudUploads.get(sid);
        return next && next.timer !== null ? runCloudUpload(sid, next) : undefined;
      }) : slot.running);
    } else if (slot.timer !== null) jobs.push(runCloudUpload(sid, slot));
  }
  if (!jobs.length) return null;
  let timer;
  return Promise.race([
    Promise.allSettled(jobs),
    new Promise(resolve => { timer = setTimeout(resolve, limitMs); }),
  ]).finally(() => clearTimeout(timer));
}

const HISTORY_ACCOUNT_SWITCHED = '帳號已切換，請重新操作。';
const HISTORY_NOT_LISTED = '这部剧不在观看记录中';

function historyRemovalError(item) {
  if (item.code === 'CLOUD_DELETE_STOPPED') return HISTORY_ACCOUNT_SWITCHED;
  if (item.code === 'CLOUD_DELETE_UNCONFIRMED') return item.message;
  return `从手机历史移除失败：${item.message || '请稍后重试'}`;
}

async function removeHistoryEntries(seriesIds, { missingOk = false } = {}) {
  const ids = [...new Set((Array.isArray(seriesIds) ? seriesIds : [seriesIds]).map(String))];
  while (historyRemoval) await historyRemoval;
  let release;
  historyRemoval = new Promise(resolve => { release = resolve; });
  try {
    if (historySync) await historySync.catch(() => {});
    const userId = syncedAccountId();
    const removed = [], failed = [];
    const fail = (id, error) => failed.push({ series_id: id, error });
    const cloudIds = userId ? ids.filter(id => watchHistory.sourceOf(id) === 'hongguo') : [];
    const cloudSet = new Set(cloudIds);
    const confirmed = new Set(ids.filter(id => !cloudSet.has(id)));
    const held = cloudIds.filter(id => cloudUploads.has(id));
    if (cloudIds.length) {
      await Promise.allSettled(cloudIds.map(id => cancelCloudUpload(id)).filter(Boolean));
      const state = await loadCloudHistory(true);
      if (syncedAccountId() !== userId || state?.userId !== userId) cloudIds.forEach(id => fail(id, HISTORY_ACCOUNT_SWITCHED));
      else if (!state?.rows || state.error) cloudIds.forEach(id => fail(id, `手机历史暂时读不到，没有移除（${state?.error || '请稍后重试'}）`));
      else {
        const map = store.getPlayback();
        const listed = new Map(state.rows.map(row => [row.series_id, row]));
        const targets = [];
        for (const id of cloudIds) {
          if (listed.has(id)) targets.push(listed.get(id));
          else if (map[id]) confirmed.add(id);
          else fail(id, HISTORY_NOT_LISTED);
        }
        if (targets.length) {
          let summary;
          const outcome = await cloudHistoryApi.deleteEntries(cloudRequest(), targets, {
            keepGoing: () => syncedAccountId() === userId, onSummary: value => { summary = value; },
          });
          if (outcome.rows && cloudHistory === state) {
            Object.assign(state, { rows: outcome.rows, reportedTotal: summary?.reportedTotal ?? null, fetchedAt: Date.now(), mergedAt: 0, error: '' });
          }
          for (const id of outcome.removed) confirmed.add(id);
          for (const item of outcome.failed) fail(item.id, historyRemovalError(item));
        }
        if (syncedAccountId() !== userId) {
          for (const id of cloudIds) if (confirmed.delete(id)) fail(id, HISTORY_ACCOUNT_SWITCHED);
        }
      }
    }
    const latest = store.getPlayback();
    let changed = false;
    for (const id of ids) {
      if (!confirmed.has(id)) continue;
      cancelCloudUpload(id);
      if (watchHistory.forgetPlayback(latest, id)) { changed = true; removed.push(id); }
      else if (cloudSet.has(id) || missingOk) removed.push(id);
      else fail(id, HISTORY_NOT_LISTED);
    }
    if (changed) store.savePlayback(latest);
    for (const id of held) if (!removed.includes(id) && latest[id]) scheduleCloudUpload(id);
    if (removed.length) sendToRenderer('watch-history-updated', removed.length === 1 ? { removedSeriesId: removed[0] } : { removedSeriesIds: removed });
    return { removed, failed, cloud: cloudIds.length > 0 };
  } finally {
    historyRemoval = null;
    release();
  }
}

async function removeWatchHistoryEverywhere(seriesId, options = {}) {
  const outcome = await removeHistoryEntries([String(seriesId)], options);
  if (outcome.failed.length) return { success: false, error: outcome.failed[0].error };
  return { success: true, cloud: outcome.cloud, history: await watchHistoryView(false) };
}

async function refreshWatchHistory(force = false) {
  if (historyRefresh) return historyRefresh;
  if (!force && getCurrentSettings().watch_updates_enabled === false) return { success: true, checked: 0, disabled: true };
  historyRefresh = (async () => {
    const now = Date.now();

    const due = historyRows().filter(item => seriesRegistry.some(entry => String(entry.series_id) === String(item.series_id)))
      .filter(item => force || now - item.lastCheckedAt >= HISTORY_CHECK_INTERVAL)
      .sort((a, b) => a.lastCheckedAt - b.lastCheckedAt);
    const batch = due.slice(0, 20);
    let checked = 0, failed = 0;
    for (const row of batch) {
      const sid = String(row.series_id);
      const oldSeries = seriesRegistry.find(item => String(item.series_id) === sid);
      try {
        const fresh = await hongguo.fetchEpisodeList(sid);
        if (!Array.isArray(fresh?.episodes) || !fresh.episodes.length) throw new Error('来源没有返回分集，请稍后重试');
        const settings = getCurrentSettings();
        let candidates = null, sequelError = '';
        const previous = store.getPlayback()[sid];
        const source = watchHistory.sourceOf(sid);
        if (source && settings.watch_sequels_enabled !== false && (force || now - (previous?.lastSequelCheckAt || 0) >= 24 * 60 * 60 * 1000)) {
          try {
            const response = await seriesSearch.findSeriesSequels(oldSeries, seriesRegistry.filter(item => !item.forgotten),
              keyword => searchAtSource(keyword, { source }));
            if (!response?.success) throw new Error(response?.error || '搜索暂不可用');
            candidates = response.results || [];
            const optionalNewRelease = /^补充搜索未完成：App 上新补搜/.test(String(response.error || ''));
            if (response.partial && !optionalNewRelease) sequelError = `新集已检查；续作检查未完成：${response.error || '请稍后重试'}`;
          } catch (error) { sequelError = `新集已检查；续作检查失败：${error.message}`; }
        }

        const map = store.getPlayback();
        if (!map[sid]) continue;
        const previousRecord = map[sid];
        const next = watchHistory.applyEpisodeUpdate(previousRecord, oldSeries, fresh);
        if (candidates) {
          const combined = new Map((previousRecord.sequels || []).map(item => [item.series_id, item]));
          for (const item of candidates) combined.set(item.series_id, item);
          next.sequels = [...combined.values()].slice(-20);
          if (!sequelError) next.lastSequelCheckAt = Date.now();
        }
        next.lastCheckError = sequelError;
        const newEpisodes = next.knownTotal > (previousRecord.knownTotal ?? oldSeries.total ?? oldSeries.episodes.length);
        const knownSequels = new Set((previousRecord.sequels || []).map(item => item.series_id));
        const newSequel = candidates?.some(item => !knownSequels.has(item.series_id));
        if (fresh.episodes.length >= oldSeries.episodes.length) {
          const currentSeries = seriesRegistry.find(item => String(item.series_id) === sid);
          const wasDismissed = currentSeries?.dismissed === true;
          const wasForgotten = currentSeries?.forgotten === true;
          upsertSeriesRegistry(fresh);
          if (wasDismissed) {
            Object.assign(seriesRegistry.find(item => String(item.series_id) === sid), { dismissed: true, forgotten: wasForgotten });
            saveSeriesRegistry();
          }
        }
        map[sid] = next;
        store.savePlayback(map);
        checked++;
        if (sequelError) failed++;
        if ((newEpisodes || newSequel) && settings.watch_notifications_enabled === true && Notification?.isSupported()) {
          try {
            const notification = new Notification({ title: `${oldSeries.series_title} 有更新`,
              body: newEpisodes ? `已更新至 ${next.knownTotal} 集，打开观看记录继续看。` : '发现疑似新一季，打开观看记录查看。' });
            notification.on('click', () => {
              if (!mainWindow || mainWindow.isDestroyed()) createWindow();
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show(); mainWindow.focus();
              sendToRenderer('navigate', { page: 'history' });
            });
            notification.show();
          } catch (error) { console.warn('[History] 系统通知不可用:', error.message); }
        }
      } catch (error) {
        failed++;
        const map = store.getPlayback();
        if (map[sid]) {
          map[sid] = { ...map[sid], lastCheckedAt: Date.now(), lastCheckError: error.message };
          store.savePlayback(map);
        }
      }
    }
    sendToRenderer('watch-history-updated', {});
    return { success: true, checked, failed, remaining: Math.max(0, due.length - batch.length) };
  })().catch(error => ({ success: false, error: error.message })).finally(() => { historyRefresh = null; });
  return historyRefresh;
}


const cloudFavoritesApi = require('./src/native/cloud-favorites');
const favoriteMeta = new Map();
const favoriteFoldersApi = require('./src/native/favorite-folders');
const FAVORITE_SYNC_ERROR = '手機收藏暫時無法同步，這臺電腦的收藏仍會保留。請稍後重試。';
const FAVORITE_DEFERRED = '部分影片尚無法加入手機收藏，已先保留在這臺電腦；可播放後會再同步。';



async function favoriteDetails(rows) {
  const history = cloudHistory.userId && cloudHistory.rows ? new Map(cloudHistory.rows.map(row => [row.series_id, row])) : new Map();
  const missing = [];
  for (const row of rows) {
    const known = favoriteMeta.get(row.id) || history.get(row.id) || seriesRegistry.find(item => String(item.series_id) === row.id);
    if (known?.series_title) favoriteMeta.set(row.id, { series_title: known.series_title, cover: known.cover || '' });
    if (!known?.series_title || !known?.cover) missing.push(row.id);
  }
  const queue = missing.slice(0, 30);
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const data = await hongguo.fetchSeriesMetadata(id);
        if (data?.series_title && String(data.series_id) === id) favoriteMeta.set(id, { series_title: favoriteMeta.get(id)?.series_title || data.series_title, cover: data.cover || favoriteMeta.get(id)?.cover || '' });
      } catch {                                                      }
    }
  }));
  return rows.map(row => {
    const meta = favoriteMeta.get(row.id);
    return { ...row, title: meta?.series_title || '', cover: typeof meta?.cover === 'string' && /^https?:\/\//i.test(meta.cover) ? meta.cover : '' };
  });
}

ipcMain.handle('cloud-favorites', async () => {
  const userId = syncedAccountId();
  if (!userId) {
    return { success: true, mode: 'local', ...(signedInRecord() ? { error: '登录已过期或这台电脑没有保存会话，请重新登录后同步手机收藏' } : {}) };
  }
  try {
    const rows = await cloudFavoritesApi.fetchFavorites(cloudRequest(), userId);
    const details = await favoriteDetails(rows);
    let folders, foldersError = '';
    try { folders = await favoriteFoldersApi.fetchFolders(cloudRequest()); }
    catch { foldersError = '收藏夾暫時無法讀取，仍可查看全部收藏。'; }
    if (syncedAccountId() !== userId) return { success: false, error: '帳號已切換，請重新整理。' };
    return { success: true, mode: 'cloud', userId, rows: details, ...(folders ? { folders } : {}), ...(foldersError ? { foldersError } : {}) };
  } catch (error) {
    return { success: true, mode: 'local', userId, error: FAVORITE_SYNC_ERROR };
  }
});

let folderMutationBusy = false;
const folderRules = require('./src/native/folder-rules');
function folderRequest(userId) {
  const client = accountCode();
  return async (method, path, query, body) => {
    const valid = () => syncedAccountId() === userId && accountCode() === client;
    if (!valid()) throw folderRules.folderError('FOLDER_ACCOUNT');
    let response;
    try {
      response = await client.request(method, path, query, body, {
        retry: path !== favoriteFoldersApi.UPDATE_PATH && path !== favoriteFoldersApi.ITEM_PATH,
        expectedUserId: userId,
      });
    } catch (error) {
      if (!valid() || error.message === 'ACCOUNT_CHANGED') throw folderRules.folderError('FOLDER_ACCOUNT');
      throw error;
    }
    if (!valid()) throw folderRules.folderError('FOLDER_ACCOUNT');
    return response;
  };
}
ipcMain.handle('cloud-folder-list', async (_event, expectedUserId) => {
  const userId = syncedAccountId();
  if (!userId || String(expectedUserId || '') !== userId) return { success: false, error: folderRules.publicError({ code: 'FOLDER_ACCOUNT' }) };
  try {
    const folders = await favoriteFoldersApi.fetchFolders(folderRequest(userId));
    return { success: true, userId, folders };
  } catch (error) {
    return { success: false, userId, error: folderRules.publicError(error) };
  }
});
ipcMain.handle('cloud-folder-change', async (_event, input) => {
  const userId = syncedAccountId();
  if (!userId || input?.userId !== userId) return { success: false, error: folderRules.publicError({ code: 'FOLDER_ACCOUNT' }) };
  if (folderMutationBusy) return { success: false, userId, error: folderRules.publicError({ code: 'FOLDER_BUSY' }) };
  folderMutationBusy = true;
  try {
    const result = await favoriteFoldersApi.changeFolder(folderRequest(userId), { ...input, userId });
    return { success: true, userId, ...result };
  } catch (error) {
    return { success: false, userId, uncertain: error.uncertain === true, error: folderRules.publicError(error) };
  } finally {
    folderMutationBusy = false;
  }
});

ipcMain.handle('cloud-favorite-set', async (_event, seriesId, on, expectedUserId) => {
  const userId = syncedAccountId();
  if (expectedUserId !== undefined && String(expectedUserId) !== userId) return { success: false, error: '帳號已切換，請重新整理。' };
  if (!userId) return { success: false, error: '没有登录，收藏只保存在这台电脑' };
  const id = cloudFavoritesApi.readId(String(seriesId || ''));
  if (!id || typeof on !== 'boolean') return { success: false, error: '这部剧无法同步到手机收藏' };
  try {
    if (on) {
      let playable = false;
      try {
        const detail = await hongguo.fetchEpisodeList(id);
        playable = Array.isArray(detail?.episodes) && detail.episodes.length > 0;
      } catch {}
      if (syncedAccountId() !== userId) return { success: false, error: '帳號已切換，請重新整理。' };
      if (!playable) return { success: true, userId, deferred: true, notice: FAVORITE_DEFERRED };
    }
    const rows = await cloudFavoritesApi.setFavorite(cloudRequest(), userId, id, on);
    if (syncedAccountId() !== userId) return { success: false, error: '帳號已切換，請重新整理。' };
    return { success: true, userId, rows: rows.map(row => ({ ...row })) };
  } catch (error) {
    if (on && cloudFavoritesApi.unavailable(error)) return { success: true, userId, deferred: true, notice: FAVORITE_DEFERRED };
    return { success: false, code: error.code === 'CLOUD_FAVORITE_UNCONFIRMED' ? error.code : '', error: FAVORITE_SYNC_ERROR };
  }
});

ipcMain.handle('remove-watch-history', async (_event, seriesId, expectedUserId) => {
  if (expectedUserId !== undefined && String(expectedUserId) !== syncedAccountId()) return { success: false, error: '帳號已切換，請重新整理。' };
  try { return await removeWatchHistoryEverywhere(seriesId, { missingOk: true }); }
  catch (error) { return { success: false, error: error.message || '移除失败，请重试' }; }
});

ipcMain.handle('remove-watch-history-batch', async (_event, seriesIds, expectedUserId) => {
  if (expectedUserId !== undefined && String(expectedUserId) !== syncedAccountId()) return { success: false, error: '帳號已切換，請重新整理。' };
  if (!Array.isArray(seriesIds) || !seriesIds.length || seriesIds.length > HISTORY_REMOVE_LIMIT
    || !seriesIds.every(id => typeof id === 'string' && id && id.length <= 200)) return { success: false, error: '請重新選擇要移除的觀看紀錄。' };
  try {
    const outcome = await removeHistoryEntries(seriesIds, { missingOk: true });
    return { success: true, removed: outcome.removed, failed: outcome.failed, cloud: outcome.cloud, history: await watchHistoryView(false) };
  } catch (error) { return { success: false, error: error.message || '移除失败，请重试' }; }
});

ipcMain.handle('get-watch-history', async (_event, options) => {
  const fresh = options?.fresh === true && !!syncedAccountId() && Date.now() - (cloudHistory.fetchedAt || 0) >= CLOUD_HISTORY_FRESH_MS;
  try { return await watchHistoryView(fresh); }
  catch (error) { return { success: true, results: historyRows(), sync: { mode: 'local', error: error.message } }; }
});
ipcMain.handle('refresh-watch-history', async () => {
  const cloud = syncedAccountId() ? await syncCloudHistory(true) : null;
  const result = await refreshWatchHistory(true);
  return cloud?.error ? { ...result, cloudError: cloud.error } : result;
});
ipcMain.handle('delete-watch-history', async (_event, seriesId) => {
  try { return await removeWatchHistoryEverywhere(seriesId); }
  catch (error) { return { success: false, error: error.message || '移除失败，请重试' }; }
});
ipcMain.handle('acknowledge-watch-updates', async (_event, seriesId, snapshot) => {
  try {
    const map = store.getPlayback();
    const sid = String(seriesId);
    if (map[sid]) { map[sid] = watchHistory.acknowledge(map[sid], snapshot); store.savePlayback(map); }
    sendToRenderer('watch-history-updated', {});
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});


ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

const SETTINGS_KEYS = ['root', 'name_format', 'max_concurrent', 'download_quality', 'auto_delete_watched', 'compat_mode', 'cache_next_episode', 'show_danmaku_controls', 'app_updates_enabled', 'watch_updates_enabled', 'watch_sequels_enabled', 'watch_notifications_enabled', 'proxy_enabled', 'proxy_mode', 'proxy_host', 'proxy_port', 'proxy_username', 'proxy_password'];

function settingsForRenderer(settings) {
  const copy = { ...settings };
  copy.proxy_password_set = !!copy.proxy_password;
  delete copy.proxy_password;
  return copy;
}

function applyEditableSettings(current, incoming) {
  const source = normalizeProxySettings(incoming && typeof incoming === 'object' ? incoming : {});
  const merged = { ...current };
  for (const key of SETTINGS_KEYS) {
    if (key === 'proxy_password') continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) merged[key] = source[key];
  }
  if (source.clear_proxy_password === true) merged.proxy_password = '';
  else if (typeof source.proxy_password === 'string' && source.proxy_password.length > 0) merged.proxy_password = source.proxy_password;
  else merged.proxy_password = current.proxy_password || '';
  merged.custom_sources = current.custom_sources;
  return merged;
}

let accountCodeClient;

function readSavedSession() {
  try {
    const blob = store.getLoginSession();
    if (!blob || !safeStorage?.isEncryptionAvailable?.()) return null;
    return JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64')));
  } catch { return null; }
}

function persistAccountSession() {
  try {
    const snapshot = accountCodeClient?.snapshot();
    if (!snapshot || !safeStorage?.isEncryptionAvailable?.()) { store.saveLoginSession(''); return false; }
    store.saveLoginSession(safeStorage.encryptString(JSON.stringify(snapshot)).toString('base64'));
    return true;
  } catch { return false; }
}

function forgetAccountSession() {
  accountCodeClient?.reset();
  try { store.saveLoginSession(''); } catch {                                                  }
  cloudHistory = { userId: '', rows: null, fetchedAt: 0, error: '', pending: null };
  clearCloudUploads();
}

function accountCode() {
  if (!accountCodeClient) {
    const { createCodeClient } = require('./src/native/account-code');
    accountCodeClient = createCodeClient({
      getDevice: () => store.getLoginDevice(),
      saveDevice: (device) => store.saveLoginDevice(device),
    });
    const record = store.getAccount();
    const saved = readSavedSession();
    if (record?.userId && saved?.userId === record.userId) accountCodeClient.restore(saved);
    else if (saved) store.saveLoginSession('');
  }
  return accountCodeClient;
}

function accountHandlers() {
  const { createAccountHandlers } = require('./src/native/account-session');
  const { fetchAvatar } = require('./src/native/account-avatar');
  const code = accountCode();
  return createAccountHandlers({
    getAccount: () => store.getAccount(),
    saveAccount: (record) => store.saveAccount(record),
    sendTransport: (input) => code.send(input),
    loginTransport: (input) => code.login(input),
    profileTransport: () => code.profile(),
    avatarTransport: (candidates) => fetchAvatar(candidates),
  });
}


function signedInRecord() {
  try {
    const record = store.getAccount?.();
    const { publicAccount } = require('./src/native/account-profile');
    return record && publicAccount(record, Date.now()).loggedIn ? record : null;
  } catch { return null; }
}

function syncedAccountId() {
  const record = signedInRecord();
  if (!record) return '';
  try {
    const code = accountCode();
    return code.signedIn() && code.user() === record.userId ? record.userId : '';
  } catch { return ''; }
}

ipcMain.handle('account-status', async () => {
  try {
    const status = await (await accountHandlers()).status();

    if (!status.loggedIn && (accountCodeClient?.signedIn() || store.getLoginSession())) forgetAccountSession();
    return status;
  }
  catch { return { loggedIn: false }; }
});

ipcMain.handle('account-send-code', async (_event, input) => {
  try { return await (await accountHandlers()).sendCode(input); }
  catch { return { ok: false, error: '驗證碼暫時無法傳送，請稍後再試' }; }
});

ipcMain.handle('account-login', async (_event, input) => {
  try {
    const result = await (await accountHandlers()).login(input);
    if (result?.ok) {
      cloudHistory = { userId: '', rows: null, fetchedAt: 0, error: '', pending: null };
      persistAccountSession();
      sendToRenderer('watch-history-updated', {});
    }
    return result;
  }
  catch { return { ok: false, error: '登入沒有完成，請重試' }; }
});

ipcMain.handle('account-refresh', async () => {
  try {
    const status = await (await accountHandlers()).refresh();
    if (status?.loggedIn) persistAccountSession();
    return status;
  }
  catch {
    try { return await (await accountHandlers()).status(); }
    catch { return { loggedIn: false }; }
  }
});

ipcMain.handle('account-logout', async () => {
  try {
    forgetAccountSession();
    const status = await (await accountHandlers()).logout();
    sendToRenderer('watch-history-updated', {});
    return status;
  }
  catch { return { loggedIn: false }; }
});

ipcMain.handle('get-settings', async () => settingsForRenderer(getCurrentSettings()));

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    const current = getCurrentSettings();
    const wasCheckingUpdates = current.app_updates_enabled !== false;
    const merged = applyEditableSettings(current, settings);
    merged.download_quality = normalizeDownloadQuality(merged.download_quality);

    if (Object.prototype.hasOwnProperty.call(settings || {}, 'app_updates_enabled')) merged.app_update_channel = 'self';
    store.saveSettings(merged);
    if (merged.app_updates_enabled === false) { updateDownloadGeneration++; appUpdateInstaller?.cancel(); }
    if (wasCheckingUpdates !== (merged.app_updates_enabled !== false)) {
      sendToRenderer('app-update-preference', merged.app_updates_enabled !== false);
    }
    getCurrentSettings();
    await applyProxySettings(merged);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('get-proxy-status', async () => {
  const settings = getCurrentSettings();
  const resolved = resolveProxyConfig(settings);
  return {
    enabled: settings.proxy_enabled === true,
    mode: resolved.mode,
    url: publicProxyUrl(resolved.url),
    effective: resolved.mode !== 'direct' && !!resolved.url,
  };
});


ipcMain.handle('test-proxy', async (event, draft) => {
  const settings = applyEditableSettings(getCurrentSettings(), draft);
  const resolved = resolveProxyConfig(settings);
  if (resolved.mode === 'custom' && !resolved.url) {
    return { success: false, error: '请填写完整的代理地址与端口' };
  }


  let proxyOption = false;
  if (resolved.url) {
    try {
      const url = new URL(resolved.url);
      proxyOption = { protocol: url.protocol.replace(':', ''), host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
      if (url.username) proxyOption.auth = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    } catch (_) { return { success: false, error: '代理地址格式无效' }; }
  }

  const started = Date.now();
  try {
    const res = await axios.get('https://www.baidu.com', {
      timeout: 12000,
      proxy: proxyOption,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      validateStatus: () => true,
    });
    const ms = Date.now() - started;
    if (res.status >= 200 && res.status < 400) {
      return {
        success: true,
        elapsed: ms,
        mode: resolved.mode,
        via: publicProxyUrl(resolved.url) || '(直连)',
        message: `API/下载连通正常（HTTP ${res.status}，耗时 ${ms}ms）`,
      };
    }
    return { success: false, error: `请求返回 HTTP ${res.status}（耗时 ${ms}ms）` };
  } catch (error) {
    const ms = Date.now() - started;
    const code = (error && error.code) || '';
    let hint = publicProxyError(error.message, settings, resolved);
    if (code === 'ECONNREFUSED') hint = '代理端口拒绝连接，请确认代理软件已启动、端口填写正确';
    else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') hint = '连接超时，请检查代理地址/端口或代理是否可用';
    else if (code === 'ENOTFOUND') hint = '无法解析代理地址，请检查主机名';
    else if (/407/.test(hint)) hint = '代理需要认证，请填写用户名与密码';
    return { success: false, error: `${hint}（耗时 ${ms}ms）`, code };
  }
});


ipcMain.handle('get-download-tasks', () => {
  const STATUS_ORDER = {
    downloading: 0,
    pending: 1,
    failed: 2,
    stopped: 3,
    completed: 4,
  };
  const sorted = downloadTasks.slice().sort((a, b) => {
    const wa = STATUS_ORDER[a.status] ?? 99;
    const wb = STATUS_ORDER[b.status] ?? 99;
    if (wa !== wb) return wa - wb;
    if (wa <= 1) {
      return (a.hongguoInfo?.vid_index || 0) - (b.hongguoInfo?.vid_index || 0) || (a.startTime || 0) - (b.startTime || 0);
    }
    return (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0);
  });
  return sorted.map((task) => {
    const { cancelSource, writer, ...serializableTask } = task;
    if (task.status === 'completed' && !hasCompleteTaskFile(task)) {
      return { ...serializableTask, status: 'failed', progress: 0, qualityNotice: '', error: '本地文件已丢失或路径冲突，请重新下载' };
    }
    return { ...serializableTask, qualityNotice: ['downloading', 'completed'].includes(task.status) ? task.qualityNotice || '' : '' };
  });
});





function removeEpisodeFiles(paths, owners) {
  let freed = 0, failed = 0, count = 0, warning;
  for (const file of new Set(paths.filter(Boolean))) {
    const family = episodeFilePaths(file);
    if (!ownsEpisodeFiles(file, owners) || family.some(isFileInUse)
      || owners.some(task => mergeTasks.some(merge => String(merge.seriesId) === String(task.hongguoInfo?.series_id) && merge.status === 'running'))) {
      warning = '文件正在使用或登记给其他任务／合并产物，已保留文件和任务记录';
      continue;
    }
    for (const p of family) {
      try {
        if (fs.existsSync(p)) {
          const st = fs.statSync(p);
          fs.unlinkSync(p);
          freed += st.size; count++;
        }
      } catch (_) { failed++; }
    }
  }
  return { count, freed, failed, warning };
}

async function stopTaskAndWait(task) {
  clearSourceRetry(task);
  task.cancelled = true;
  task.cancelSource?.cancel('用户删除任务');
  task.writer?.destroy();
  task.status = 'stopped';
  downloadQueue = downloadQueue.filter(item => item.id !== task.id);
  await downloadRuns.get(task.id);
}

function isTaskInFlight(task) {
  return task.status === 'pending' || task.status === 'downloading' || runningDownloads.has(task.id);
}

function isFileInUse(file) {
  return runningDownloadPaths.has(file) || downloadTasks.some(task => task.savePath === file && isTaskInFlight(task));
}

function removeFinishedRecords(seriesId, saveChanges = false) {
  const ids = downloadTasks.filter(task => (seriesId == null || String(task.hongguoInfo?.series_id) === String(seriesId)) && !isTaskInFlight(task) && task.status === 'completed' && task.savePath && episodeFilePaths(task.savePath).every(file => !fs.existsSync(file))).map(task => task.id);
  if (ids.length || saveChanges) dropTaskRecords(ids);
}


function dropTaskRecords(ids) {
  const set = new Set(ids.filter(id => !downloadTasks.some(task => task.id === id && isTaskInFlight(task))));
  const previousTasks = downloadTasks, previousQueue = downloadQueue;
  downloadTasks = downloadTasks.filter((t) => !set.has(t.id));
  downloadQueue = downloadQueue.filter((t) => !set.has(t.id));
  try { saveDownloadTasks(); }
  catch (error) { downloadTasks = previousTasks; downloadQueue = previousQueue; throw error; }
  return previousTasks.length - downloadTasks.length;
}

async function deleteTaskRecords(taskIds, options) {
  const deleteFiles = options?.deleteFiles === true;
  let freed = 0, failed = 0, fileCount = 0, count = 0;
  let cancelledRetries = false;
  const removed = [], errors = [], warnings = [];
  for (const id of new Set(taskIds)) {
    const task = downloadTasks.find(item => item.id === id);
    if (!task) continue;
    if (deleteFiles && mergeTasks.some(merge => String(merge.seriesId) === String(task.hongguoInfo?.series_id) && merge.status === 'running')) {
      failed++; errors.push('该剧正在合并，请完成或取消合并后再删除文件'); continue;
    }
    try {
      cancelledRetries = cancelScheduledRetries([task]) || cancelledRetries;
      clearSourceRetry(task);
      if (isTaskInFlight(task)) {
        await stopTaskAndWait(task);
        if (!downloadTasks.includes(task) || isTaskInFlight(task) || task.cancelled === false || task.retryAt) {
          errors.push('任务状态已变化，已保留文件和记录，请重试'); continue;
        }
      }
      if (deleteFiles) {
        const result = removeEpisodeFiles([task.savePath], [task]);
        freed += result.freed; fileCount += result.count; failed += result.failed;
        if (result.warning) { warnings.push(result.warning); errors.push(result.warning); }
        if (result.failed) { errors.push('部分文件删除失败，对应任务记录已保留'); continue; }
        if (result.warning) continue;
      }
      removed.push(id);
    } catch (error) { errors.push(error.message); }
  }
  try { if (removed.length || cancelledRetries) count = dropTaskRecords(removed); }
  catch (error) { errors.push(`任务记录保存失败，原记录已保留：${error.message}${cancelledRetries ? '；自动重试取消状态未保存' : ''}`); }
  return { success: errors.length === 0, count, fileCount, freed, failed, warning: warnings.length ? [...new Set(warnings)].join('；') : undefined, error: errors.length ? [...new Set(errors)].join('；') : undefined };
}

ipcMain.handle('delete-task', (_event, taskId, options) => {
  if (!downloadTasks.some(task => task.id === taskId)) return { success: false, count: 0, fileCount: 0, freed: 0, failed: 0, error: '任务不存在' };
  return deleteTaskRecords([taskId], options);
});

ipcMain.handle('delete-tasks', (_event, taskIds, options) => {
  if (!Array.isArray(taskIds) || !taskIds.length) return { success: false, count: 0, fileCount: 0, freed: 0, failed: 0, error: '没有要删除的任务' };
  return deleteTaskRecords(taskIds, options);
});





function deleteSeriesFiles(seriesId, options) {
  try {
    const sid = String(seriesId);
    const includeMerged = !(options && options.includeMerged === false);
    if (mergeTasks.some(task => task.seriesId === sid && task.status === 'running')) return { success: false, error: '该剧正在合并，请完成或取消合并后再清理' };
    const entry = seriesRegistry.find(s => String(s.series_id) === sid);
    const title = entry?.series_title || '';
    const files = collectSeriesEpisodeFiles(sid, title);
    const { dir } = files;
    const paths = new Set([...files.episodePaths, ...files.temporaryPaths,
      ...(includeMerged ? [...files.mergedPaths, ...files.concatPaths] : [])]);
    const cancelledRetries = cancelScheduledRetries(downloadTasks.filter(task => String(task.hongguoInfo?.series_id) === sid));
    let count = 0, freed = 0, failed = files.scanFailed;
    for (const file of paths) {
      if (isFileInUse(file)) continue;
      try {
        if (!fs.existsSync(file)) continue;
        const size = fs.statSync(file).size;
        fs.unlinkSync(file);
        freed += size;
        count++;
      } catch (_) { failed++; }
    }

    try { if (dir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_) {}
    try { removeFinishedRecords(sid, cancelledRetries); }
    catch (error) { return { success: false, count, freed, failed, error: `文件清理已执行；任务记录保存失败，原记录已保留：${error.message}${cancelledRetries ? '；自动重试取消状态未保存' : ''}` }; }
    return { success: failed === 0, count, freed, failed, error: failed ? '部分文件删除失败，对应记录已保留' : undefined };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

ipcMain.handle('delete-series-files', (_event, seriesId, options) => deleteSeriesFiles(seriesId, options));


async function deleteEpisodeFile(seriesId, vidIndex) {
  try {
    const sid = String(seriesId);
    const idx = Number(vidIndex);
    if (!sid || !Number.isSafeInteger(idx) || idx < 1) return { success: false, error: '剧集信息无效', count: 0, freed: 0 };
    const tasks = downloadTasks.filter(task => String(task.hongguoInfo?.series_id) === sid && Number(task.hongguoInfo?.vid_index) === idx);
    if (tasks.some(isTaskInFlight) || mergeTasks.some(task => task.seriesId === sid && task.status === 'running')) return { success: false, error: '该集正在下载或合并，暂不删除', count: 0, freed: 0 };
    const entry = seriesRegistry.find(item => String(item.series_id) === sid);
    const scanned = collectSeriesEpisodeFiles(sid, entry?.series_title || '');
    const paths = [...tasks.map(task => task.savePath), ...scanned.ordered.filter(episode => episode.vid_index === idx).map(episode => episode.path),
      ...(scanned.dir ? [...scanned.episodeNames].filter(([, index]) => index === idx).map(([name]) => path.join(scanned.dir, name)) : [])];
    const cancelledRetries = cancelScheduledRetries(tasks);
    const result = removeEpisodeFiles(paths, tasks);
    const ids = tasks.filter(task => task.savePath && ownsEpisodeFiles(task.savePath, tasks)
      && episodeFilePaths(task.savePath).every(file => !fs.existsSync(file))).map(task => task.id);
    try { if (ids.length || cancelledRetries) dropTaskRecords(ids); }
    catch (error) { return { ...result, success: false, error: `文件清理已执行；任务记录保存失败，原记录已保留：${error.message}${cancelledRetries ? '；自动重试取消状态未保存' : ''}` }; }
    return { ...result, success: result.failed === 0 && !result.warning,
      error: [result.warning, result.failed ? '文件删除失败，任务记录已保留' : ''].filter(Boolean).join('；') || undefined };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

ipcMain.handle('delete-episode-file', (_event, seriesId, vidIndex) => deleteEpisodeFile(seriesId, vidIndex));


ipcMain.handle('cleanup-watched-episode', async (_event, seriesId, vidIndex) => {
  try {
    const sid = String(seriesId), idx = Number(vidIndex);
    if (!sid || !Number.isSafeInteger(idx) || idx < 1) return { success: false, error: '剧集信息无效' };
    const matches = entry => entry && String(entry.seriesId) === sid && Number(entry.vidIndex) === idx;
    const compatFiles = ['auto', '720p', '1080p'].map(quality => compatPathFor(sid, idx, quality));
    if ([...onlineSessions.values()].some(session => matches(session.entry || session)) || compatFiles.some(file => compatPreparing.has(file))) {
      return { success: false, error: '该集仍在播放或准备，稍后再清理' };
    }
    const result = await deleteEpisodeFile(sid, idx);
    if (!result.success) return result;
    for (const [key, entry] of [...onlineCache]) {
      if (!matches(entry)) continue;
      const bytes = entry.size || 0;
      deleteOnlineCacheEntry(key);
      if (entry.filePath && fs.existsSync(entry.filePath)) { onlineCache.set(key, entry); result.failed++; continue; }
      result.freed += bytes;
      result.count++;
    }
    for (const file of compatFiles) {
      if (isFileInUse(file)) { result.failed++; continue; }
      try {
        if (fs.existsSync(file)) { const size = fs.statSync(file).size; fs.unlinkSync(file); result.freed += size; result.count++; }
      } catch (_) { result.failed++; }
    }
    result.success = !result.failed;
    if (!result.success) result.error = '部分缓存清理失败，请稍后重试';
    return result;
  } catch (error) { return { success: false, error: error.message }; }
});


ipcMain.handle('get-storage-usage', async () => {
  try {
    const series = [];
    let totalBytes = 0;
    let totalFiles = 0;
    for (const s of seriesRegistry) {
      if (s.dismissed) continue;
      const owned = collectSeriesEpisodeFiles(s.series_id, s.series_title);
      const merging = mergeTasks.some(task => String(task.seriesId) === String(s.series_id) && task.status === 'running');
      const paths = merging ? [] : new Set([...owned.episodePaths, ...owned.temporaryPaths, ...owned.mergedPaths, ...owned.concatPaths]);
      let bytes = 0, files = 0, merged = 0;
      for (const file of paths) {
        if (isFileInUse(file)) continue;
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) continue;
          bytes += stat.size; files++;
          if (owned.mergedPaths.has(file)) merged++;
        } catch (_) {}
      }
      totalBytes += bytes;
      totalFiles += files;
      series.push({
        series_id: String(s.series_id),
        series_title: s.series_title,
        total: (s.episodes || []).length,
        files,
        bytes,
        merged,
      });
    }
    series.sort((a, b) => b.bytes - a.bytes);
    return { success: true, totalBytes, totalFiles, series };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('delete-all-downloaded', async () => {
  try {
    let freed = 0, count = 0, failed = 0, skipped = 0;
    const errors = [];
    const targets = [...new Set([...seriesRegistry.map(s => s.series_id), ...downloadTasks.map(t => t.hongguoInfo?.series_id).filter(Boolean)])];
    for (const sid of targets) {
      if (mergeTasks.some(task => String(task.seriesId) === String(sid) && task.status === 'running')) { skipped++; continue; }
      const result = deleteSeriesFiles(sid);
      if (result.error) errors.push(result.error);
      count += result.count || 0;
      freed += result.freed || 0;
      failed += result.failed ?? (result.success ? 0 : 1);
    }
    return { success: failed === 0 && errors.length === 0, count, freed, failed, skipped, warning: skipped ? `${skipped} 部剧正在合并，已跳过` : undefined, error: (failed || errors.length) ? [...new Set(errors)].join('；') || '部分文件删除失败，对应记录已保留' : undefined };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('stop-download', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  clearSourceRetry(task);
  task.cancelled = true;
  if (task.cancelSource) { try { task.cancelSource.cancel('用户停止下载'); } catch (_) {} }
  if (task.writer) { try { task.writer.destroy(); } catch (_) {} }

  task.status = 'stopped';
  task.error = '';
  task.endTime = Date.now();
  delete task.cancelSource;
  delete task.writer;

  saveDownloadTasks();
  sendToRenderer('download-stopped', { id: taskId, path: task.savePath });
  return { success: true };
});

ipcMain.handle('retry-task', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };
  if (!['failed', 'stopped'].includes(task.status) && !(task.status === 'completed' && !hasCompleteTaskFile(task))) return { success: false, error: '任务仍在进行中或已完成' };

  clearSourceRetry(task);
  repairTaskDestination(task);

  task.status = 'pending';
  task.progress = 0;
  task.receivedBytes = 0;
  task.totalBytes = 0;
  task.cancelled = false;
  delete task.error;
  delete task.cancelSource;
  delete task.writer;

  if (!downloadQueue.some((t) => t.id === taskId)) downloadQueue.push(task);
  saveDownloadTasks();
  processDownloadQueue();
  return { success: true };
});

ipcMain.handle('retry-tasks', async (event, taskIds) => {
  if (!Array.isArray(taskIds) || taskIds.length === 0) return { success: false, error: '没有要重试的任务' };
  let count = 0;
  for (const taskId of taskIds) {
    const task = downloadTasks.find((t) => t.id === taskId);
    if (task && (task.status === 'failed' || task.status === 'stopped' || (task.status === 'completed' && !hasCompleteTaskFile(task)))) {
      clearSourceRetry(task);
      repairTaskDestination(task);
      task.status = 'pending';
      task.progress = 0;
      task.receivedBytes = 0;
      task.totalBytes = 0;
      task.cancelled = false;
      delete task.error;
      delete task.cancelSource;
      delete task.writer;
      if (!downloadQueue.some((t) => t.id === taskId)) downloadQueue.push(task);
      count++;
    }
  }
  if (count > 0) {
    saveDownloadTasks();
    processDownloadQueue();
  }
  return { success: true, count };
});


ipcMain.handle('pause-all', async () => ({ success: true, count: pauseAllTasks() }));

ipcMain.handle('resume-all', async () => ({ success: true, count: resumeAllTasks() }));


ipcMain.handle('get-queue-status', async () => ({
  active: activeDownloads,
  queued: downloadQueue.length,
  maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
}));

ipcMain.handle('open-folder', async (event, taskId) => {
  const task = downloadTasks.find((t) => t.id === taskId);
  if (!task) return { success: false, error: '任务不存在' };

  if (task.customDir && fs.existsSync(task.customDir)) {
    await shell.openPath(task.customDir);
    return { success: true };
  }
  if (task.savePath && fs.existsSync(task.savePath)) {
    const isDir = fs.statSync(task.savePath).isDirectory();
    if (isDir) {
      await shell.openPath(task.savePath);
    } else {
      shell.showItemInFolder(task.savePath);
    }
    return { success: true };
  }
  if (task.savePath) {
    const parentDir = path.dirname(task.savePath);
    if (fs.existsSync(parentDir)) {
      await shell.openPath(parentDir);
      return { success: true };
    }
  }
  return { success: false, error: '文件夹不存在' };
});



let appUpdateChecksEnabled = true;
function appUpdatesAllowed() {
  return appUpdateChecksEnabled === true && !IS_PREVIEW && getCurrentSettings().app_updates_enabled !== false;
}


let updateRequest = null;
let latestAppRelease = null;
function appUpdateSupport() {
  let reason = '';
  if (IS_PREVIEW || !app.isPackaged) reason = '开发或预览版本不支持应用内安装，请使用正式安装版。';
  else if (process.platform === 'win32' && (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)) reason = '便携版需手动更新。请先退出旧程序，再运行发布页中的 setup 安装包，并从安装后生成的快捷方式启动；安装版支持后续应用内更新。若仍用便携版，请完整解压新版并直接运行新版文件。';
  else if (!['darwin', 'win32'].includes(process.platform)) reason = '当前系统请前往发布页手动更新。';
  else if (process.platform === 'darwin' && (process.execPath.startsWith('/Volumes/') || process.execPath.includes('/AppTranslocation/'))) reason = '请先将应用放入“应用程序”文件夹后重新打开，再使用应用内更新。';
  return { supported: !reason, reason };
}
function appUpdateState() {
  return appUpdateInstaller?.getState() || { ...appUpdateSupport(), status: 'idle', version: null, percent: 0, error: '' };
}
function getAppUpdateInstaller() {
  if (!appUpdateInstaller) {
    appUpdater = require('electron-updater').autoUpdater;
    appUpdater.on('login', (authInfo, callback) => {
      if (matchesProxyAuth(authInfo)) callback(activeProxyAuth.username, activeProxyAuth.password);
      else callback();
    });
    appUpdateInstaller = require('./src/native/app-update-installer').createUpdateInstaller({
      updater: appUpdater,
      currentVersion: APP_VERSION,
      isEnabled: () => appUpdatesAllowed(),
      installBlocker: () => {
        if (pendingUpdateOperations) return '正在处理任务或保存设置，请稍后再安装更新。';
        if (downloadRuns.size || downloadQueue.length || sourceRetryTimers.size) return '还有下载或等待重试的任务，请先在下载管理中暂停全部任务，再安装更新。';
        if (mergeTasks.some(task => task.status === 'running') || compatPreparing.size || onlinePreparing.size) return '正在合并或准备视频，请等待完成或取消后再安装更新。';
        if (storageError) return '本地数据保存异常，请先处理保存问题，再安装更新。';
        return '';
      },
      emit: state => sendToRenderer('app-update-state', state),
    });
  }
  return appUpdateInstaller;
}
ipcMain.handle('get-app-update-state', () => appUpdateState());
ipcMain.handle('download-app-update', async () => {
  const support = appUpdateSupport();
  if (!support.supported) return { success: false, error: support.reason };
  if (!latestAppRelease || !appUpdatesAllowed()) return { success: false, error: '更新信息已失效，请重新检查更新。' };
  try {
    const request = updateDownloadGeneration;
    const installer = getAppUpdateInstaller();
    if (!['checking', 'downloading', 'downloaded', 'installing'].includes(installer.getState().status)) {
      await applyProxyToSession(resolveProxyConfig(getCurrentSettings()), [appUpdater.netSession]);
    }
    if (request !== updateDownloadGeneration) return { success: false, error: '更新已取消。', state: installer.getState() };
    return await installer.download(latestAppRelease.version);
  }
  catch (_) { return { success: false, error: '无法准备应用内更新，请重试或前往发布页下载安装。' }; }
});
ipcMain.handle('cancel-app-update', () => {
  if (appUpdateInstaller?.getState().status === 'installing') return { success: false, error: '正在安装更新，无法取消。', state: appUpdateState() };
  updateDownloadGeneration++;
  if (!appUpdateInstaller) return { success: true, state: appUpdateState() };
  return appUpdateInstaller.cancel();
});
ipcMain.handle('install-app-update', () => {
  if (!appUpdateInstaller) return { success: false, error: '请先完成更新下载。' };
  return appUpdateInstaller.install();
});
ipcMain.handle('check-app-update', async event => {
  if (IS_PREVIEW || !mainWindow || event.sender !== mainWindow.webContents) return { enabled: false, release: null };
  if (!appUpdatesAllowed()) {
    latestAppRelease = null;
    return { enabled: false, release: null };
  }
  if (!updateRequest) {
    updateRequest = axios.get(LATEST_API, {
      timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Hongguo-Drama-Update-Check' },
    }).catch(() => axios.get(LATEST_PAGE, {

      timeout: 10000, maxRedirects: 0, maxContentLength: 1024 * 1024,
      headers: { Accept: 'application/json', 'User-Agent': 'Hongguo-Drama-Update-Check' },
      validateStatus: status => status === 200 || status === 302,
    }).then(response => {
      if (response.status !== 302) return response;
      const tag = updateRedirectTag(response.headers.location);
      if (!tag) throw new Error('Unexpected update redirect');
      return { data: { tag_name: tag } };
    })).then(response => ({ release: availableRelease(response.data, APP_VERSION), error: '' }))
      .catch(() => ({ release: null, error: '暂时无法检查更新，请检查网络后重试。' }))
      .finally(() => { updateRequest = null; });
  }
  const result = await updateRequest;
  const enabled = appUpdatesAllowed();
  latestAppRelease = enabled ? result.release : null;
  return { enabled, release: latestAppRelease, error: enabled ? result.error : '' };
});
ipcMain.handle('open-app-update', async event => {
  if (IS_PREVIEW || !mainWindow || event.sender !== mainWindow.webContents || !appUpdatesAllowed()) {
    return { success: false, error: '更新信息已失效，请稍后重试' };
  }
  try { await shell.openExternal(latestAppRelease?.url || LATEST_PAGE); return { success: true }; }
  catch { return { success: false, error: '无法打开浏览器，请稍后重试' }; }
});


ipcMain.handle('get-public-details', async (event, seriesId, vid) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { success: false, error: 'Window unavailable' };
  return fetchPublicDetails(seriesId, vid);
});
ipcMain.handle('get-public-ratings', async (event, ids) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { success: false, error: 'Window unavailable' };
  return fetchPublicRatings(ids);
});
ipcMain.handle('get-episode-comments', async (event, options) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { success: false, error: 'Window unavailable' };
  return fetchEpisodeComments(options);
});

ipcMain.handle('get-episode-danmaku', async (_event, options) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return fetchDanmaku(null);
  const { seriesId, vid, fresh, limit, prefetch } = options;
  return fetchDanmaku({ seriesId, vid, fresh, limit, prefetch: prefetch === true });
});

ipcMain.handle('get-app-info', async () => ({
  version: APP_VERSION,
  brand: APP_TITLE,
  appName: APP_TITLE,
  platform: process.platform,
  preview: IS_PREVIEW,
}));


ipcMain.handle('open-external-url', async (event, url) => {
  if (!url) return { success: false, error: '缺少链接' };
  try {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      return { success: false, error: '仅支持打开网页链接' };
    }
    await shell.openExternal(target.href);
    return { success: true };
  } catch (err) {
    console.error('[Shell] 打开链接失败:', err.message);
    return { success: false, error: err.message };
  }
});

let windowLayout = 'landscape';
let landscapeBounds = null;
let layoutChanging = false;
const stealth = createStealthController({ screen, getWindow: () => mainWindow });
function syncMainWindowScale() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const scale = getWindowScale(getCurrentSettings().ui_zoom);
  mainWindow.webContents.setZoomFactor(scale);
}
function changeMainWindowZoom(direction) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    saveWindowZoom(store, direction);
    syncMainWindowScale();
  } catch (_) {
    sendToRenderer('storage-error', { error: '界面大小保存失败，请检查磁盘空间或目录权限后重试。' });
  }
}
ipcMain.handle('set-stealth-mode', async (event, enabled) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof enabled !== 'boolean') return { success: false, error: '无法切换小窗' };
  if (enabled && (mainWindow.isFullScreen() || layoutChanging)) return { success: false, error: '请先退出全屏，再开启隐身小窗' };
  try {
    episodePanel.close();
    stealth.setEnabled(enabled);
    syncMainWindowScale();
    return { success: true };
  } catch (error) { return { success: false, error: error.message }; }
});
const episodePanel = createEpisodePanelController({ ipcMain, screen, getMainWindow: () => mainWindow, getLayout: () => windowLayout });
ipcMain.handle('get-window-layout', () => windowLayout);
ipcMain.handle('set-window-layout', async (event, mode) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !['portrait', 'landscape'].includes(mode)) {
    return { success: false, error: '无法切换窗口布局' };
  }
  if (stealth.enabled) return { success: false, error: '请先退出隐身小窗' };
  if (layoutChanging) return { success: false, error: '窗口正在切换，请稍后重试' };
  if (mode === windowLayout) return { success: true, mode };
  layoutChanging = true;
  try {
    const win = mainWindow;
    if (mode === 'portrait') landscapeBounds = win.getNormalBounds();
    if (win.isFullScreen()) {
      await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { win.removeListener('leave-full-screen', done); reject(new Error('请先退出全屏后再切换')); }, 3000);
        win.once('leave-full-screen', done);
        win.setFullScreen(false);
      });
    }
    if (win.isMaximized()) win.unmaximize();
    if (mode === 'landscape') episodePanel.close();
    const current = win.getBounds();
    const area = screen.getDisplayMatching(current).workArea;
    const bounds = fitWindowBounds(mode, current, area, landscapeBounds);
    win.setMinimumSize(Math.min(mode === 'portrait' ? 420 : 900, bounds.width), Math.min(560, bounds.height));
    win.setBounds(bounds);
    windowLayout = mode;
    syncMainWindowScale();
    return { success: true, mode };
  } catch (error) {
    return { success: false, error: error.message };
  } finally { layoutChanging = false; }
});


function createWindow() {
  windowLayout = 'landscape';
  landscapeBounds = null;
  const workArea = screen?.getPrimaryDisplay?.()?.workArea;
  const limits = initialWindowSize(workArea);
  mainWindow = new BrowserWindow({
    width: limits.width,
    height: limits.height,
    minWidth: limits.minWidth,
    minHeight: limits.minHeight,
    title: APP_TITLE,
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 20, y: 18 },
    } : {}),
    autoHideMenuBar: true,
    backgroundColor: '#f5f6fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      zoomMode: 'isolated',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      paintWhenInitiallyHidden: true,
    },
  });

  mainWindow.once('ready-to-show', () => revealMaximized(mainWindow));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('resize', syncMainWindowScale);
  mainWindow.on('enter-full-screen', syncMainWindowScale);
  mainWindow.on('leave-full-screen', syncMainWindowScale);
  mainWindow.webContents.on('did-finish-load', syncMainWindowScale);
  mainWindow.webContents.on('zoom-changed', (_event, direction) => changeMainWindowZoom(direction));
  syncMainWindowScale();
  rendererSecurity.protectWindow(mainWindow);
  episodePanel.attach(mainWindow);
  mainWindow.webContents.once('did-finish-load', () => {
    if (storageError) sendToRenderer('storage-error', storageError);
  });


  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist-react', 'index.html'));
  }

  mainWindow.on('close', event => {
    if (process.platform !== 'darwin' && !quitReady) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.on('closed', () => {
    stealth.dispose();
    mediaAccess.clear();
    clearOnlineCache();
    for (const job of compatPreparing.values()) { job.cancelled = true; job.controller.abort(); }
    mainWindow = null;
  });
}



app.on('web-contents-created', (_event, contents) => {
  const allowed = (webContents, permission, details) => ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)
    && details?.isMainFrame === true && rendererSecurity.isTrustedUrl(details.requestingUrl)
    && rendererSecurity.isTrustedSender({ sender: webContents, senderFrame: webContents?.mainFrame }, mainWindow);
  contents.session.setPermissionRequestHandler((webContents, permission, callback, details) => callback(allowed(webContents, permission, details)));
  contents.session.setPermissionCheckHandler((webContents, permission, _origin, details) => allowed(webContents, permission, details));
});

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  require('./src/native/system-trust').trustSystemCertificates();
  let startupStage = '读取本地数据';
  try {
    const dataFile = path.join(app.getPath('userData'), 'data.json');
    store.init(dataFile);
    require('./src/native/public-details').initRatingStore(path.join(app.getPath('userData'), 'ratings-cache.json'));
    require('./src/native/comic').service().configure({ file: path.join(app.getPath('userData'), 'comic-cache.json') });
    require('./src/native/browse-cache').shared.configure({ file: path.join(app.getPath('userData'), 'browse-cache.json') });
    require('./src/native/browse-cache').shared.startPeriodicRefresh();
    setDeviceIdentityFile(path.join(app.getPath('userData'), 'danmaku-client.json'));
    loadDownloadTasks();
    loadSeriesRegistry();
    try { rebuildSeriesRegistryFromTasks(); } catch (_) {                                                                     }

    loadMergeTasks();
    getCompatDir();
    registerStreamProtocol();
    registerLocalProtocol();
    const settings = getCurrentSettings();


    startupStage = '初始化网络';
    let proxyDeadline;
    try {
      await Promise.race([
        applyProxySettings(settings),
        new Promise((_, reject) => { proxyDeadline = setTimeout(() => reject(new Error('Proxy startup timeout')), 15000); }),
      ]);
    } finally { clearTimeout(proxyDeadline); }



    for (const task of downloadTasks) if (task.status === 'failed' && task.retryAt) armSourceRetry(task);
    const resumed = enqueuePendingTasks();
    if (resumed > 0) {
      console.log(`[Queue] 启动自动续跑 ${resumed} 个等待中任务，并发 ${MAX_CONCURRENT_DOWNLOADS}`);
      pumpQueue();
    }

    app.on('activate', () => {
      stealth.setEnabled(false);
      syncMainWindowScale();

      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });

    if (process.platform === 'darwin') {
      app.setAboutPanelOptions?.({ applicationVersion: APP_VERSION.replace(/^(\d+\.\d+)\.0$/, '$1'), version: '' });
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: APP_TITLE, submenu: [
          { role: 'about', label: `关于${APP_TITLE}` },
          { type: 'separator' },
          { role: 'services', label: '服务' },
          { type: 'separator' },
          { role: 'hide', label: '隐藏' },
          { role: 'hideOthers', label: '隐藏其他应用' },
          { role: 'unhide', label: '显示全部' },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ] },
        { label: '编辑', submenu: [
          { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
        ] },
        { label: '视图', submenu: [
          { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => changeMainWindowZoom('reset') },
          { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => changeMainWindowZoom('in') },
          { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => changeMainWindowZoom('out') },
          { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' },
        ] },
        { label: '窗口', submenu: [
          { role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' },
          { type: 'separator' },
          { label: '回到主窗口', accelerator: 'CmdOrCtrl+1', click: () => app.emit('activate') },
          { label: '退出隐身小窗', click: () => { stealth.setEnabled(false); syncMainWindowScale(); } },
        ] },
      ]));
    }
    startupStage = '创建主窗口';
    createWindow();
    prewarmBrowseLists();
    setTimeout(() => { void refreshWatchHistory(); }, 10000).unref();
    setInterval(() => { void refreshWatchHistory(); }, 15 * 60 * 1000).unref();
  } catch (_) {
    console.error(`[Startup] ${startupStage}失败`);
    try {
      dialog.showErrorBox(`${APP_TITLE}启动失败`, `未能完成${startupStage}。请退出后重试；若仍失败，请将此提示反馈给开发者。已有资料不会被清空。`);
    } finally { app.quit(); }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', event => {
  if (quitCleanup) { event.preventDefault(); return; }
  const jobs = [...compatPreparing.values()];
  const pending = [...jobs.map(job => job.promise), ...mergeRuns.values(), ...downloadRuns.values()];
  if (compatClearing) pending.push(compatClearing);
  if (mergeTempCleanup) pending.push(mergeTempCleanup);
  const uploads = flushCloudUploads();
  if (uploads) pending.push(uploads);
  const downloading = downloadRuns.size || downloadQueue.length || sourceRetryTimers.size;
  if (!pending.length && !downloading) { quitReady = true; return; }
  event.preventDefault();
  if (downloading) {
    try { pauseAllTasks(); }
    catch (_) {
      dialog.showErrorBox('退出未完成', '无法保存下载暂停状态，已取消本次退出。请检查本地存储后重试。');
      return;
    }
  }
  for (const job of jobs) cancelCompatJob(job);
  for (const task of mergeTasks) {
    if (task.status !== 'running') continue;
    task.cancelled = true;
    require('./src/native/merge-runner').stopMergeChildren(task);
  }
  let timer;

  quitCleanup = Promise.race([
    Promise.allSettled(pending).then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); }),
  ]).then(completed => {
    clearTimeout(timer);
    quitCleanup = null;
    if (completed) app.quit();
    else dialog.showErrorBox('退出未完成', '任务清理超过 10 秒，已取消本次退出。应用未强制关闭，原始分集保留；任务仍在收尾，请稍后再次退出。');
  });
});
