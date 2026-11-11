import { useEffect, useRef } from 'react';
import { commentFillCount } from './danmakuModel.mjs';

const NUMERIC_ID = /^\d{6,30}$/;


export function planDanmakuWarmup({ enabled, timelineReady, seriesId, nextEpisodeId, warmed }) {
  if (!enabled || !timelineReady) return null;
  const series = String(seriesId || '');
  const episode = String(nextEpisodeId || '');
  if (!NUMERIC_ID.test(series) || !NUMERIC_ID.test(episode)) return null;
  const key = `${series}:${episode}`;
  if (warmed?.has(key)) return null;
  return { key, seriesId: series, episodeId: episode };
}

export function warmupCommentLimit(timeline) {
  if (timeline?.skipped === true) return 0;
  if (!timeline) return commentFillCount(0);
  const count = Array.isArray(timeline.items) ? timeline.items.length : 0;
  if (timeline.success === false && count === 0) return commentFillCount(0);
  return commentFillCount(count);
}

export function useDanmakuWarmup({ seriesId, nextEpisodeId, enabled, timelineReady }) {
  const warmed = useRef(new Set());
  useEffect(() => {
    const plan = planDanmakuWarmup({ enabled, timelineReady, seriesId, nextEpisodeId, warmed: warmed.current });
    if (!plan) return undefined;
    let cancelled = false;

    const startTimer = setTimeout(() => {
      if (cancelled) return;
      warmed.current.add(plan.key);

      window.electronAPI?.getEpisodeDanmaku?.({ seriesId: plan.seriesId, vid: plan.episodeId, prefetch: true })
        ?.then?.(timeline => {
          if (cancelled) return 0;
          return warmupCommentLimit(timeline);
        })
        ?.then?.(limit => {
          if (cancelled || !(limit > 0)) return undefined;
          return window.electronAPI?.getEpisodeComments?.({ seriesId: plan.seriesId, episodeId: plan.episodeId, cursor: null, limit });
        })
        ?.catch?.(() => {});
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
    };
  }, [seriesId, nextEpisodeId, enabled, timelineReady]);
}
