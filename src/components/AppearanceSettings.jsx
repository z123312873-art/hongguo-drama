import React, { useState, useSyncExternalStore } from 'react';
import { getThemePreference, setThemePreference } from '../theme';
import { getScriptPreference, setScriptPreference, subscribeScript } from '../scriptPreference.js';

export default function AppearanceSettings() {
  const [preference, setPreference] = useState(getThemePreference);
  const script = useSyncExternalStore(subscribeScript, getScriptPreference, getScriptPreference);
  const [error, setError] = useState('');

  const changeTheme = (event) => {
    try {
      setThemePreference(event.target.value);
      setPreference(event.target.value);
      setError('');
    } catch {
      setError('外观保存失败，请重试。');
    }
  };

  return (
    <div className="settings-group">
      <label className="settings-label" htmlFor="appearance-theme">外观</label>
      <select id="appearance-theme" className="input-field select-field" value={preference} onChange={changeTheme} aria-describedby="appearance-hint">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
      <p className="settings-hint" id="appearance-hint">立即生效并自动保存。跟随系统时，外观会随系统切换。</p>
      <label className="settings-label" htmlFor="appearance-script">界面语言</label>
      <select id="appearance-script" className="input-field select-field" value={script} aria-describedby="script-hint" onChange={(event) => {
        try {
          setScriptPreference(event.target.value);
          setError('');
        } catch {
          setError('语言保存失败，请重试。');
        }
      }}>
        <option value="hans">简体中文</option>
        <option value="hant">繁体中文</option>
      </select>
      <p className="settings-hint" id="script-hint">立即生效并自动保存。只改变显示文字，不改变搜索原文、文件名和更新。</p>
      {error && <p className="appearance-error" role="alert">{error}</p>}
    </div>
  );
}
