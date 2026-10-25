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

const SUMMARY_LIMIT = 42;
const SHORT_LINE = 24;
const SUMMARY_MARK = /^(?:摘要|更新说明|更新說明|summary)\s*[:：]\s*(.*)$/i;

function releaseSummary(body) {
  const text = String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/`+/g, '');
  const lines = text.split('\n').map(line => line.replace(/^[#>*\-\d.\s]+/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const marked = lines.map(line => SUMMARY_MARK.exec(line)?.[1]?.trim()).find(value => value);
  const first = lines[0] || '';
  const candidate = marked || (Array.from(first).length <= SHORT_LINE && !/https?:|sha256|檔名|文件名|檔案|对应提交|對應提交/i.test(first) ? first : '');
  const clean = candidate.replace(SUMMARY_MARK, '$1').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || /https?:|sha256/i.test(clean)) return '';
  const chars = Array.from(clean);
  return chars.length <= SUMMARY_LIMIT ? clean : `${chars.slice(0, SUMMARY_LIMIT - 1).join('')}…`;
}

function availableRelease(data, currentVersion) {
  if (!data || data.draft || data.prerelease) return null;
  const next = versionParts(data.tag_name), current = versionParts(currentVersion);
  if (!next || !current) return null;
  const difference = next.findIndex((part, i) => part !== current[i]);
  if (difference < 0 || next[difference] < current[difference]) return null;
  const summary = releaseSummary(data.body);
  return {
    version: data.tag_name.replace(/^v/, '').replace(/^(\d+\.\d+)\.0$/, '$1'),
    // Never open a remote-provided URL; only this project's release page.
    url: `${RELEASES_URL}/tag/${encodeURIComponent(data.tag_name)}`,
    // Empty when the formal notes have no one-line summary. Installed 2.9 does not read this field.
    ...(summary ? { summary } : {}),
  };
}

module.exports = { availableRelease, releaseSummary, UPDATE_OWNER, UPDATE_REPO, RELEASES_URL, LATEST_API, LATEST_PAGE, updateRedirectTag };
