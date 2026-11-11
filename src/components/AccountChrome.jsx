import React, { useState } from 'react';
import { toTraditional } from '../chineseScript.mjs';
import { ACCOUNT_REGIONS, accountActionLabel, accountLabel, avatarPicture, regionLabel } from '../accountProfile.mjs';

function Avatar({ status, onClick }) {
  const label = status.loggedIn ? '帳號頭像' : '尚未登入';

  const [failed, setFailed] = useState([]);
  const picture = avatarPicture(status, failed);
  return (
    <button type="button" className="account-avatar" aria-label={label} disabled={!status.loggedIn} onClick={onClick}>
      {picture
        ? <img src={picture} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(current => current.includes(picture) ? current : [...current, picture])} />
        : <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M5 19c1.4-3 3.8-4.5 7-4.5S17.6 16 19 19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>}
    </button>
  );
}

export function AccountStrip({ status, onAvatar }) {
  const name = accountLabel(status);

  const own = Boolean(status?.loggedIn && status.nickname);
  return (
    <div className={status?.loggedIn ? 'account-strip' : 'account-strip is-out'}>
      <Avatar status={status} onClick={onAvatar} />
      {own
        ? <div className="account-name" title={name} data-script="keep">{name}</div>
        : <div className="account-name" title={name}>{name}</div>}
    </div>
  );
}

export function AccountAccess({ status, confirming, onLogin, onLogout, onConfirm, onCancel }) {
  if (status.loggedIn && confirming) {
    return (
      <div className="account-confirm" role="group" aria-label="確認退出">
        <button type="button" className="btn btn-danger-solid account-login" onClick={onConfirm}>退出</button>
        <button type="button" className="btn btn-outline account-login" onClick={onCancel}>取消</button>
      </div>
    );
  }
  const label = accountActionLabel(status);
  return (
    <button type="button" className={`btn account-login ${status.loggedIn ? 'btn-outline' : 'btn-primary'}`} onClick={status.loggedIn ? onLogout : onLogin}>
      {label}
    </button>
  );
}

export function AccountDialog({ draft, onClose, onCountry, onPhone, onCode, onSend, onSubmit, onChangeNumber }) {
  const onPhoneKey = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); onSend(); }
  };
  const onCodeKey = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); onSubmit(); }
  };
  return (
    <div className="account-dialog-mask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
        <div className="account-dialog-head">
          <h2 id="account-dialog-title">紅果登入</h2>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>關閉</button>
        </div>
        {draft.step === 'phone' ? (
          <div className="account-fields">
            <label className="account-field"><span>國家或地區</span>
              <select className="input-field" aria-label="國家或地區" autoFocus value={draft.countryCode} onChange={event => onCountry(event.target.value)}>
                {ACCOUNT_REGIONS.map(region => <option key={region.code} value={region.code}>{regionLabel(region.name)} {region.code}</option>)}
              </select>
            </label>
            <label className="account-field"><span>手機號碼</span>
              <input className="input-field" aria-label="手機號碼" inputMode="numeric" autoComplete="tel" value={draft.phone} onChange={event => onPhone(event.target.value)} onKeyDown={onPhoneKey} />
            </label>
            <button type="button" className="btn btn-primary" disabled={draft.busy || draft.retryAfter > 0} onClick={onSend}>{draft.busy ? '傳送中…' : draft.retryAfter > 0 ? `稍後再試（${draft.retryAfter} 秒）` : '傳送驗證碼'}</button>
          </div>
        ) : (
          <div className="account-fields">
            <label className="account-field"><span>驗證碼</span>
              <input className="input-field" aria-label="驗證碼" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={8} aria-describedby="account-code-help" placeholder="4～8 位驗證碼" value={draft.code} onChange={event => onCode(event.target.value)} onKeyDown={onCodeKey} />
            </label>
            <p id="account-code-help" className="account-code-help">收到驗證碼後，即可登入。</p>
            <button type="button" className="btn btn-primary" disabled={draft.busy} onClick={onSubmit}>{draft.busy ? '登入中…' : '登入'}</button>
            <div className="account-dialog-row">
              <button type="button" className="btn btn-outline" disabled={draft.busy || draft.retryAfter > 0} onClick={onSend}>{draft.retryAfter > 0 ? `重新傳送（${draft.retryAfter} 秒）` : '重新傳送'}</button>
              <button type="button" className="btn btn-outline" disabled={draft.busy} onClick={onChangeNumber}>更換號碼</button>
            </div>
          </div>
        )}
        {draft.error ? <div className="alert alert-error" role="alert">{toTraditional(draft.error)}</div> : null}
      </div>
    </div>
  );
}
