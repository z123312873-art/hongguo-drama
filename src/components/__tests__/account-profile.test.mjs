import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  ACCOUNT_REGIONS, DEFAULT_REGION, SESSION_MS, acceptLogin, accountActionLabel, accountLabel, regionLabel,
  initialLoginDraft, normalizeCode, preparePhone, publicAccount, reduceLogin, sessionStatus,
} from '../../accountProfile.mjs';
import { createAccountHandlers, finishLogin, sendLoginCode } from '../../accountLogin.mjs';
import { WAITING_DISMISS_MS, WAITING_NOTICE, isWaitingNotice, noticeAfterDelay, noticeAfterNavigate } from '../../waitingNotice.mjs';

const require = createRequire(import.meta.url);
const store = require('../../store.js');
const NOW = Date.parse('2026-11-09T00:00:00+08:00');

assert.equal(ACCOUNT_REGIONS.length, 14);
assert.equal(DEFAULT_REGION, '+886');
assert.equal(ACCOUNT_REGIONS[0].code, '+886');
assert.deepEqual(ACCOUNT_REGIONS.slice(0, 4).map(region => region.name), ['台湾', '大陆', '香港', '澳门']);
assert.ok(ACCOUNT_REGIONS.every(region => !region.name.startsWith('中国')));
assert.equal(regionLabel('中国台湾'), '台湾');
assert.equal(regionLabel('马来西亚'), '马来西亚');
assert.equal(new Set(ACCOUNT_REGIONS.map(region => region.code)).size, 14);

const missing = preparePhone('', '13912345678');
assert.equal(missing.ok, false);
assert.equal(missing.error, '请选择国家或地区');
assert.equal(missing.countryCode, undefined);

assert.equal(preparePhone('+886', '912345678').ok, true);
assert.equal(preparePhone('+886', '0912345678').ok, true);
assert.equal(preparePhone('+886', '91234567').ok, false);
assert.equal(preparePhone('+886', '91234567890').ok, false);
assert.equal(preparePhone('+86', '13912345678').ok, true);
assert.equal(preparePhone('+86', '12345678901').error, '请检查手机号');
assert.equal(preparePhone('+62', '8123456789012').ok, true);
assert.equal(preparePhone('+62', '81234567890123').ok, false);
assert.equal(preparePhone('+886', ' 912-345-678 ').phone, '912345678');

assert.deepEqual(normalizeCode('0740'), { text: '0740', ready: true });
assert.equal(normalizeCode('074').ready, false);
assert.equal(normalizeCode('123456789').text, '12345678');
assert.equal(normalizeCode('12ab30').text, '1230');

let draft = reduceLogin(initialLoginDraft(), { type: 'set-country', countryCode: '' });
assert.equal(draft.countryCode, '+886');
assert.equal(draft.error, '请选择国家或地区');
draft = reduceLogin(draft, { type: 'set-phone', phone: '9123a45678' });
assert.equal(draft.phone, '912345678');
draft = reduceLogin(draft, { type: 'set-code', code: '0740' });
assert.equal(draft.step, 'phone');
assert.equal(draft.code, '0740');
const blocked = reduceLogin(draft, { type: 'submit' });
assert.equal(blocked.busy, false);
draft = reduceLogin(draft, { type: 'send' });
assert.equal(draft.busy, true);
draft = reduceLogin(draft, { type: 'sent', result: { ok: true } });
assert.equal(draft.step, 'code');
assert.equal(draft.code, '');
assert.equal(draft.retryAfter, 60);
draft = reduceLogin(draft, { type: 'set-code', code: '074' });
const shortCode = reduceLogin(draft, { type: 'submit' });
assert.equal(shortCode.busy, false);
assert.match(shortCode.error, /4 到 8/);
draft = reduceLogin(draft, { type: 'set-code', code: '0740' });
assert.equal(reduceLogin(draft, { type: 'submit' }).busy, true);
draft = reduceLogin(draft, { type: 'change-number' });
assert.equal(draft.step, 'phone');
assert.equal(draft.code, '');
assert.equal(draft.retryAfter, 0);
assert.equal(reduceLogin({ ...initialLoginDraft(), step: 'code', retryAfter: 5 }, { type: 'send' }).busy, false);

const kept = acceptLogin({
  userId: '42', nickname: '甲', avatarUrl: 'https://example.com/a.jpg', phone: '912345678', code: '0740',
}, NOW);
assert.deepEqual(Object.keys(kept.record).sort(), ['avatarUrl', 'loggedInAt', 'nickname', 'userId']);
assert.equal(kept.record.phone, undefined);
assert.equal(acceptLogin({ userId: '0', nickname: '甲' }, NOW).ok, false);
assert.equal(acceptLogin({ nickname: '甲' }, NOW).ok, false);

