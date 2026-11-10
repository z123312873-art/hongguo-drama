export function formatPublicScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 10) return '';
  return (Math.round(number * 10) / 10).toFixed(1);
}
