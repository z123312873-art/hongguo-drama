// Continuous scale for interior metrics on wide windows. The default 1100px window stays at 1.
// 1280 sits above that window, so unmaximized use does not move.
// Callers must not use this to shrink or zoom the window box.
const BASIS = 1280;
const SPAN = 12800;
const MAX = 1.2;

export function uiScale(width) {
  const cssWidth = Number(width);
  if (!Number.isFinite(cssWidth) || cssWidth <= BASIS) return 1;
  const scaled = 1 + (cssWidth - BASIS) / SPAN;
  return Math.round(Math.min(MAX, scaled) * 1000) / 1000;
}

export function bindUiScale(target = globalThis) {
  const apply = () => {
    const scale = uiScale(target.innerWidth);
    target.document?.documentElement?.style.setProperty('--ui-scale', String(scale));
  };
  apply();
  target.addEventListener?.('resize', apply);
  return () => target.removeEventListener?.('resize', apply);
}
