import { useEffect, useRef, useState } from 'react';
import { initialLoginDraft, normalizeStatus, reduceLogin } from '../accountProfile.mjs';

async function readStatus() {
  try {
    const value = await window.electronAPI?.accountStatus?.();
    return normalizeStatus(value);
  } catch {
    return { loggedIn: false };
  }
}

export default function useAccountSession() {
  const [status, setStatus] = useState({ loggedIn: false });
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(initialLoginDraft);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    let cancel = false;
    readStatus().then(next => { if (!cancel) setStatus(next); });
    return () => { cancel = true; };
  }, []);

  useEffect(() => {
    if (!open || draft.retryAfter <= 0) return undefined;
    const timer = setTimeout(() => setDraft(current => reduceLogin(current, { type: 'tick' })), 1000);
    return () => clearTimeout(timer);
  }, [open, draft.retryAfter]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      const next = initialLoginDraft();
      draftRef.current = next;
      setDraft(next);
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const send = async () => {
    const snapshot = reduceLogin(draftRef.current, { type: 'send' });
    draftRef.current = snapshot;
    setDraft(snapshot);
    if (!snapshot.busy) return;
    let result = { ok: false, error: '验证码暂时无法发送，请稍后再试' };
    try {
      result = await window.electronAPI.accountSendCode({ countryCode: snapshot.countryCode, phone: snapshot.phone });
    } catch {
      result = { ok: false, error: '验证码暂时无法发送，请稍后再试' };
    }
    setDraft(current => {
      const next = reduceLogin(current, { type: 'sent', result });
      draftRef.current = next;
      return next;
    });
  };

  const submit = async () => {
    const snapshot = reduceLogin(draftRef.current, { type: 'submit' });
    draftRef.current = snapshot;
    setDraft(snapshot);
    if (!snapshot.busy) return;
    let result = { ok: false, error: '登录没有完成，请重试' };
    try {
      result = await window.electronAPI.accountLogin({
        countryCode: snapshot.countryCode,
        phone: snapshot.phone,
        code: snapshot.code,
      });
    } catch {
      result = { ok: false, error: '登录没有完成，请重试' };
    }
    setDraft(current => {
      const next = reduceLogin(current, { type: 'finished', result });
      draftRef.current = next;
      return next;
    });
    if (result?.ok) {
      setStatus(normalizeStatus(result.status));
      setOpen(false);
      setConfirming(false);
    }
  };

  const logout = async () => {
    try { await window.electronAPI?.accountLogout?.(); } catch { /* reread the saved state */ }
    setStatus(await readStatus());
    setConfirming(false);
    setOpen(false);
  };

  return {
    status,
    open,
    confirming,
    draft,
    startLogin: () => { setConfirming(false); setOpen(true); },
    closeLogin: () => {
      const next = initialLoginDraft();
      draftRef.current = next;
      setDraft(next);
      setOpen(false);
    },
    startLogout: () => setConfirming(true),
    cancelLogout: () => setConfirming(false),
    logout,
    setCountry: (countryCode) => setDraft(current => {
      const next = reduceLogin(current, { type: 'set-country', countryCode });
      draftRef.current = next;
      return next;
    }),
    setPhone: (phone) => setDraft(current => {
      const next = reduceLogin(current, { type: 'set-phone', phone });
      draftRef.current = next;
      return next;
    }),
    setCode: (code) => setDraft(current => {
      const next = reduceLogin(current, { type: 'set-code', code });
      draftRef.current = next;
      return next;
    }),
    send,
    submit,
    changeNumber: () => setDraft(current => {
      const next = reduceLogin(current, { type: 'change-number' });
      draftRef.current = next;
      return next;
    }),
  };
}
