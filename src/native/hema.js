const axios = require('axios');
const { shared: listCache } = require('./browse-cache');
const hemaApp = require('./hema-app');

const ORIGIN = 'https://www.kuaikaw.cn';
const ID = /^\d{1,30}$/;
const OSS_COVER_HOST = /(^|\.)(zqkanshu\.com|aliyuncs\.com|kkyd\.cn)$/i;
const COVER_PROCESS = 'image/resize,w_320/quality,q_80';
const LOCKED_HINT = '本集为河马付费章节，免费试看集以外需在河马官方 App 内解锁后才能播放';
let genreCache;
let directoryPending;

const GENRE_GROUPS = [
  { label: '古装权谋', match: /女帝|宫女|古装|权谋|王妃|皇后|庶女|公主|毒士|嫡女|古代言情|修仙|玄幻仙侠|古穿今|今古连通/ },
  { label: '甜宠情感', match: /甜宠|青梅|冤家|暗恋|破镜|追[妻夫]火葬|闪婚|团宠|情感|虐恋|后悔|现代言情|婚姻|中年婚恋/ },
  { label: '都市逆袭', match: /战神|强者回归|赘婿|废柴|逆袭|弃少|马甲|无敌|神医|神眼|神豪|高手下山|女高手下山|总裁|女总裁|都市|小人物/ },
  { label: '豪门复仇', match: /豪门|复仇|替身|原配|真假千金|千金|虐渣|反派/ },
  { label: '年代乡土', match: /民国|年代|乡村|种田|致富|抗战|家国情仇|现实|家庭|家庭主妇/ },
  { label: '萌宝亲情', match: /萌宝|亲情|寻亲|换亲|团宠/ },
  { label: '奇幻脑洞', match: /超能|系统|读心|偷听心声|奇幻|末世|神话|玄学|长生|空间|重生|穿越|科幻|传承觉醒|迪化/ },
  { label: '悬疑灵异', match: /悬疑|灵异|求生|鉴宝/ },
  { label: '职场律政', match: /职场|律政|商战/ },
  { label: '青春成长', match: /青春|女性成长|励志|校园|师生|娱乐圈/ },
  { label: '漫剧动画', match: /2D漫|3D漫|仿真人|小说漫|漫剧|沙雕漫/ },
  { label: '喜剧轻松', match: /喜剧|轻松|包租公|厨神|戏曲/ },
  { label: '战争功夫', match: /战争|功夫|竞赛|体育|武打/ },
];

function plainText(value) {
  return String(value || '').replace(/<[^>]*>/g, '').trim();
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}

function optimizeCover(value) {
  const raw = httpsUrl(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!OSS_COVER_HOST.test(url.hostname)) return raw;
    const stamp = (url.search.match(/[?&]t=(\d{1,20})(?=&|$)/) || [])[1];
    return `${url.origin}${url.pathname}?${stamp ? `t=${stamp}&` : ''}x-oss-process=${COVER_PROCESS}`;
  } catch (_) { return raw; }
}

function parseId(value, episode = false) {
  const parts = String(value || '').split(':');
  if (parts[0] !== 'hema' || parts.length !== (episode ? 3 : 2) || !parts.slice(1).every(part => ID.test(part))) {
    throw new Error('河马剧集编号无效');
  }
  return { bookId: parts[1], chapterId: parts[2], seriesId: parts.slice(0, 2).join(':') };
}

async function request(apiPath, body, options = {}) {
  const remaining = Number(options.deadline) > 0 ? options.deadline - Date.now() : 10000;
  if (remaining <= 0) throw new Error('河马加载超时，请重试');
  const timeout = Math.min(10000, remaining);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const requestOptions = {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: body ? 'application/json' : 'text/html',
      'Content-Type': 'application/json', pname: 'www.kuaikaw.cn', Origin: ORIGIN, Referer: `${ORIGIN}/` },
    timeout, signal: controller.signal, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024,
    responseType: body ? 'json' : 'text',
  };
  try {
    const response = body ? await axios.post(ORIGIN + apiPath, body, requestOptions) : await axios.get(ORIGIN + apiPath, requestOptions);
    return response.data;
  } catch (error) {
    throw new Error(controller.signal.aborted || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
      ? '河马加载超时，请重试' : '河马来源暂不可用，请稍后重试');
  } finally { clearTimeout(timer); }
}

