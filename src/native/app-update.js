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

const HIGHLIGHT_LIMIT = 4;
const HIGHLIGHT_LENGTH = 24;
const SUMMARY_HEAD = /^(?:摘要|更新说明|更新說明|summary)\s*[:：]\s*(.*)$/i;
const BULLET = /^[-*・•]\s+(.+)$/;

function clipHighlight(value) {
  const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || /https?:|sha256/i.test(clean)) return '';
  const chars = Array.from(clean);
  return chars.length <= HIGHLIGHT_LENGTH ? clean : `${chars.slice(0, HIGHLIGHT_LENGTH - 1).join('')}…`;
}

// Formal notes from 3.3 onward use a short bullet list. A single sentence is not shown.
// Installed 2.9 does not read this field and only shows that a newer version exists.
function releaseHighlights(body) {
  const text = String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/`+/g, '');
  const items = [];
  let capture = false;
  const push = value => {
    const clipped = clipHighlight(value);
    if (!clipped || items.includes(clipped) || items.length >= HIGHLIGHT_LIMIT) return;
    items.push(clipped);
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = SUMMARY_HEAD.exec(line.replace(/^[#>\s]+/, ''));
    if (head) {
      capture = true;
      const parts = head[1].split('、').map(part => part.trim()).filter(Boolean);
      if (parts.length > 1) parts.forEach(push);
      continue;
    }
    if (!capture) continue;
    const bullet = BULLET.exec(line);
    if (!bullet) break;
    push(bullet[1]);
  }
  return items;
}

function availableRelease(data, currentVersion) {
  if (!data || data.draft || data.prerelease) return null;
  const next = versionParts(data.tag_name), current = versionParts(currentVersion);
  if (!next || !current) return null;
  const difference = next.findIndex((part, i) => part !== current[i]);
  if (difference < 0 || next[difference] < current[difference]) return null;
  const highlights = releaseHighlights(data.body);
  return {
    version: data.tag_name.replace(/^v/, '').replace(/^(\d+\.\d+)\.0$/, '$1'),
    // Never open a remote-provided URL; only this project's release page.
    url: `${RELEASES_URL}/tag/${encodeURIComponent(data.tag_name)}`,
    ...(highlights.length ? { highlights } : {}),
  };
}

module.exports = { availableRelease, releaseHighlights, UPDATE_OWNER, UPDATE_REPO, RELEASES_URL, LATEST_API, LATEST_PAGE, updateRedirectTag };
