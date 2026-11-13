import React, { useEffect, useState } from 'react';
import { Film } from './icons';
import { coverCandidates } from '../coverFallback.mjs';

export const COVER_HEDGE_MS = 600;

export default function CoverImage({ src, alt = '', size = 22, eager = false }) {
  const candidates = coverCandidates(src);
  const key = candidates.join('|');
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState('');
  useEffect(() => { setAttempt(0); setShown(''); }, [key]);
  const current = candidates[attempt];
  const next = candidates[attempt + 1];
  useEffect(() => {
    if (!current || !next || shown === current || typeof Image === 'undefined' || typeof setTimeout !== 'function') return undefined;
    let probe = null;
    const timer = setTimeout(() => {
      probe = new Image();
      probe.onload = () => setAttempt(value => (candidates[value] === current ? value + 1 : value));
      probe.src = next;
    }, COVER_HEDGE_MS);
    return () => { clearTimeout(timer); if (probe) probe.onload = null; };
  }, [key, attempt, shown]);
  if (!current) return <div className="cover-placeholder"><Film size={size} /></div>;
  return <img key={current} src={current} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" {...(eager ? { fetchpriority: 'high' } : {})}
    onLoad={() => setShown(current)} onError={() => setAttempt(value => (candidates[value] === current ? value + 1 : value))} />;
}
