import { useEffect, useRef, useState } from 'react';
import { initialLoginDraft, normalizeStatus, reduceLogin } from '../accountProfile.mjs';

async function refreshStatus() {
  try {
    const refresh = window.electronAPI?.accountRefresh;
    if (typeof refresh !== 'function') return null;
    const value = await refresh();
    // Only a real answer counts; an empty or malformed reply must not sign the sidebar out.
    return value && typeof value === 'object' && typeof value.loggedIn === 'boolean' ? normalizeStatus(value) : null;
  } catch {
    return null;
  }
}

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
  // Every sign-in or sign-out bumps this, so a slow profile read cannot bring back an older account.
  const sessionRef = useRef(0);

  // The profile read can miss right after sign-in (slow or offline). Ask once more; when there is
  // no session left in memory the saved name and picture stay as they are.
  const completeProfile = async (current) => {
    if (!current?.loggedIn || (current.nickname && current.avatarData)) return;
    const ticket = sessionRef.current;
    const next = await refreshStatus();
    if (!next || ticket !== sessionRef.current) return;
    setStatus(next);
  };

  useEffect(() => {
    let cancel = false;
    const ticket = sessionRef.current;
    readStatus().then(next => {
      if (cancel || ticket !== sessionRef.current) return;
      setStatus(next);
      completeProfile(next);
    });
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
    if (draftRef.current.busy) return;
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
      sessionRef.current += 1;
      const next = normalizeStatus(result.status);
      setStatus(next);
      setOpen(false);
      setConfirming(false);
      completeProfile(next);
    }
  };

  const logout = async () => {
    sessionRef.current += 1;
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
