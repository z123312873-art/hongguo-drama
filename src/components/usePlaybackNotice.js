import { useEffect, useRef, useState } from 'react';
import { WAITING_DISMISS_MS } from '../waitingNotice.mjs';

export default function usePlaybackNotice() {
  const [notice, setNotice] = useState(null);
  const sequence = useRef(0);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), WAITING_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return { notice, showNotice: text => setNotice({ text, id: ++sequence.current }), clearNotice: () => setNotice(null) };
}