function normalizeBooks(books) {
  const seen = new Set();
  const results = books.filter(item => item && ID.test(String(item.bookId || '')) && plainText(item.bookName))
    .map(item => ({ series_id: `hema:${item.bookId}`, series_title: plainText(item.bookName), cover: optimizeCover(item.coverWap),
      episode_count: Number(item.totalChapterNum) || 0,
      tags: Array.isArray(item.bookTypeThree) ? item.bookTypeThree.map(tag => plainText(tag?.name)).filter(Boolean).slice(0, 4) : [],
      source: 'hema', url: `${ORIGIN}/drama/${item.bookId}` }))
    .filter(item => { if (seen.has(item.series_id)) return false; seen.add(item.series_id); return true; });
  return results;
}

function pageData(html) {
  const match = typeof html === 'string' && html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  try {
    const data = JSON.parse(match?.[1]).props.pageProps;
    if (!data || typeof data !== 'object') throw new Error('invalid page');
    return data;
  } catch (_) { throw new Error('河马目录数据异常，请稍后重试'); }
}

function composeGenres(rawItems) {
  const used = new Set();
  const groups = [];
  for (const group of GENRE_GROUPS) {
    const ids = [];
    for (const item of rawItems) {
      if (!group.match.test(item.label)) continue;
      for (const id of String(item.slug).split('-')) {
        if (!ID.test(id) || used.has(id) || ids.includes(id)) continue;
        if (ids.length >= 16) break;
        ids.push(id);
      }
    }
    if (!ids.length) continue;
    ids.forEach(id => used.add(id));
    groups.push({ slug: ids.join('-'), label: group.label });
  }
  const leftovers = [];
  for (const item of rawItems) {
    for (const id of String(item.slug).split('-')) {
      if (!ID.test(id) || used.has(id) || leftovers.includes(id)) continue;
      if (leftovers.length >= 16) break;
      leftovers.push(id);
    }
  }
  if (leftovers.length) groups.push({ slug: leftovers.join('-'), label: '其他题材' });
  return groups;
}

