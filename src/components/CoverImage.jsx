import React, { useEffect, useState } from 'react';
import { Film } from './icons';
import { coverCandidates } from '../coverFallback.mjs';

export default function CoverImage({ src, alt = '', size = 22 }) {
  const candidates = coverCandidates(src);
  const key = candidates.join('|');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setAttempt(0); }, [key]);
  const current = candidates[attempt];
  if (!current) return <div className="cover-placeholder"><Film size={size} /></div>;
  return <img key={current} src={current} alt={alt} loading="lazy" onError={() => setAttempt(value => value + 1)} />;
}
