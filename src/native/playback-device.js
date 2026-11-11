





const crypto = require('node:crypto');
const { gzipSync } = require('node:zlib');

const REGISTER_QUERY = 'tt_data=a&cronet_version=8d40f833_2026-03-03&ttnet_version=4.2.243.31-douyin&use_store_region_cookie=1';
const REGISTER_HOSTS = ['log5-applog-lf.fqnovel.com', 'log5-applog-hl.fqnovel.com', 'log0-applog-lf.fqnovel.com', 'log3-applog.fqnovel.com', 'log.snssdk.com'];
const registerUrls = hosts => hosts.map(host => `https://${host}/service/2/device_register/?${REGISTER_QUERY}`);
const REGISTER_URLS = registerUrls(REGISTER_HOSTS);
const KDF_SALT = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex');


const FAILURE_COOLDOWN_MS = 5000;
const REGISTER_ATTEMPT_MS = 3500;

const HONGGUO_PROFILE = Object.freeze({
    displayName: '红果免费短剧', version: 73932, versionName: '7.3.9.32', aid: 8662, packageName: 'com.phoenix.read',
    userAgent: 'com.phoenix.read/72232 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)',
});
const READER_PROFILE = Object.freeze({
    displayName: '番茄免费小说', version: 74332, versionName: '7.4.3.32', aid: 1967, packageName: 'com.dragon.read',
    userAgent: 'com.dragon.read/74332 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3)',
});
let registration;
let failedAt = 0;
let refreshing = null;

function responseId(response, name) {
    const preferred = response?.[`${name}_str`];
    const value = preferred === undefined || preferred === null || preferred === '' ? response?.[name] : preferred;
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    return typeof value === 'string' && /^\d{1,30}$/.test(value) && /[1-9]/.test(value) ? value : '';
}


async function registerDevice(requestJson, profile = HONGGUO_PROFILE, options = {}) {
    let reason = 'UNKNOWN';
    try {
        const now = Date.now();
        const cdid = crypto.randomUUID();
        const header = {
            display_name: profile.displayName, update_version_code: profile.version, manifest_version_code: profile.version,
            app_version_minor: profile.versionName, aid: profile.aid, channel: 'update_64', package: profile.packageName,
            app_version: profile.versionName, version_code: profile.version, sdk_version: '3.7.0-rc.34-fanqie-xiaoshuo',
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
            'User-Agent': profile.userAgent,
            Accept: 'application/json', 'Content-Type': 'application/octet-stream;tt-data=a',
            'log-encode-type': 'gzip', 'x-ss-dp': String(profile.aid), 'x-ss-req-ticket': String(now),
            'x-vc-bdturing-sdk-version': '4.0.3.cn', lc: '101', 'sdk-version': '2',
            'passport-sdk-version': '5051452', 'x-neptune': '-8|50:51:59:30:40:47:49:39',
            'x-ss-stub': crypto.createHash('md5').update(data).digest('hex').toUpperCase(),
        };
        const deadline = Date.now() + 8000;
        let response = null;
        const urls = Array.isArray(options?.hosts) && options.hosts.length ? registerUrls(options.hosts) : REGISTER_URLS;
        for (const url of urls) {
            if (deadline <= Date.now()) break;

            const attemptEnd = Math.min(deadline, Date.now() + REGISTER_ATTEMPT_MS);
            try {
                response = await requestJson(url, { method: 'POST', headers, data }, attemptEnd, AbortSignal.timeout(Math.max(1, attemptEnd - Date.now())));
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
        throw Object.assign(new Error('匿名播放设备注册失败，请重启应用后重试'), { code: 'DEVICE_REGISTRATION_FAILED', reason });
    }
}

function getPlaybackDevice(requestJson) {
    if (registration && failedAt && Date.now() - failedAt >= FAILURE_COOLDOWN_MS) { registration = null; failedAt = 0; }
    if (registration) return registration;
    failedAt = 0;
    const attempt = Promise.resolve().then(async () => {
        try {
            return await registerDevice(requestJson);
        } catch (error) {
            if (registration === attempt) failedAt = Date.now();
            throw error;
        }
    });
    registration = attempt;
    return attempt;
}



function refreshPlaybackDevice(requestJson) {
    if (refreshing) return refreshing;
    registration = null;
    failedAt = 0;
    const run = getPlaybackDevice(requestJson);
    refreshing = run;

    run.finally(() => { if (refreshing === run) refreshing = null; }).catch(() => {});
    return run;
}




const POOL_SIZE = 2;
const POOL_TTL_MS = 5 * 60 * 1000;
const POOL_FAILURE_PAUSE_MS = 15 * 1000;
let pool = [];
let poolRequest = null;
let pending = new Set();
let poolFailedAt = 0;
let poolFailure = null;
let takeFailure = null;
let poolGeneration = 0;

function livePool() {
    const limit = Date.now() - POOL_TTL_MS;
    pool = pool.filter(entry => entry.at > limit);
    return pool;
}

function refillPool() {
    if (!poolRequest || Date.now() - poolFailedAt < POOL_FAILURE_PAUSE_MS) return;
    const requestJson = poolRequest;
    const generation = poolGeneration;
    while (livePool().length + pending.size < POOL_SIZE) {
        const job = registerDevice(requestJson).then(
            identity => { if (generation === poolGeneration) pool.push({ identity, at: Date.now() }); },
            error => { poolFailedAt = Date.now(); poolFailure = error; },
        ).finally(() => pending.delete(job));
        pending.add(job);
    }
}


function armPlaybackPool(requestJson) {
    if (typeof requestJson !== 'function') return;
    poolRequest = requestJson;
    refillPool();
}



async function takePlaybackDevice(requestJson, { again = false } = {}) {
    if (!again && takeFailure && Date.now() - takeFailure.at < FAILURE_COOLDOWN_MS) throw takeFailure.error;
    takeFailure = null;
    if (!livePool().length && pending.size) await Promise.race([...pending]);
    const ready = livePool().shift();
    if (ready) { refillPool(); return ready.identity; }

    if (poolFailure && Date.now() - poolFailedAt < 2000) { takeFailure = { at: Date.now(), error: poolFailure }; throw poolFailure; }
    try {
        const identity = await registerDevice(requestJson);
        refillPool();
        return identity;
    } catch (error) {
        takeFailure = { at: Date.now(), error };
        throw error;
    }
}



function forgetFailedPlaybackDevice() {
    if (registration && failedAt) { registration = null; failedAt = 0; }
    takeFailure = null;
    poolFailedAt = 0;
    refillPool();
}

function resetPlaybackDevice() {
    registration = null;
    failedAt = 0;
    refreshing = null;
    pool = [];
    poolRequest = null;
    pending = new Set();
    poolFailedAt = 0;
    poolFailure = null;
    takeFailure = null;
    poolGeneration += 1;
}

module.exports = { getPlaybackDevice, refreshPlaybackDevice, takePlaybackDevice, armPlaybackPool, forgetFailedPlaybackDevice, resetPlaybackDevice, registerDevice, HONGGUO_PROFILE, READER_PROFILE };
