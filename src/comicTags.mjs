export function sourceLabels(card) {
  return Array.isArray(card?.tags) ? [...new Set(card.tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))] : [];
}
export function sourceTagCounts(items) {
  const counts = new Map();
  for (const card of Array.isArray(items) ? items : []) for (const label of sourceLabels(card)) counts.set(label, (counts.get(label) || 0) + 1);
  return counts;
}
export function sourceMatchesTags(card, selected) {
  return (Array.isArray(selected) ? selected : []).every(label => sourceLabels(card).includes(label));
}
export function chooseSourceTag(selected, label, counts) {
  const current = (Array.isArray(selected) ? selected : []).filter(item => counts.has(item));
  if (!label || label === '全部' || current[0] === label) return [];
  return counts.has(label) ? [label] : current;
}
