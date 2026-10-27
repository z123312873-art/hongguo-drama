// Confirmed scores and confirmed blanks are remembered. A failed lookup stays pending so the next pass can retry.
export function applyPublicRatings(checkedAt, response, ids, now = Date.now()) {
  const pending = new Set((Array.isArray(response?.pending) ? response.pending : []).map(id => String(id)));
  const incoming = response?.ratings;
  const numeric = {};
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return numeric;
  for (const id of ids) {
    const key = String(id);
    if (pending.has(key) || !Object.hasOwn(incoming, key)) continue;
    checkedAt?.set(key, now);
    const score = Number(incoming[key]);
    numeric[key] = Number.isFinite(score) && score > 0 && score <= 10 ? Math.round(score * 10) / 10 : null;
  }
  return numeric;
}
