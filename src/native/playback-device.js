// SPDX-License-Identifier: GPL-3.0-only
// ttEncrypt and registration fields adapted from tsukiyo-zero/hongguoTV,
// commit 388931852ddc614db8b00775a3dc54c5ede6307f,
// kotlin-tv/core/src/main/kotlin/com/hongguotv/core/DeviceRegister.kt
// (itself adapted from charlie901208/HGTV feat/phone-login, GPL-3.0-only).
// Changes: fixed anonymous phone profile; process-only identity; no cookies or tokens.
const crypto = require('node:crypto');
const { gzipSync } = require('node:zlib');

const REGISTER_QUERY = 'tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
const REGISTER_HOSTS = ['log5-applog-lf.fqnovel.com', 'log5-applog-hl.fqnovel.com', 'log0-applog-lf.fqnovel.com'];
const REGISTER_URLS = REGISTER_HOSTS.map(host => `https://${host}/service/2/device_register/?${REGISTER_QUERY}`);
const KDF_SALT = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');
// A failed attempt registers nothing, so it is safe to try again once this window has passed.
// Within the window every caller (prefetch, repeated clicks) still shares the one failure.
const FAILURE_COOLDOWN_MS = 5000;
let registration;
let failedAt = 0;
let refreshing = null;

function responseId(response, name) {
    const preferred = response?.[`${name}_str`];
    const value = preferred === undefined || preferred === null || preferred === '' ? response?.[name] : preferred;
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    return typeof value === 'string' && /^\d{1,30}$/.test(value) && /[1-9]/.test(value) ? value : '';
}

function getPlaybackDevice(requestJson) {
    if (registration && failedAt && Date.now() - failedAt >= FAILURE_COOLDOWN_MS) { registration = null; failedAt = 0; }
    if (registration) return registration;
    failedAt = 0;
    const attempt = Promise.resolve().then(async () => {
        let reason = 'UNKNOWN';
        try {
            const now = Date.now();
            const cdid = crypto.randomUUID();
            const header = {
                display_name: '红果免费短剧', update_version_code: 73932, manifest_version_code: 73932,
                app_version_minor: '7.3.9.32', aid: 8662, channel: 'update_64', package: 'com.phoenix.read',
                app_version: '7.3.9.32', version_code: 73932, sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo',
                sdk_target_version: 29, git_hash: '3a88f4e', os: 'Android', os_version: '16', os_api: 36,
                device_model: '25053RT47C', device_brand: 'Redmi', device_manufacturer: 'Redmi',
                cpu_abi: 'arm64-v8a', release_build: 'b5e187f', density_dpi: 520, display_density: 'mdpi',
                resolution: '1280x2772', language: 'zh', timezone: 8, access: 'wifi', not_request_sender: 0,
                carrier: 'CHINA MOBILE', mcc_mnc: '46000', rom: 'eng.root.20231116.160340',
                rom_version: 'W528JS release-keys', cdid,
                sig_hash: '56a962410c494bbaf0b58dba20cae56f', openudid: crypto.randomBytes(8).toString('hex'),
                clientudid: crypto.randomUUID(), ipv6_list: [], region: 'CN', tz_name: 'Asia/Shanghai',
                tz_offset: 28800, sim_region: 'cn', sim_serial_number: [], oaid_may_support: false,
                req_id: crypto.randomUUID(), device_platform: 'android',
                custom: { account_region_src: 'fallback', account_region: 'cn', host_bit: 64, dragon_device_type: 'phone' }, pre_installed_channel: '',
                apk_first_install_time: now, is_system_app: 0, sdk_flavor: 'china', guest_mode: 0,
            };
            const compressed = gzipSync(Buffer.from(JSON.stringify({ magic_tag: 'ss_app_log', header, _gen_time: now })));
            const random = crypto.randomBytes(32);
            const derived = crypto.createHash('sha512').update(Buffer.concat([
                crypto.createHash('sha512').update(random).digest(), KDF_SALT,
            ])).digest();
            const cipher = crypto.createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32));
            const plaintext = Buffer.concat([crypto.createHash('sha512').update(compressed).digest(), compressed]);
            const data = Buffer.concat([Buffer.from('746305100000', 'hex'), random, cipher.update(plaintext), cipher.final()]);
            const headers = {
                'User-Agent': 'com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)',
                Accept: 'application/json', 'Content-Type': 'application/octet-stream;tt-data=a',
                'log-encode-type': 'gzip', 'x-ss-dp': '8662', 'x-ss-req-ticket': String(now),
                'x-vc-bdturing-sdk-version': '4.0.3.cn', lc: '101', 'sdk-version': '2',
                'passport-sdk-version': '5051452', 'x-neptune': '-8|50:51:59:30:40:47:49:39',
                'x-ss-stub': crypto.createHash('md5').update(data).digest('hex').toUpperCase(),
            };
            const deadline = Date.now() + 8000;
            let response = null;
            for (const url of REGISTER_URLS) {
                if (deadline <= Date.now()) break;
                try {
                    response = await requestJson(url, { method: 'POST', headers, data }, deadline, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
                    break;
                } catch (error) {
                    response = null;
                    if (String(error?.code || '') === 'ERR_TLS_CERT') reason = 'TLS';
                    else if (reason !== 'TLS') reason = 'NETWORK';
                }
            }
            const device_id = responseId(response, 'device_id');
            const iid = responseId(response, 'install_id');
            if (response) reason = 'REJECTED';
            if (!response || !device_id || !iid || Number(response?.code ?? response?.Code ?? 0) !== 0) throw new Error('Invalid registration');
            return Object.freeze({ device_id, iid, cdid });
        } catch (_) {
            if (registration === attempt) failedAt = Date.now();
            throw Object.assign(new Error('匿名播放设备注册失败，请重启应用后重试'), { code: 'DEVICE_REGISTRATION_FAILED', reason });
        }
    });
    registration = attempt;
    return attempt;
}

// The signed video API now answers an unregistered device with an empty 200.
// Drop a rejected or rejected-by-the-server identity so the next play can register once more.
function refreshPlaybackDevice(requestJson) {
    if (refreshing) return refreshing;
    registration = null;
    failedAt = 0;
    const run = getPlaybackDevice(requestJson);
    refreshing = run;
    // The caller handles `run`. This side chain only clears the single-flight slot.
    run.finally(() => { if (refreshing === run) refreshing = null; }).catch(() => {});
    return run;
}

// Network or proxy settings changed: a failure under the old route says nothing about the new one.
// A registration that is still running or already succeeded is kept.
function forgetFailedPlaybackDevice() {
    if (registration && failedAt) { registration = null; failedAt = 0; }
}

function resetPlaybackDevice() {
    registration = null;
    failedAt = 0;
    refreshing = null;
}

module.exports = { getPlaybackDevice, refreshPlaybackDevice, forgetFailedPlaybackDevice, resetPlaybackDevice };
