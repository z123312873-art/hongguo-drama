

export function sessionEpisodeKey(seriesId, vidIndex) {
  return `${String(seriesId)}:${Number(vidIndex)}`;
}

export function readSessionEpisodeTime(map, seriesId, vidIndex) {
  if (!map || !seriesId || !Number.isInteger(vidIndex) || vidIndex < 1) return null;
  const value = map.get(sessionEpisodeKey(seriesId, vidIndex));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function writeSessionEpisodeTime(map, seriesId, vidIndex, seconds) {
  if (!map || !seriesId || !Number.isInteger(vidIndex) || vidIndex < 1) return;
  if (!Number.isFinite(seconds) || seconds < 0) return;
  map.set(sessionEpisodeKey(seriesId, vidIndex), seconds);
}









export function resolveEpisodeSeekTarget(map, seriesId, vidIndex, resumeAt, currentIndex, currentPosition) {
  if (resumeAt != null && Number.isFinite(resumeAt)) return Math.max(0, resumeAt);
  if (vidIndex === currentIndex) return Math.max(0, currentPosition());
  const recalled = readSessionEpisodeTime(map, seriesId, vidIndex);
  if (recalled != null) return recalled;
  return 0;
}
