import React, { useEffect, useState } from 'react';
import { Check, AlertCircle, X } from './icons';
import './ActionNotice.css';

export default function ActionNotice({ message, error = false, expiresAt }) {
  const [visible, setVisible] = useState(() => !expiresAt || expiresAt > Date.now());
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), expiresAt ? Math.max(0, expiresAt - Date.now()) : error ? 7000 : 3200);
    return () => clearTimeout(timer);
  }, [message, error, expiresAt]);
  if (!message || !visible) return null;
  const Icon = error ? AlertCircle : Check;
  return <div className={`action-notice${error ? ' action-notice-error' : ''}`} role={error ? 'alert' : 'status'} aria-atomic="true">
    <Icon size={18} aria-hidden="true" />
    <span>{message}</span>
    <button type="button" aria-label="關閉提示" onClick={() => setVisible(false)}><X size={16} /></button>
  </div>;
}
