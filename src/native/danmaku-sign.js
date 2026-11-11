

'use strict';




























const { createHash, createCipheriv, randomBytes } = require('node:crypto');

const M64 = (1n << 64n) - 1n;
const M32 = (1n << 32n) - 1n;



const md5 = data => createHash('md5').update(data).digest();














const sm3 = require('./sm3');



const rotl32 = (x, n) => {
  const v = x & 0xFFFFFFFFn;
  const s = BigInt(n & 31);
  return ((v << s) | (v >> ((32n - s) & 31n))) & 0xFFFFFFFFn;
};

const rotl64 = (x, n) => {
  const v = BigInt.asUintN(64, x);
  const s = BigInt(((n % 64) + 64) % 64);
  return BigInt.asUintN(64, (v << s) | (v >> ((64n - s) & 63n)));
};


const rotr64 = (x, n) => rotl64(x, -n);

const rotl8 = (x, n) => {
  const v = x & 0xFF;
  const s = n & 7;
  return ((v << s) | (v >> ((8 - s) & 7))) & 0xFF;
};

const reverse8 = x => {
  let v = x & 0xFF;
  v = ((v & 0xF0) >> 4) | ((v & 0x0F) << 4);
  v = ((v & 0xCC) >> 2) | ((v & 0x33) << 2);
  v = ((v & 0xAA) >> 1) | ((v & 0x55) << 1);
  return v & 0xFF;
};




function pad(data) {
  const padding = 16 - (data.length % 16);
  return Buffer.concat([Buffer.from(data), Buffer.alloc(padding, padding)]);
}

const u64le = buf => BigInt.asUintN(64, buf.readBigUInt64LE(0));
const putU64le = (value, target, offset) => target.writeBigUInt64LE(BigInt.asUintN(64, value), offset);


function uvarint(value) {
  let v = BigInt.asUintN(64, value);
  const out = [];
  for (;;) {
    const byte = Number(v & 0x7Fn);
    v >>= 7n;
    if (v) out.push(byte | 0x80);
    else {
      out.push(byte);
      return Buffer.from(out);
    }
  }
}


function newDeviceId(random = randomBytes) {
  const raw = BigInt.asUintN(64, BigInt('0x' + random(8).toString('hex')));
  return String(1000000000000000000n + (raw % 8000000000000000000n));
}







function baseParams(deviceId, installId) {
  return {
    aid: '8662',
    app_name: 'novelread',
    version_code: '73532',
    version_name: '7.3.5.32',
    manifest_version_code: '73532',
    update_version_code: '73532',
    channel: 'update_64',
    device_platform: 'android',
    os: 'android',
    ssmix: 'a',
    device_type: '25053RT47C',
    device_brand: 'Redmi',
    language: 'zh',
    os_api: '36',
    os_version: '16',
    resolution: '1280*2772',
    dpi: '520',
    ac: 'wifi',
    device_id: deviceId,
    iid: installId,
  };
}








const quotePlus = value =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');

