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

function availableRelease(data, currentVersion) {
  if (!data || data.draft || data.prerelease) return null;
  const next = versionParts(data.tag_name), current = versionParts(currentVersion);
  if (!next || !current) return null;
  const difference = next.findIndex((part, i) => part !== current[i]);
  if (difference < 0 || next[difference] < current[difference]) return null;
  return {
    version: data.tag_name.replace(/^v/, '').replace(/^(\d+\.\d+)\.0$/, '$1'),
    // Never open a remote-provided URL; only this project's release page.
    url: `${RELEASES_URL}/tag/${encodeURIComponent(data.tag_name)}`,
  };
}

module.exports = { availableRelease, UPDATE_OWNER, UPDATE_REPO, RELEASES_URL, LATEST_API, LATEST_PAGE, updateRedirectTag };
