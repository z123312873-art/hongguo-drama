const DOWNLOAD_QUALITIES = ['auto', '1080p', '720p'];

function normalizeDownloadQuality(value = 'auto') {
  if (!DOWNLOAD_QUALITIES.includes(value)) throw new Error('下载清晰度无效，请选择自动、1080p 或 720p');
  return value;
}

function meetsDownloadQuality({ width, height } = {}, quality = 'auto') {
  quality = normalizeDownloadQuality(quality);
  if (quality === 'auto') return true;
  const dimensions = [Number(width), Number(height)];
  return dimensions.every(value => Number.isFinite(value) && value > 0)
    && Math.min(...dimensions) >= Number.parseInt(quality, 10);
}

// The short side decides the tier. A 1280×720 file labeled 1080p is 720p.
function measuredDownloadQuality(width, height) {
  const dimensions = [Number(width), Number(height)];
  if (!dimensions.every(value => Number.isFinite(value) && value > 0)) return 'auto';
  const shortSide = Math.min(...dimensions);
  if (shortSide >= 1080) return '1080p';
  if (shortSide >= 720) return '720p';
  return 'auto';
}

module.exports = { normalizeDownloadQuality, meetsDownloadQuality, measuredDownloadQuality };
