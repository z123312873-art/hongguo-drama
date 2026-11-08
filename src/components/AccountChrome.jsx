import React from 'react';
import { ACCOUNT_REGIONS, accountActionLabel, accountLabel } from '../accountProfile.mjs';

function Avatar({ status, onClick }) {
  const label = status.loggedIn ? '帐号头像' : '尚未登录';
  return (
    <button type="button" className="account-avatar" aria-label={label} disabled={!status.loggedIn} onClick={onClick}>
      {status.avatarUrl
        ? <img src={status.avatarUrl} alt="" />
        : <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M5 19c1.4-3 3.8-4.5 7-4.5S17.6 16 19 19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>}
    </button>
  );
}

export function AccountStrip({ status, onAvatar }) {
  const name = accountLabel(status);
  return (
    <div className="account-strip">
      <Avatar status={status} onClick={onAvatar} />
      <div className="account-name" title={name}>{name}</div>
    </div>
  );
}

export function AccountAccess({ status, confirming, onLogin, onLogout, onConfirm, onCancel }) {
  if (status.loggedIn && confirming) {
    return (
      <div className="account-confirm" role="group" aria-label="确认退出">
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
          <h2 id="account-dialog-title">红果登录</h2>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>关闭</button>
        </div>
        {draft.step === 'phone' ? (
          <div className="account-fields">
            <label className="account-field"><span>国家或地区</span>
              <select className="input-field" aria-label="国家或地区" autoFocus value={draft.countryCode} onChange={event => onCountry(event.target.value)}>
                {ACCOUNT_REGIONS.map(region => <option key={region.code} value={region.code}>{region.name} {region.code}</option>)}
              </select>
            </label>
            <label className="account-field"><span>手机号</span>
              <input className="input-field" aria-label="手机号" inputMode="numeric" autoComplete="tel" value={draft.phone} onChange={event => onPhone(event.target.value)} onKeyDown={onPhoneKey} />
            </label>
            <button type="button" className="btn btn-primary" disabled={draft.busy} onClick={onSend}>{draft.busy ? '发送中…' : '发送验证码'}</button>
          </div>
        ) : (
          <div className="account-fields">
            <label className="account-field"><span>验证码</span>
              <input className="input-field" aria-label="验证码" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={8} value={draft.code} onChange={event => onCode(event.target.value)} onKeyDown={onCodeKey} />
            </label>
            <button type="button" className="btn btn-primary" disabled={draft.busy} onClick={onSubmit}>{draft.busy ? '登录中…' : '登录'}</button>
            <div className="account-dialog-row">
              <button type="button" className="btn btn-outline" disabled={draft.busy || draft.retryAfter > 0} onClick={onSend}>{draft.retryAfter > 0 ? `重新发送 ${draft.retryAfter}` : '重新发送'}</button>
              <button type="button" className="btn btn-outline" disabled={draft.busy} onClick={onChangeNumber}>更换号码</button>
            </div>
          </div>
        )}
        {draft.error ? <div className="alert alert-error" role="alert">{draft.error}</div> : null}
      </div>
    </div>
  );
}