async function fetchList(options = {}) {
  try {
    const { genre = '', page = 1, forceRefresh = false } = options || {};
    const pg = Number(page);
    const slug = String(genre || '0');
    if (!Number.isSafeInteger(pg) || pg < 1 || !/^\d{1,30}(?:-\d{1,30}){0,15}$/.test(slug)) {
      throw new Error('河马题材或页码无效，请重新选择');
    }
    let firstHtml;
    const refreshGenres = forceRefresh && pg === 1;
    const saved = refreshGenres || genreCache?.expires > Date.now() ? null : listCache.getAux('hema:genres');
    if (Array.isArray(saved) && saved.length && saved.every(item => typeof item?.slug === 'string' && typeof item.label === 'string')) {
      genreCache = { items: saved, expires: Date.now() + 300000 };
    }
    if (refreshGenres || !genreCache || genreCache.expires <= Date.now()) {
      directoryPending = directoryPending || request('/browse').finally(() => { directoryPending = undefined; });
      firstHtml = await directoryPending;
      const directory = pageData(firstHtml);
      if (!Array.isArray(directory.typeThreeList)) throw new Error('河马没有返回可用题材，请重试');
      const seen = new Set();
      const raw = directory.typeThreeList.filter(item => Array.isArray(item?.typeThreeIds)
        && item.typeThreeIds.length > 0 && item.typeThreeIds.length <= 16
        && item.typeThreeIds.every(id => ID.test(String(id))) && plainText(item.name))
        .map(item => ({ slug: item.typeThreeIds.map(String).join('-'), label: plainText(item.name) }))
        .filter(item => { if (item.slug === '0' || seen.has(item.slug)) return false; seen.add(item.slug); return true; });
      if (!raw.length) throw new Error('河马没有返回可用题材，请重试');
      const items = composeGenres(raw);
      if (!items.length) throw new Error('河马没有返回可用题材，请重试');
      genreCache = { items, expires: Date.now() + 300000 };
      listCache.setAux('hema:genres', items);
    }
    if (slug !== '0' && !genreCache.items.some(item => item.slug === slug)) throw new Error('河马题材无效，请重新选择');
    const apiPath = slug === '0' && pg === 1 ? '/browse' : `/browse/${slug}${pg > 1 ? `/${pg}` : ''}`;
    const html = apiPath === '/browse' && firstHtml ? firstHtml : await request(apiPath);
    const data = pageData(html);
    if (!Array.isArray(data.bookList) || Number(data.page) !== pg || String(data.typeThreeId || '0') !== slug) {
      throw new Error('河马返回的目录与请求不一致，请重试');
    }
    const results = normalizeBooks(data.bookList);
    const hasMore = results.length > 0 && new RegExp(`<a\\b[^>]*\\shref=["']/browse/${slug}/${pg + 1}["']`).test(html);
    return { success: true, results, page: pg, total: 0, totalPages: 0, hasMore,
      nextPage: hasMore ? pg + 1 : null, genres: genreCache.items,
      pageTitle: '河马短剧', sourceUrl: ORIGIN + apiPath };
  } catch (error) { return { success: false, error: error.message }; }
}

async function search(keyword, page = 1, options = {}) {
  try {
    const kw = String(keyword || '').trim();
    if (!kw) throw new Error('请输入搜索关键词');
    const pg = Math.max(1, Number.parseInt(page, 10) || 1);
    const response = await request('/seo/video/6007', { sourceType: 1, keyword: kw, index: pg }, options);
    if (response?.retCode !== 0 || !Array.isArray(response.data?.bookList)) throw new Error('河马搜索数据异常，请稍后重试');
    const data = response.data;
    const results = normalizeBooks(data.bookList);
    const hasMore = data.isMore === 1 && results.length > 0;
    return { success: true, results, page: pg, total: Number(data.totalSize) || 0, totalPages: 0,
      hasMore, nextPage: hasMore ? pg + 1 : null, genres: [], pageTitle: '河马短剧', sourceUrl: ORIGIN };
  } catch (error) { return { success: false, error: error.message }; }
}

async function detailFromWeb(seriesId) {
  const { bookId } = parseId(seriesId);
  const html = await request(`/drama/${bookId}`);
  const match = typeof html === 'string' && html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  let result;
  try { result = JSON.parse(match?.[1]).props.pageProps; }
  catch (_) { throw new Error('河马详情数据异常，请稍后重试'); }
  if (String(result?.bookInfoVo?.bookId) !== bookId || !Array.isArray(result?.chapterList)) {
    throw new Error('河马返回的剧集与请求不一致');
  }
  const seen = new Set();
  for (const episode of result.chapterList) {
    const id = String(episode?.chapterId || '');
    if (!ID.test(id) || seen.has(id) || (episode.bookId != null && String(episode.bookId) !== bookId)) {
      throw new Error('河马分集数据异常，请稍后重试');
    }
    seen.add(id);
  }
  return result;
}

