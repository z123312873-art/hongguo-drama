/** In-memory per-episode positions for the current app session (not persisted to store). */

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

/**
 * @param {Map<string, number>} map
 * @param {string} seriesId
 * @param {number} vidIndex
 * @param {number|null|undefined} resumeAt explicit resume from caller
 * @param {number} currentIndex player current episode index
 * @param {() => number} currentPosition live element time for same episode
 */
export function resolveEpisodeSeekTarget(map, seriesId, vidIndex, resumeAt, currentIndex, currentPosition) {
  if (resumeAt != null && Number.isFinite(resumeAt)) return Math.max(0, resumeAt);
  if (vidIndex === currentIndex) return Math.max(0, currentPosition());
  const recalled = readSessionEpisodeTime(map, seriesId, vidIndex);
  if (recalled != null) return recalled;
  return 0;
}

export function mediaSeekableEnd(video) {
  if (!video) return 0;
  try {
    if (video.seekable?.length) {
      let end = 0;
      for (let i = 0; i < video.seekable.length; i++) end = Math.max(end, video.seekable.end(i));
      if (end > 0) return end;
    }
    if (video.buffered?.length) {
      let end = 0;
      for (let i = 0; i < video.buffered.length; i++) end = Math.max(end, video.buffered.end(i));
      if (end > 0) return end;
    }
  } catch (_) {}
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

export function clampSeekTarget(target, seekableEnd, duration) {
  const limitCandidates = [seekableEnd, duration].filter(v => Number.isFinite(v) && v > 0);
  const limit = limitCandidates.length ? Math.min(...limitCandidates) : Infinity;
  const next = Math.max(0, Math.min(limit, target));
  const blocked = Number.isFinite(limit) && limit !== Infinity && target > limit + 0.25;
  return { time: next, blocked, limit };
}

/** ±N second seeks: only cap forward jumps; backward stays relative to playhead (pipe can play past seekable ranges). */
export function clampRelativeSeek(currentTime, delta, seekableEnd, duration) {
  const from = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
  const target = from + delta;
  if (delta <= 0) return { time: Math.max(0, target), blocked: false, limit: null };
  return clampSeekTarget(target, seekableEnd, duration);
}

/**
 * Progressive / pipe MP4 can fire `ended` while duration metadata still reflects an early fragment (~10–20s).
 * Defer auto-next until the buffer tail and duration agree the episode actually finished.
 */
export function shouldDeferPlaybackEnd(video) {
  if (!video?.ended) return false;
  const t = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  let bufEnd = 0;
  try {
    if (video.buffered?.length) bufEnd = video.buffered.end(video.buffered.length - 1);
  } catch (_) {}
  const d = video.duration;
  if (Number.isFinite(d) && d > 0 && bufEnd > d + 0.5) return true;
  if (Number.isFinite(d) && d > 0 && t < d - 1.25) {
    if (bufEnd > d + 0.5) return true;
    if (bufEnd < d - 0.5) return true;
    return false;
  }
  if (bufEnd > t + 2 && (!Number.isFinite(d) || d <= 0 || t < d - 5)) return true;
  return false;
}
