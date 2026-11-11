const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const code = buildSync({ stdin: { contents: "export { AccountDialog, AccountStrip } from './src/components/AccountChrome.jsx';", resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] }).outputFiles[0].text;
const loaded = new Module(path.join(root, 'account-language-check.cjs'), module);
loaded.filename = path.join(root, 'account-language-check.cjs');
loaded.paths = Module._nodeModulePaths(root);
loaded._compile(code, loaded.filename);
const { AccountDialog, AccountStrip } = loaded.exports;
const base = { step: 'phone', countryCode: '+886', phone: '912345678', code: '', busy: false, retryAfter: 0, error: '' };
const states = [base, { ...base, busy: true }, { ...base, retryAfter: 60 }, { ...base, error: '验证码发送失败，请稍后重试' }, ...['0123', '012345', '01234567'].map(code => ({ ...base, step: 'code', code })), { ...base, step: 'code', busy: true }, { ...base, step: 'code', retryAfter: 60 }, { ...base, step: 'code', error: '登录没有完成，请重试' }];
for (const draft of states) {
  const html = renderToStaticMarkup(React.createElement(AccountDialog, { draft }));
  assert.doesNotMatch(html, /[发证码录国号换关]/);
  assert.match(html, /紅果登入/);
  assert.match(html, /關閉/);
  if (draft.step === 'phone') assert.match(html, /國家或地區[\s\S]*臺灣[\s\S]*手機號碼/);
  else {
    assert.match(html, /驗證碼[\s\S]*重新傳送[\s\S]*更換號碼/);
    assert.match(html, /maxLength="8"/i);
    assert.match(html, /class="account-code-help">收到驗證碼後，即可登入。/);
    assert.doesNotMatch(html, /請輸入簡訊中的完整驗證碼|等候倒數結束再重試/);
    if (draft.code) assert.ok(html.includes('value="' + draft.code + '"'));
  }
}
const nickname = '用户测试';
const strip = renderToStaticMarkup(React.createElement(AccountStrip, { status: { loggedIn: true, nickname } }));
assert.ok(strip.includes(nickname));
assert.match(strip, /data-script="keep"/);
console.log('PASS account language: phone, code, busy, resend, countdown, dynamic errors, leading zeroes and original nicknames');
