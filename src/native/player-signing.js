const crypto = require('node:crypto');
const sm3 = require('./sm3');
const MASK = (1n << 64n) - 1n;
const rotateRight = (v, n) => ((v >> BigInt(n)) | (v << BigInt(64 - n))) & MASK;
const rotateLeft = (v, n) => rotateRight(v, 64 - n);
const digest = (name, value) => crypto.createHash(name).update(value).digest();
const word = value => { const out = Buffer.alloc(8); out.writeBigUInt64LE(value & MASK); return out; };
function varint(value) {
    let n = BigInt.asUintN(32, BigInt(value)); const out = [];
    while (n >= 128n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
    out.push(Number(n)); return Buffer.from(out);
}
function message(fields) {
    return Buffer.concat(fields.map(([tag, value]) => {
        if (typeof value === 'number' || typeof value === 'bigint') return Buffer.concat([varint(tag << 3), varint(value)]);
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        return Buffer.concat([varint((tag << 3) | 2), varint(data.length), data]);
    }));
}
function pad(data) { return Buffer.concat([data, Buffer.alloc(16 - data.length % 16, 16 - data.length % 16)]); }
function simon(data) {
    const keyBytes = Buffer.from('fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304', 'hex');
    const keys = Array.from({ length: 4 }, (_, i) => keyBytes.readBigUInt64LE(i * 8));
    for (let i = 4; i < 72; i += 1) {
        let tmp = rotateRight(keys[i - 1], 3) ^ keys[i - 3];
        tmp ^= rotateRight(tmp, 1);
        keys.push((~keys[i - 4] ^ tmp ^ ((0x3dc94c3a046d678bn >> BigInt((i - 4) % 62)) & 1n) ^ 3n) & MASK);
    }
    const out = [];
    for (let at = 0; at < data.length; at += 16) {
        let x = data.readBigUInt64LE(at), y = data.readBigUInt64LE(at + 8);
        for (const k of keys) [x, y] = [y, (x ^ (rotateLeft(y, 1) & rotateLeft(y, 8)) ^ rotateLeft(y, 2) ^ k) & MASK];
        out.push(word(x), word(y));
    }
    return Buffer.concat(out);
}
function argus(query, stub, ts, aid, nonce) {
    const params = new URLSearchParams(query);
    const hash = value => sm3(value).subarray(0, 6);
    const bean = message([
        [1, 1077940818], [2, 2], [3, nonce], [4, String(aid)], [5, params.get('device_id') || ''],
        [6, '1611921764'], [7, params.get('version_name') || ''], [8, 'v04.04.05-ov-android'],
        [9, 134744640], [10, Buffer.alloc(8)], [11, 0], [12, BigInt(ts) * 2n],
        [13, hash(stub ? Buffer.from(stub, 'hex') : Buffer.alloc(16))],
        [14, hash(query ? Buffer.from(query) : Buffer.alloc(16))],
        [15, message([[1, 1], [2, 1], [3, 1], [7, 0xc792eccc]])], [16, ''], [20, 'none'], [21, 738],
        [23, message([[1, 'NX551J'], [2, 8196], [4, 0x80e0d800]])], [25, 2],
    ]);
    const magic = Buffer.from('f2f7fcfff2f7fcff', 'hex');
    const framed = Buffer.concat([magic, simon(pad(bean)), Buffer.from('eafb2cfe8568519154', 'hex')]);
    for (let i = 8; i < framed.length; i += 1) framed[i] ^= magic[i % 8];
    framed.reverse();
    const aes = crypto.createCipheriv('aes-128-cbc', Buffer.from('d31e3718288a1027baab59f146a09a9c', 'hex'), Buffer.from('ea180a0336ed352fcd24e4d50018ae54', 'hex'));
    return Buffer.concat([Buffer.from('f281', 'hex'), aes.update(Buffer.concat([framed, Buffer.from('ao')])), aes.final()]).toString('base64');
}
function ladon(ts, aid, random) {
    const bytes = Buffer.from(digest('md5', Buffer.concat([random, Buffer.from(String(aid))])).toString('hex'));
    let b0 = bytes.readBigUInt64LE(0), b8 = bytes.readBigUInt64LE(8);
    const pending = [bytes.readBigUInt64LE(16), bytes.readBigUInt64LE(24)], keys = [b0];
    for (let i = 0; i < 34; i += 1) {
        let next = ((rotateRight(b8, 8) + b0) & MASK) ^ BigInt(i);
        pending.push(next); next ^= rotateLeft(b0, 3); keys.push(next & MASK); b0 = next & MASK; b8 = pending.shift();
    }
    const input = pad(Buffer.from(`${ts}-1611921764-${aid}`)), out = [random];
    for (let at = 0; at < input.length; at += 16) {
        let a = input.readBigUInt64LE(at), b = input.readBigUInt64LE(at + 8);
        for (let i = 0; i < 34; i += 1) { b = keys[i] ^ ((a + rotateRight(b, 8)) & MASK); a = b ^ rotateLeft(a, 3); }
        out.push(word(a), word(b));
    }
    return Buffer.concat(out).toString('base64');
}
function headers(url, body, options = {}) {
    const parsed = new URL(url), query = parsed.search.slice(1), rawTicket = parsed.searchParams.get('_rticket');
    if (!/^\d+$/.test(rawTicket || '') || !Number.isSafeInteger(Number(rawTicket))) throw new Error('播放請求時間無效');
    const ticket = Number(rawTicket), ts = Math.floor(ticket / 1000), aid = Number(parsed.searchParams.get('aid') || 1967);
    if (!Number.isSafeInteger(aid) || aid <= 0 || ts <= 0) throw new Error('播放請求參數無效');
    const data = body == null ? Buffer.alloc(0) : Buffer.from(body);
    const stub = data.length ? digest('md5', data).toString('hex') : '';
    const result = {
        'x-ss-req-ticket': String(ticket), 'x-khronos': String(ts),
        'x-ladon': ladon(ts, aid, options.random || crypto.randomBytes(4)),
        'x-argus': argus(query, stub, ts, aid, options.nonce ?? crypto.randomBytes(4).readUInt32LE()),
    };
    if (stub) result['x-ss-stub'] = stub;
    return result;
}
function gorgon(query, ts, r1 = crypto.randomInt(256), r2 = crypto.randomInt(256)) {
    const timestamp = Buffer.alloc(4); timestamp.writeUInt32BE(ts >>> 0);
    const data = Buffer.concat([digest('md5', Buffer.from(query)).subarray(0, 4), Buffer.from([0, 0, 0, 0, 0, 1, 7, 4]), timestamp]);
    const table = Array.from({ length: 256 }, (_, i) => i), key = [74, 0, 22, r2, 71, 108, 0, r1];
    let j = 0, k = 0;
    for (let i = 0; i < 256; i += 1) { j = (j + table[i] + key[i & 7]) & 255; table[i] = table[j]; }
    for (let i = 0; i < data.length; i += 1) {
        const idx = (((i ^ 1) + (i & 1)) << 1) & 255;
        k = (((k | table[idx]) << 1) - (k ^ table[idx])) >>> 0;
        const value = table[k & 255]; table[idx] = value; table[k & 255] = value;
        data[i] ^= table[(value * 3) & 255];
    }
    for (let i = 0; i < data.length; i += 1) {
        let value = ((data[i] >>> 4) | (data[i] << 4)) & 255;
        value ^= data[i === data.length - 1 ? 0 : i + 1];
        value = ((value << 1) & 0xffffffaa) | ((value >>> 1) & 85);
        value = ((value << 2) & 0xffffffcf) | ((value >>> 2) & 51);
        value = ((value & 0x0fffffff) << 4) | ((value >>> 4) & 15);
        data[i] = (value ^ ~data.length) & 255;
    }
    return Buffer.concat([Buffer.from([132, 4, r1, r2, 0, 0]), data]).toString('hex');
}
module.exports = { headers, gorgon };
