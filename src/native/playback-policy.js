const EPISODE_REQUEST_CAP = 15;

function boundedEpisodeIds(ids) {
  const list = [...(ids || [])].map(id => String(id || '').trim()).filter(Boolean);
  if (list.length > EPISODE_REQUEST_CAP) {
    const error = new Error(`一次最多请求 ${EPISODE_REQUEST_CAP} 集`);
    error.code = 'EPISODE_WINDOW';
    throw error;
  }
  return list;
}

function codecExhausted(error) {
  if (!error) return false;
  if (error.code === 'NO_COMPATIBLE_CODEC') return true;
  const sources = Array.isArray(error.sources) ? error.sources : [];
  return error.code === 'SOURCE_UNAVAILABLE' && sources.length > 0 && sources.every(item => item?.code === 'NO_PLAYABLE_SOURCE');
}

module.exports = { EPISODE_REQUEST_CAP, boundedEpisodeIds, codecExhausted };