async function fetchEpisodeList(seriesId) {
  const { bookId } = parseId(seriesId);
  let appData;
  try { appData = await hemaApp.fetchDetail(bookId); } catch (_) { appData = null; }
  if (appData && Array.isArray(appData.chapterList) && appData.chapterList.length) {
    const video = appData.videoInfo && typeof appData.videoInfo === 'object' ? appData.videoInfo : {};
    const series_title = plainText(video.bookName || appData.bookName) || '未命名短剧';
    const cover = optimizeCover(video.coverWap || video.cover || appData.coverWap || appData.cover);
    const episodes = appData.chapterList.map((episode, index) => {
      const chapterId = String(episode.chapterId || '');
      const charged = episode.isCharge !== 0 && episode.isCharge !== '0' && episode.isCharge != null;
      return {
        vid: `${seriesId}:${chapterId}`, vid_index: Number(episode.chapterIndex) || index + 1,
        title: plainText(episode.chapterName || `第${Number(episode.chapterIndex) || index + 1}集`),
        series_id: seriesId, series_title, cover,
        locked: false, source: 'hema',
        ...(charged ? { chargeHint: true } : {}),
      };
    }).filter(item => ID.test(item.vid.split(':')[2])).sort((a, b) => a.vid_index - b.vid_index);
    if (episodes.length) {
      return { series_id: seriesId, series_title, cover, total: episodes.length, episodes, source: 'hema' };
    }
  }
  const result = await detailFromWeb(seriesId);
  const series_title = plainText(result.bookInfoVo.bookName) || '未命名短剧';
  const cover = optimizeCover(result.bookInfoVo.coverWap);
  const episodes = result.chapterList.map((episode, index) => ({
    vid: `${seriesId}:${episode.chapterId}`, vid_index: Number(episode.chapterIndex) || index + 1,
    title: plainText(episode.chapterName), series_id: seriesId, series_title, cover,
    locked: false, source: 'hema',
  })).sort((a, b) => a.vid_index - b.vid_index);
  if (!episodes.length) throw new Error('河马分集列表为空');
  return { series_id: seriesId, series_title, cover, total: episodes.length, episodes, source: 'hema' };
}

async function fetchPlayUrlSingle(vid, sid, options = {}) {
  try {
    const id = parseId(vid, true);
    if (sid != null && sid !== '' && parseId(sid).seriesId !== id.seriesId) throw new Error('河马分集不属于当前剧集');
    let appError;
    try {
      const play = await hemaApp.fetchPlay(id.bookId, id.chapterId, options);
      if (play.url) return { url: play.url, spadeA: null, codec: '', source: 'hema', quality: play.quality || '720p' };
    } catch (error) { appError = error; }
    try {
      const detail = await hemaApp.fetchDetail(id.bookId, id.chapterId);
      const video = detail.videoInfo && typeof detail.videoInfo === 'object' ? detail.videoInfo : {};
      const fromDetail = hemaApp.pickPlayUrl(video) || hemaApp.pickPlayUrl(detail);
      if (fromDetail) return { url: fromDetail, spadeA: null, codec: '', source: 'hema', quality: '720p' };
    } catch (_) {}
    try {
      const result = await detailFromWeb(id.seriesId);
      const episode = result.chapterList.find(item => String(item.chapterId) === id.chapterId);
      if (!episode) throw new Error('河马未找到该分集');
      const playUrl = httpsUrl(episode.chapterVideoVo?.mp4720p) || httpsUrl(episode.chapterVideoVo?.mp4);
      if (playUrl) return { url: playUrl, spadeA: null, codec: '', source: 'hema', quality: '720p' };
      if (appError?.code === 'ERR_TLS_CERT') return { url: null, spadeA: null, codec: null, source: 'hema', error: appError.message };
    } catch (error) {
      if (appError?.code === 'ERR_TLS_CERT') return { url: null, spadeA: null, codec: null, source: 'hema', error: appError.message };
      if (!appError) return { url: null, spadeA: null, codec: null, source: 'hema', error: error.message };
    }
    return { url: null, spadeA: null, codec: null, source: 'hema', locked: true, error: LOCKED_HINT };
  } catch (error) { return { url: null, spadeA: null, codec: null, source: 'hema', error: error.message }; }
}

const browseList = listCache.wrap('hema', fetchList);

module.exports = { browseList, search, fetchEpisodeList, fetchPlayUrlSingle, composeGenres, optimizeCover };