assert.equal(sessionStatus({ nickname: '甲', loggedInAt: NOW }, NOW).loggedIn, false);
assert.equal(sessionStatus({ userId: '42', nickname: '甲', avatarUrl: 'http://example.com/a.jpg', loggedInAt: NOW }, NOW).avatarUrl, '');
assert.equal(sessionStatus({ userId: '42', nickname: '甲', avatarUrl: 'https://example.com/mosaic-legacy/a.png', loggedInAt: NOW }, NOW).avatarUrl, '');
assert.equal(sessionStatus({ userId: '42', loggedInAt: NOW }, NOW + SESSION_MS - 1).loggedIn, true);
assert.equal(sessionStatus({ userId: '42', loggedInAt: NOW }, NOW + SESSION_MS).expired, true);
assert.equal(sessionStatus({ userId: '42', loggedInAt: NOW + 10 * 60 * 1000 }, NOW).loggedIn, false);
assert.equal(sessionStatus({ userId: '42', loggedInAt: NOW + 60 * 1000 }, NOW).loggedIn, true);
assert.equal(publicAccount(kept.record, NOW).userId, undefined);
assert.equal(accountLabel({ loggedIn: false }), '尚未登录');
assert.equal(accountLabel({ loggedIn: true, nickname: '' }), '已登录');
assert.equal(accountActionLabel({ loggedIn: true }), '帐号登出');

const calls = [];
assert.equal((await sendLoginCode({ countryCode: '+886', phone: '912345678' })).ok, false);
const sent = await sendLoginCode({ countryCode: '+886', phone: '912345678' }, async (input) => {
  calls.push(input);
  return { ok: true, retryAfter: 15 };
});
assert.equal(sent.retryAfter, 15);
assert.equal(calls[0].phone, '912345678');
const finished = await finishLogin({ countryCode: '+886', phone: '912345678', code: '0740' }, async (input) => {
  assert.equal(input.code, '0740');
  return { ok: true, userId: '42', nickname: '甲', avatarUrl: 'https://example.com/a.jpg', phone: input.phone };
}, NOW);
assert.equal(finished.record.userId, '42');

const memory = { record: null };
let clock = NOW;
const handlers = createAccountHandlers({
  getAccount: () => memory.record,
  saveAccount: (record) => { memory.record = record; },
  now: () => clock,
  sendTransport: async () => ({ ok: true, retryAfter: 15 }),
  loginTransport: async () => ({ ok: true, userId: '42', nickname: '甲', avatarUrl: 'https://example.com/a.jpg', phone: '912345678' }),
});
const logged = await handlers.login({ countryCode: '+886', phone: '912345678', code: '0740' });
assert.equal(logged.status.loggedIn, true);
assert.equal(logged.status.userId, undefined);
assert.equal(memory.record.phone, undefined);
clock = NOW + SESSION_MS;
assert.deepEqual(await handlers.status(), { loggedIn: false });
assert.equal(memory.record, null);

const dir = mkdtempSync(join(tmpdir(), 'account-store-'));
const file = join(dir, 'store.json');
writeFileSync(file, '{}');
store.init(file);
store.saveSettings({ download_quality: '720' });
store.saveAccount({ ...kept.record, phone: '912345678', token: 'secret' });
store.saveSettings({ download_quality: '1080' });
assert.equal(store.getAccount().userId, '42');
assert.equal(store.getAccount().phone, undefined);
assert.equal(store.getAccount().token, undefined);
assert.equal(store.getSettings().download_quality, '1080');
const persisted = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(persisted.account.phone, undefined);
store.saveAccount(null);
assert.equal(store.getAccount(), null);

const broken = join(dir, 'broken.json');
writeFileSync(broken, JSON.stringify({ settings: { download_quality: '720' }, account: ['nope'], tasks: [] }));
store.init(broken);
assert.equal(store.getAccount(), null);
assert.equal(store.getSettings().download_quality, '720');

assert.match(readFileSync(new URL('../ReleaseCalendar.jsx', import.meta.url), 'utf8'), new RegExp(WAITING_NOTICE));
assert.equal(WAITING_DISMISS_MS, 2000);
assert.equal(isWaitingNotice(WAITING_NOTICE), true);
assert.equal(noticeAfterNavigate(WAITING_NOTICE), '');
assert.equal(noticeAfterDelay(WAITING_NOTICE), '');
const disk = '保存失败，请检查磁盘空间或目录权限；本次变更未能保存。';
assert.equal(noticeAfterNavigate(disk), disk);
assert.equal(noticeAfterDelay(disk), disk);
assert.equal(noticeAfterNavigate('置顶切换失败，请重试。'), '置顶切换失败，请重试。');

console.log('PASS account profile, local session, and waiting notice');