function encodeQuery(pairs) {
  return pairs.map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`).join('&');
}


function buildQuery({ stampMs, deviceId, installId, random = randomBytes }) {
  const params = baseParams(deviceId ?? newDeviceId(random), installId ?? newDeviceId(random));
  params._rticket = String(stampMs);
  const pairs = Object.entries(params).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return encodeQuery(pairs);
}








function commentXGorgon(rawQuery, stamp, nonce) {
  const head2 = ((nonce[0] % 7) + 1) << 5;
  const head3 = 0xE0 | (nonce[1] & 0x0F);

  const seed = Buffer.alloc(20);
  const digest = md5(Buffer.from(rawQuery, 'utf8'));
  digest.copy(seed, 0, 0, 4);
  seed.set([0, 1, 7, 4], 12);
  seed.writeUInt32BE(Number(BigInt(stamp) & M32), 16);

  const key = Buffer.from([0x4A, 0x00, 0x16, head3, 0x47, 0x6C, 0x00, head2]);

  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + box[i] + key[i & 7]) & 0xFF;
    box[i] = box[j];
  }

  j = 0;
  for (let offset = 0; offset < 20; offset++) {
    const i = (offset + 1) & 0xFF;
    j = (j + box[i]) & 0xFF;
    box[i] = box[j];
    seed[offset] ^= box[(box[i] + box[j]) & 0xFF];
  }

  for (let i = 0; i < 20; i++) {
    seed[i] = (reverse8(rotl8(seed[i], 4) ^ seed[(i + 1) % 20]) ^ 0xEB) & 0xFF;
  }

  return Buffer.concat([Buffer.from([0x84, 0x04, head2 & 0xFF, head3 & 0xFF, 0x00, 0x00]), seed]).toString('hex');
}




function commentLadon(aid, timestamp, prefix) {
  const digest = Buffer.from(md5(Buffer.concat([Buffer.from(prefix), Buffer.from(String(aid), 'utf8')])).toString('hex'), 'ascii');

  let left = u64le(digest.subarray(0, 8));
  let right = u64le(digest.subarray(8, 16));
  const queue = [u64le(digest.subarray(16, 24)), u64le(digest.subarray(24, 32))];

  const keys = [];
  for (let i = 0; i < 34; i++) {
    keys.push(left);
    const mixed = BigInt.asUintN(64, (rotr64(right, 8) + left) ^ BigInt(i));
    queue.push(mixed);
    left = BigInt.asUintN(64, mixed ^ rotl64(left, 3));
    right = queue.shift();
  }

  const data = Buffer.from(pad(Buffer.from(`${Math.trunc(timestamp)}-1611921764-3019`, 'utf8')));
  for (let offset = 0; offset < data.length; offset += 16) {
    let bl = u64le(data.subarray(offset, offset + 8));
    let br = u64le(data.subarray(offset + 8, offset + 16));
    for (const key of keys) {
      br = BigInt.asUintN(64, key ^ BigInt.asUintN(64, bl + rotr64(br, 8)));
      bl = BigInt.asUintN(64, br ^ rotl64(bl, 3));
    }
    putU64le(bl, data, offset);
    putU64le(br, data, offset + 8);
  }

  return Buffer.concat([Buffer.from(prefix), data]).toString('base64');
}



const ARGUS_KEY = Buffer.from('ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c', 'hex');


function commentArgus(rawQuery, timestamp, nonce) {
  const key = ARGUS_KEY;
  const parts = [];

  const varint = (field, value) => {
    parts.push(uvarint(BigInt(field) * 8n));
    parts.push(uvarint(value));
  };
  const bytesField = (field, value) => {
    parts.push(uvarint(BigInt(field) * 8n + 2n));
    parts.push(uvarint(BigInt(value.length)));
    parts.push(Buffer.from(value));
  };

  varint(1, BigInt(0x20200929 * 2));
  varint(2, 2n);
  varint(3, BigInt(nonce.readUInt32LE(6)));
  bytesField(4, Buffer.from('3019'));
  bytesField(6, Buffer.from('1611921764'));
  bytesField(7, Buffer.from('6.8.1.32'));
  bytesField(8, Buffer.from('v04.07.01-ml-android'));
  varint(9, 135135744n);
  bytesField(10, Buffer.alloc(8));
  varint(12, BigInt.asUintN(64, BigInt(timestamp) * 2n));

  const bodyHash = sm3(Buffer.alloc(16));
  const queryHash = sm3(Buffer.from(rawQuery, 'utf8'));
  bytesField(13, bodyHash.subarray(0, 6));
  bytesField(14, queryHash.subarray(0, 6));

  const nested = [0x08, (2 + (nonce[10] % 49) * 2) & 0xFF];
  for (const field of [2, 3, 4]) {
    nested.push(...uvarint(BigInt(field) * 8n));
    nested.push(...uvarint(1388734n));
  }
  bytesField(15, Buffer.from(nested));
  bytesField(20, Buffer.from('none'));
  varint(21, 738n);

  const data = Buffer.from(pad(Buffer.concat(parts)));

  const derived = sm3(Buffer.concat([key, Buffer.from([0x3C, 0xCC, 0x56, 0x7B]), key]));

  const rounds = new Array(72).fill(0n);
  for (let i = 0; i < 4; i++) rounds[i] = u64le(derived.subarray(i * 8, i * 8 + 8));
  for (let i = 4; i < 72; i++) {
    let mixed = BigInt.asUintN(64, rotr64(rounds[i - 1], 3) ^ rounds[i - 3]);
    mixed = BigInt.asUintN(64, mixed ^ rotr64(mixed, 1));
    rounds[i] = BigInt.asUintN(
      64,
      (~rounds[i - 4] & M64)
        ^ mixed
        ^ (BigInt.asUintN(64, 0x3DC94C3A046D678Bn >> BigInt((i - 4) % 62)) & 1n)
        ^ 3n,
    );
  }

  for (let offset = 0; offset < data.length; offset += 16) {
    let left = u64le(data.subarray(offset, offset + 8));
    let right = u64le(data.subarray(offset + 8, offset + 16));
    for (const round of rounds) {
      const next = BigInt.asUintN(
        64,
        left ^ (rotl64(right, 1) & rotl64(right, 8)) ^ rotl64(right, 2) ^ round,
      );
      left = right;
      right = next;
    }
    putU64le(left, data, offset);
    putU64le(right, data, offset + 8);
  }

  const xor = Buffer.from([0xD0, 0x4F, 0xFD, 0xFF, 0xD0, 0x4F, 0xFD, 0xFF]);
  for (let i = 0; i < data.length; i++) data[i] ^= xor[i % 8];
  const reversed = Buffer.concat([xor, data]).reverse();

  const container = pad(Buffer.concat([
    Buffer.from([0xA6, 0xE7, 0x83, 0xEE, 0x70, 0x01, 0x10, 0x09, 0x18]),
    reversed,
    Buffer.from([0x56, 0x7B]),
  ]));



  const cipher = createCipheriv('aes-128-cbc', md5(key.subarray(0, 16)), md5(key.subarray(16)));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(container), cipher.final()]);

  return Buffer.concat([Buffer.from([0x3C, 0xCC]), encrypted]).toString('base64');
}










function signCommentHeaders({ rawQuery, stamp, nonce, aid = '8662' }) {
  return {
    'X-Gorgon': commentXGorgon(rawQuery, stamp, nonce),
    'X-Khronos': String(Math.trunc(stamp)),
    'X-SS-Req-Ticket': String(Math.trunc(stamp) * 1000),
    'X-SS-STUB': '',
    'X-Argus': commentArgus(rawQuery, stamp, nonce),
    'X-Ladon': commentLadon(aid, stamp, nonce.subarray(2, 6)),
  };
}

const NONCE_BYTES = 11;

module.exports = {
  baseParams,
  buildQuery,
  signCommentHeaders,
  newDeviceId,

  commentXGorgon,
  commentLadon,
  commentArgus,
  md5,
  sm3,
  pad,
  uvarint,
  rotl64,
  rotr64,
  rotl8,
  reverse8,
  ARGUS_KEY,
  NONCE_BYTES,
};
