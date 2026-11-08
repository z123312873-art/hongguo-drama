'use strict';

const crypto = require('node:crypto');
const sm3 = require('./sm3');
const { SBOX, ORDERS, MD5C } = require('./account-sign-data');

const u32 = value => Number(value) >>> 0;
const rotl = (value, count) => {
  const shift = count & 31;
  const bits = u32(value);
  return shift ? u32((bits << shift) | (bits >>> (32 - shift))) : bits;
};
const le32 = value => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(u32(value));
  return out;
};
const be32 = value => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(u32(value));
  return out;
};

function goEscape(value) {
  return String(value).replace(/[^A-Za-z0-9\-_.~]/g, char => char === ' ' ? '+' : `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function encodeQuery(params) {
  return Object.keys(params).sort().map(key => `${goEscape(key)}=${goEscape(params[key])}`).join('&');
}

function varint(value) {
  let number = BigInt(value);
  const out = [];
  while (number > 127n) {
    out.push(Number((number & 127n) | 128n));
    number >>= 7n;
  }
  out.push(Number(number));
  return Buffer.from(out);
}

function zigzag(value) {
  const number = BigInt(value);
  return (number << 1n) ^ (number >> 63n);
}

function field(tag, value, type = 'string') {
  if (value === undefined || value === null || value === '') return Buffer.alloc(0);
  if (type === 'bytes' || type === 'string' || type === 'message') {
    const body = type === 'bytes' || type === 'message' ? Buffer.from(value) : Buffer.from(String(value));
    if (!body.length) return Buffer.alloc(0);
    return Buffer.concat([varint((BigInt(tag) << 3n) | 2n), varint(body.length), body]);
  }
  if (type === 'float') {
    const body = Buffer.alloc(4);
    body.writeFloatLE(Number(value));
    return Buffer.concat([varint((BigInt(tag) << 3n) | 5n), body]);
  }
  return Buffer.concat([varint(BigInt(tag) << 3n), varint(type === 'sint' ? zigzag(value) : value)]);
}

function message(parts) {
  return Buffer.concat(parts.map(([tag, value, type]) => field(tag, value, type)));
}

function mix32(data, seed) {
  let iv = u32(seed);
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    if ((index & 1) === 0) iv = u32((iv >>> 4) ^ iv ^ (iv << 6) ^ byte);
    else iv = u32(~((iv >>> 7) ^ iv ^ (byte | (iv << 12))));
  }
  return iv;
}

function branch(query, body, ts) {
  const queryHash = sm3(Buffer.from(query));
  const bodyHash = body?.length ? crypto.createHash('md5').update(body).digest() : Buffer.alloc(16);
  const iv = mix32(le32(ts), mix32(bodyHash, mix32(queryHash, 0x20230928)));
  return { iv, queryHash, bodyHash };
}

function tuneQuery(params, body, stamp) {
  const ts = Math.floor(Number(stamp) / 1000) >>> 0;
  for (let offset = 0; offset < 256; offset += 1) {
    const raw = encodeQuery({ ...params, _rticket: String(Number(stamp) + offset) });
    const mixed = branch(raw, body, ts);
    if ((mixed.iv & 15) % 3 === 2) return { raw, ts, ...mixed };
  }
  throw new Error('unable to select signature branch');
}

function reverse8(value) {
  let result = 0;
  for (let bit = 0; bit < 8; bit += 1) result = (result << 1) | ((value >> bit) & 1);
  return result & 255;
}

function roll(data) {
  for (let index = 0; index < data.length; index += 1) {
    let value = ((data[index] << 4) | (data[index] >>> 4)) & 255;
    const next = index + 1 < data.length ? data[index + 1] : data[0];
    data[index] = (~(reverse8(value ^ next) ^ 20)) & 255;
  }
  return data;
}

function standardRc4(key, data) {
  const box = Array.from({ length: 256 }, (_value, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + box[i] + key[i % key.length]) & 255;
    const swap = box[i];
    box[i] = box[j];
    box[j] = swap;
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) & 255;
    j = (j + box[i]) & 255;
    const swap = box[i];
    box[i] = box[j];
    box[j] = swap;
    out[index] = data[index] ^ box[(box[i] + box[j]) & 255];
  }
  return out;
}

function gorgonKey(nonce) {
  return Buffer.from([0x4a, 0x40, 0x16, (nonce >> 8) & 255, 0x47, 0x6c, 1, nonce & 255]);
}

function gorgonInput(query, body, ts) {
  const data = Buffer.alloc(20);
  crypto.createHash('md5').update(query).digest().copy(data, 0, 0, 4);
  if (body?.length) crypto.createHash('md5').update(body).digest().copy(data, 4, 0, 4);
  data.writeUInt32LE(67503104, 12);
  data.writeUInt32BE(u32(ts), 16);
  return data;
}

function brokenRc4(key, data) {
  const box = Array.from({ length: 256 }, (_value, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + box[i] + key[i % 8]) & 255;
    box[i] = box[j];
  }
  j = 0;
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 1) {
    j = (j + box[i + 1]) & 255;
    const y = box[j];
    box[i + 1] = y;
    out[i] ^= box[(y * 2) & 255];
  }
  return out;
}

function gorgon(query, body, ts, nonce, international) {
  const data = gorgonInput(query, body, ts);
  const mixed = international ? standardRc4(gorgonKey(nonce), data) : brokenRc4(gorgonKey(nonce), data);
  roll(mixed);
  const head = Buffer.from([0x84, 4, nonce & 255, (nonce >> 8) & 255, 0x40, 1]);
  return Buffer.concat([head, mixed]).toString('hex');
}

function helios(ts, nonce) {
  const digest = crypto.createHash('md5').update(Buffer.concat([le32(nonce), Buffer.from('8662')])).digest();
  const raw = Buffer.from(digest.toString('hex'));
  let key = raw.readBigUInt64LE(0);
  const pending = [raw.readBigUInt64LE(8), raw.readBigUInt64LE(16), raw.readBigUInt64LE(24)];
  const rounds = [key];
  for (let index = 0; index < 33; index += 1) {
    const next = BigInt.asUintN(64, (rotl64(pending[0], -8) + key) ^ BigInt(index));
    pending.shift();
    pending.push(next);
    key = BigInt.asUintN(64, next ^ rotl64(key, 3));
    rounds.push(key);
  }
  const text = Buffer.from(`${u32(ts)}-1588093228-8662`);
  const pad = 16 - (text.length % 16);
  const plain = Buffer.concat([text, Buffer.alloc(pad, pad)]);
  const out = [le32(nonce)];
  for (let offset = 0; offset < plain.length; offset += 16) {
    let left = plain.readBigUInt64LE(offset);
    let right = plain.readBigUInt64LE(offset + 8);
    for (const round of rounds) {
      right = BigInt.asUintN(64, round ^ (left + rotl64(right, -8)));
      left = BigInt.asUintN(64, right ^ rotl64(left, 3));
    }
    const block = Buffer.alloc(16);
    block.writeBigUInt64LE(left);
    block.writeBigUInt64LE(right, 8);
    out.push(block);
  }
  return Buffer.concat(out).toString('base64');
}

function rotl64(value, count) {
  const shift = BigInt(count & 63);
  const bits = BigInt.asUintN(64, BigInt(value));
  if (shift === 0n) return bits;
  return BigInt.asUintN(64, (bits << shift) | (bits >> (64n - shift)));
}

function f13(iv, ts, queryHash, bodyHash) {
  const group = Math.floor(((iv & 15) - 2) / 3);
  const count = u32([0x8980f29b, 0xeb549c7f, 0xb08726db, 0xd40cb5e6, 0xe8f559e4][group] + ts);
  const shift = (count + 5) & 7;
  const pad = Buffer.from(Buffer.from('8496779dd4150bf8', 'hex').map(byte => ((byte * 257) >> shift) & 255));
  const msg = Buffer.concat([queryHash, bodyHash, le32(ts), pad, Buffer.from([0xa0, 1, 0, 0])]);
  const turns = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
  const start = [0x79e0f2fb, 0xc8b52570, 0xebc2f8cd, 0x7c104d93].map(value => rotl(value, -(count & 31)));
  const end = [0x19be4866, 0xe85986b4, 0xe19b326e, 0x71d1d7d4].map(value => rotl(value, -((count + 6) & 31)));
  let [a, b, c, d] = start;
  for (let index = 0; index < 64; index += 1) {
    const kind = Math.floor(index / 16);
    let mixed;
    if (kind === 0) mixed = (b & c) | (~b & d);
    else if (kind === 1) mixed = (b & d) | (c & ~d);
    else if (kind === 2) mixed = b ^ c ^ d;
    else mixed = c ^ (b | ~d);
    const word = msg.readUInt32LE(ORDERS[group * 64 + index] * 4);
    const next = u32(b + rotl(u32(a + mixed + word + rotl(MD5C[index], -((count + 1) & 31))), turns[kind][index % 4]));
    a = d;
    d = c;
    c = b;
    b = next;
  }
  const out = Buffer.alloc(16);
  [a, b, c, d].forEach((value, index) => out.writeUInt32LE(u32((start[index] + value) ^ end[index]), index * 4));
  let check = 0x20220420;
  for (let index = 0; index < 12; index += 1) {
    const byte = out[index];
    if ((index & 1) === 0) check = u32(((check >>> 3) ^ check) ^ byte ^ (check << 7));
    else check = u32(((check >>> 5) ^ check) ^ ~(byte | (check << 11)));
  }
  return Buffer.concat([out, le32((check | 4) ^ 0x1000000)]);
}

function deviceMessage(deviceId) {
  const parts = [
    [1, 1, 'sint'], [2, 2, 'sint'], [3, '8662'], [4, deviceId], [5, 'Ai6svO3PyrwDOUSmO6ZcResxu'], [6, '!noperm!'],
    [7, -888888, 'sint'], [8, -888888, 'sint'], [9, 3, 'sint'], [10, -888888, 'sint'], [11, '!notset!'],
    [12, 'Asia/Shanghai,8'], [13, 'zh_CN'], [14, 4, 'sint'],
  ];
  [255.24993896484375, 35.58599090576172, 3.467449188232422, 3.467449188232422, 255.1754913330078, 42.17544174194336]
    .forEach((value, index) => parts.push([index + 16, value, 'float']));
  parts.push([22, '16'], [23, 41, 'sint'], [24, 36, 'sint']);
  for (let tag = 25; tag <= 28; tag += 1) parts.push([tag, tag === 28 ? 1728388016637 : 1728388016635, 'sint']);
  parts.push([29, -1, 'sint']);
  ['25053RT47C', 'Redmi', '25053RT47C', '25053RT47C', 'Redmi', 'Redmi', 'Redmi']
    .forEach((value, index) => parts.push([index + 30, value]));
  parts.push([38, 31, 'sint']);
  return message(parts);
}

function protoBody(query, ts, nonce, deviceId, queryHash, bodyHash, folded, version) {
  const report = message([[1, ts, 'sint'], [2, -2, 'sint'], [4, 200, 'sint']]);
  const env = message([
    [1, 110, 'sint'], [2, 146331399, 'sint'], [3, 146331396, 'sint'], [5, 7, 'sint'],
    [6, 'v04.06.04.03-bugfix'], [7, 11001, 'sint'], [12, deviceMessage(deviceId), 'message'],
    [13, report, 'message'], [14, version],
  ]);
  const count = message([[1, 111, 'sint'], [2, 10, 'sint'], [3, 694367, 'sint'], [5, 586952199, 'sint']]);
  const digest = sm3(Buffer.concat([Buffer.from(query), bodyHash, Buffer.from('none')]));
  return message([
    [1, Buffer.from('f7e85ffad7d7dc3bd62ac87057cf6118', 'hex'), 'bytes'],
    [2, 3, 'sint'], [3, nonce, 'sint'], [4, '8662'], [5, deviceId], [6, '1588093228'], [7, version],
    [8, 'v04.06.04-ml-android'], [9, 67503104, 'sint'],
    [10, Buffer.from('4001000000000000', 'hex'), 'bytes'],
    [12, ts, 'sint'], [13, folded, 'bytes'], [14, queryHash.subarray(0, 6), 'bytes'],
    [15, count, 'message'], [16, 'AXYQOS6n2m60x1fVZHIrH3iol'], [17, ts, 'sint'],
    [19, digest, 'bytes'], [20, 'none'], [21, 312, 'sint'], [23, env, 'message'],
    [24, '{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}'],
  ]);
}

function xmxor(data, key) {
  const out = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) {
    const at = (index * 4) & 28;
    const left = key[at];
    const right = key[at + 1];
    let value = (~((((data[index] << 4) | (data[index] >>> 4)) & 255) + left)) ^ right;
    value = ((((value & 255) << 3) | ((value & 255) >>> 5)) + right) & 255;
    out[data.length - 1 - index] = (~(value ^ left)) & 255;
  }
  const flag = out[out.length - 1] ^ out[out.length - 2];
  const first = out[0];
  out[0] = (out[0] + (~flag)) & 255;
  out[1] = (out[1] + (out[0] ^ out[out.length - 1] ^ 254)) & 255;
  out[2] = (out[2] + (((flag - first) ^ ((((out[1] << 3) | (out[1] >>> 5)) & 255) ^ 2)) & 255)) & 255;
  for (let index = 0; index < out.length - 4; index += 1) {
    const temp = (~((((out[index + 2] << 3) | (out[index + 2] >>> 5)) & 255) ^ out[index + 1] ^ (index + 3))) & 255;
    out[index + 3] = (out[index + 3] + temp) & 255;
  }
  out[out.length - 1] ^= out[out.length - 2];
  let sum = 0;
  for (let index = 1; index < out.length; index += 1) sum += out[index];
  out[0] = ((out[0] ^ out[1]) + sum) & 255;
  return out;
}

function aesV3(data, ts) {
  if (data.length < 248) throw new Error('signature payload is too short');
  const lane = ts & 3;
  const box = SBOX.subarray(lane * 256, (lane + 1) * 256);
  const con = [[1, 0, 2, 3], [2, 0, 3, 1], [0, 1, 3, 2], [1, 0, 2, 3]][lane];
  const order = [
    [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
    [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
    [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15],
    [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
  ][lane];
  const init = [0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f][lane];
  const key = Buffer.from('f1593376766ea98d34f31b057a9d5be4', 'hex');
  const roundKey = Buffer.alloc(48);
  for (let index = 0; index < 16; index += 1) roundKey[index] = key[index] ^ ((init >>> ((index % 4) * 8)) & 255);
  let round = 8;
  for (let index = 4; index < 12; index += 1) {
    const prev = [roundKey[index * 4 - 4], roundKey[index * 4 - 3], roundKey[index * 4 - 2], roundKey[index * 4 - 1]];
    if (index % 4 === 0) {
      const spun = [(init >>> (round & 24)) ^ box[prev[1]], box[prev[2]], box[prev[3]], box[prev[0]]];
      prev.splice(0, 4, ...spun);
    }
    round += 2;
    for (let byte = 0; byte < 4; byte += 1) roundKey[index * 4 + byte] = (prev[byte] ^ roundKey[index * 4 + byte - 16]) & 255;
  }
  const block = source => {
    const bytes = Buffer.from(source);
    const add = base => {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= roundKey[base + Math.floor(index / 4) * 4 + con[index % 4]];
    };
    add(0);
    for (let pass = 1; pass <= 2; pass += 1) {
      const previous = Buffer.from(bytes);
      for (let index = 0; index < bytes.length; index += 1) {
        const at = order[index];
        bytes[index] = box[previous[con[Math.floor(at / 4)] * 4 + (at % 4)]];
      }
      if (pass === 1) {
        const shifted = Buffer.from(bytes);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = shifted[Math.floor(index / 4) * 4 + con[index % 4]];
        const xt = value => (value & 128) ? ((value << 1) ^ 0x1b) & 255 : (value << 1) & 255;
        for (let column = 0; column < 4; column += 1) {
          const a = bytes[column];
          const c = bytes[4 + column];
          const d = bytes[8 + column];
          const e = bytes[12 + column];
          const mixed = a ^ c ^ d ^ e;
          bytes[column] ^= mixed ^ xt(a ^ c);
          bytes[4 + column] ^= mixed ^ xt(c ^ d);
          bytes[8 + column] ^= mixed ^ xt(d ^ e);
          bytes[12 + column] ^= mixed ^ xt(e ^ a);
        }
      }
      add(pass * 16);
    }
    for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= roundKey[16 + index];
    return bytes;
  };
  const plain = Buffer.alloc(32);
  for (let index = 0; index < 31; index += 1) {
    const at = data.subarray(index * 8);
    plain[index] = ((at[0] >> 4) & 2) | (at[1] & 64) | ((at[2] >> 2) & 1) | ((at[3] << 3) & 128) | ((at[4] >> 1) & 4) | ((at[5] << 3) & 16) | ((at[6] << 5) & 32) | ((at[7] >> 4) & 8);
  }
  plain[31] = 1;
  let previous = Buffer.from('1fe109a4125283f418de9e051a969e12', 'hex');
  const encrypted = [];
  for (let offset = 0; offset < 32; offset += 16) {
    for (let index = 0; index < 16; index += 1) plain[offset + index] ^= previous[index];
    previous = block(plain.subarray(offset, offset + 16));
    encrypted.push(previous);
  }
  const cipher = Buffer.concat(encrypted);
  const out = Buffer.concat([cipher.subarray(31, 32), data]);
  for (let index = 0; index < 31; index += 1) {
    const at = out.subarray(1 + index * 8);
    const bit = cipher[index];
    at[0] = (at[0] & ~32) | ((bit << 4) & 32);
    at[1] = (at[1] & ~64) | (bit & 64);
    at[2] = (at[2] & ~4) | ((bit << 2) & 4);
    at[3] = (at[3] & ~16) | ((bit >> 3) & 16);
    at[4] = (at[4] & ~8) | ((bit << 1) & 8);
    at[5] = (at[5] & ~2) | ((bit >> 3) & 2);
    at[6] = (at[6] & ~1) | ((bit >> 5) & 1);
    at[7] = (at[7] & 127) | ((bit << 4) & 128);
  }
  return out;
}

function medusa(query, ts, nonce, hashRand, xmRand, deviceId, iv, queryHash, bodyHash, version = '7.3.5.32') {
  const folded = f13(iv, ts, queryHash, bodyHash);
  let payload = protoBody(query, ts, nonce, deviceId, queryHash, bodyHash, folded, version);
  const signKey = Buffer.from('8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eaef71cb691f7aa8aa2f5', 'hex');
  const hash = sm3(Buffer.concat([signKey, le32(hashRand), signKey]));
  const d1 = (hashRand >>> 16) & 255;
  const seed = le32(~((((d1 << 11) | (hashRand >>> 24)) ^ (d1 >>> 5)) ^ d1));
  payload = Buffer.concat([Buffer.from('4001000000000000', 'hex'), xmxor(payload, hash)]);
  payload = Buffer.from(payload).reverse();
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= seed[(~index) & 3];
  const check = u32(0x18000001 | ((queryHash[0] & 63) << 14) | ((folded[0] & 63) << 8));
  const body = Buffer.concat([Buffer.from([0x35]), le32(xmRand), le32(check), payload, le32(hashRand).subarray(2)]);
  const encrypted = aesV3(body, ts);
  const header = Buffer.from('03000000f7e85ffad7d7dc3bd62ac87057cf6118', 'hex');
  for (let index = 0; index < 20; index += 4) header.writeUInt32LE(u32(header.readUInt32LE(index) ^ ts), index);
  return Buffer.concat([header, le32(hashRand).subarray(0, 2), Buffer.from([0, 1]), encrypted]).toString('base64');
}

function traceId(stamp, random) {
  const prefix = u32(stamp).toString(16).padStart(8, '0');
  const tail = Buffer.from(random.subarray(6)).toString('hex');
  const trace = `${prefix}10${tail}`;
  return `00-${trace}-${trace.slice(0, 16)}-01`;
}

function signInternational(params, body, stamp, random = crypto.randomBytes(14)) {
  const tuned = tuneQuery(params, body, stamp);
  const ts = tuned.ts;
  const nonce = random.readUInt16LE(0);
  const headers = {
    'X-Khronos': String(ts),
    'X-SS-Req-Ticket': new URLSearchParams(tuned.raw).get('_rticket'),
    'X-Argus': le32(ts).toString('base64'),
    'X-Ladon': be32(ts).toString('base64'),
    'X-Helios': helios(ts, random.readUInt32LE(2)),
    'X-Gorgon': gorgon(tuned.raw, body, ts, nonce, true),
    'X-TT-Trace-Id': traceId(stamp, random),
  };
  if (body?.length) headers['X-SS-STUB'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
  return { raw: tuned.raw, headers };
}

function signFull(params, body, stamp, deviceId, version = '7.3.5.32', randoms = crypto.randomBytes(16)) {
  const tuned = tuneQuery(params, body, stamp);
  const words = [0, 1, 2, 3].map(index => randoms.readUInt32LE(index * 4));
  const medusaValue = medusa(tuned.raw, tuned.ts, words[0], words[1], words[2], deviceId, tuned.iv, tuned.queryHash, tuned.bodyHash, version);
  const headers = {
    'X-Khronos': String(tuned.ts),
    'X-SS-Req-Ticket': new URLSearchParams(tuned.raw).get('_rticket'),
    'X-Helios': helios(tuned.ts, words[3]),
    'X-Medusa': medusaValue,
    'X-Gorgon': gorgon(tuned.raw, body, tuned.ts, words[0] & 0xffff, false),
  };
  if (body?.length) headers['X-SS-STUB'] = tuned.bodyHash.toString('hex').toUpperCase();
  return { raw: tuned.raw, headers };
}

module.exports = {
  encodeQuery, branch, tuneQuery, gorgon, helios, f13, protoBody, aesV3, medusa, signInternational, signFull,
};
