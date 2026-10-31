// 应用更新只看这个分叉仓库的正式版，不看 jackotom/hongguo-drama。
const UPDATE_OWNER = 'z123312873-art';
const UPDATE_REPO = 'hongguo-drama';
const RELEASES_URL = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`;
const LATEST_PAGE = `${RELEASES_URL}/latest`;

function updateRedirectTag(location) {
  const match = new RegExp(`^https://github\\.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/tag/(v?\\d+\\.\\d+(?:\\.\\d+)?)$`).exec(String(location || ''));
  return match ? match[1] : null;
}

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value || ''));
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

const HIGHLIGHT_LIMIT = 20;
const HIGHLIGHT_LENGTH = 72;
const SUMMARY_HEAD = /^(?:摘要|更新说明|更新說明|更新内容|更新內容|summary)(?:\s*[:：]\s*(.*)|)$/i;
const BULLET = /^(?:[-*+・•●▪◦]\s+|\d{1,2}(?:[.)]\s+|[、）]\s*)|[（(]\d{1,2}[)）]\s*)(.+)$/;
// A heading after the summary that introduces file lists or checksums ends the list.
const STOP_HEADING = /sha-?256|checksum|校验|校驗|下载|下載|download|assets|安装包|安裝包|文件|檔案|完整性|source/i;

function clipHighlight(value) {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || /https?:|sha-?256/i.test(clean)) return '';
  const chars = Array.from(clean);
  return chars.length <= HIGHLIGHT_LENGTH ? clean : `${chars.slice(0, HIGHLIGHT_LENGTH - 1).join('')}…`;
}

function plainText(body) {
  return String(body || '')
    .replace(/\r\n?/g, '\n')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '');
}

// Formal notes use a "摘要：" header followed by a bullet list. Items are not capped by the
// old four-line limit: the popup scrolls and `more` reports what did not fit. A single
// sentence is not shown. Installed 3.4/4.0 read only the first four short bullets.
function releaseSummary(body) {
  const items = [];
  let more = 0, capture = false, stop = false;
  const push = value => {
    const clipped = clipHighlight(value);
    if (!clipped || items.includes(clipped)) return;
    if (items.length >= HIGHLIGHT_LIMIT) more++; else items.push(clipped);
  };
  for (const raw of plainText(body).split('\n')) {
    if (stop) break;
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const text = (heading ? heading[1] : line).replace(/^[>\s]+/, '').trim();
    const head = !BULLET.test(line) && SUMMARY_HEAD.exec(text);
    if (head) {
      capture = true;
      const parts = (head[1] || '').split('、').map(part => part.trim()).filter(Boolean);
      if (parts.length > 1) parts.forEach(push);
      continue;
    }
    if (!capture) continue;
    const bullet = BULLET.exec(line);
    if (bullet) { push(bullet[1]); continue; }
    if (heading) {
      if (STOP_HEADING.test(text)) stop = true;
      continue;
    }
    if (/^[^\s:：]{1,16}[:：]$/.test(line)) { if (STOP_HEADING.test(line)) stop = true; continue; }
    stop = true;
  }
  return { items, more };
}

function releaseHighlights(body) {
  return releaseSummary(body).items;
}

function availableRelease(data, currentVersion) {
  if (!data || data.draft || data.prerelease) return null;
  const next = versionParts(data.tag_name), current = versionParts(currentVersion);
  if (!next || !current) return null;
  const difference = next.findIndex((part, i) => part !== current[i]);
  if (difference < 0 || next[difference] < current[difference]) return null;
  const { items: highlights, more } = releaseSummary(data.body);
  return {
    version: data.tag_name.replace(/^v/, '').replace(/^(\d+\.\d+)\.0$/, '$1'),
    // Never open a remote-provided URL; only this project's release page.
    url: `${RELEASES_URL}/tag/${encodeURIComponent(data.tag_name)}`,
    ...(highlights.length ? { highlights } : {}),
    ...(highlights.length && more ? { moreCount: more } : {}),
  };
}

module.exports = { availableRelease, releaseHighlights, releaseSummary, HIGHLIGHT_LIMIT, UPDATE_OWNER, UPDATE_REPO, RELEASES_URL, LATEST_API, LATEST_PAGE, updateRedirectTag };
