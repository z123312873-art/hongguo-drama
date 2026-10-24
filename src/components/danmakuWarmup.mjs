import { useEffect, useRef } from 'react';

const NUMERIC_ID = /^\d{6,30}$/;

// 当前集的时间轴落地之后，才预载下一集。无效编号、未播放、或这一集已经预载过，都不发请求。
export function planDanmakuWarmup({ enabled, timelineReady, seriesId, nextEpisodeId, warmed }) {
  if (!enabled || !timelineReady) return null;
  const series = String(seriesId || '');
  const episode = String(nextEpisodeId || '');
  if (!NUMERIC_ID.test(series) || !NUMERIC_ID.test(episode)) return null;
  const key = `${series}:${episode}`;
  if (warmed?.has(key)) return null;
  return { key, seriesId: series, episodeId: episode };
}

export function useDanmakuWarmup({ seriesId, nextEpisodeId, enabled, timelineReady }) {
  const warmed = useRef(new Set());
  useEffect(() => {
    const plan = planDanmakuWarmup({ enabled, timelineReady, seriesId, nextEpisodeId, warmed: warmed.current });
    if (!plan) return undefined;
    let cancelled = false;
    let timelineTimer = 0;
    // 当前集刚读完，先等一下再碰下一集，避免和这一集的收尾请求叠在一起。
    const startTimer = setTimeout(() => {
      if (cancelled) return;
      warmed.current.add(plan.key);
      window.electronAPI?.getEpisodeComments?.({ seriesId: plan.seriesId, episodeId: plan.episodeId, cursor: null, limit: 30 })?.catch?.(() => {});
      timelineTimer = setTimeout(() => {
        if (cancelled) return;
        window.electronAPI?.getEpisodeDanmaku?.({ seriesId: plan.seriesId, vid: plan.episodeId, prefetch: true })?.catch?.(() => {});
      }, 800);
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      clearTimeout(timelineTimer);
    };
  }, [seriesId, nextEpisodeId, enabled, timelineReady]);
}
