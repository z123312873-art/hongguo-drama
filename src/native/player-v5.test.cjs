const assert = require('node:assert/strict');
const test = require('node:test');
const player = require('./player-v5');

const identity = { device_id: '4474387174276572', iid: '4474387173477868', cdid: '11111111-2222-3333-4444-555555555555' };
const vid = '7600000000000000001';

function sequence(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function readVarint(buf, offset) {
  let value = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && shift <= 63n) {
    const byte = buf[i++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i];
    shift += 7n;
  }
  throw new Error('varint');
}

function sintField(buf, wanted) {
  let i = 0;
  let found = null;
  while (i < buf.length) {
    const [key, next] = readVarint(buf, i);
    i = next;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      const [value, after] = readVarint(buf, i);
      if (field === wanted) found = (value >> 1n) ^ -(value & 1n);
      i = after;
    } else if (wire === 2) {
      const [length, after] = readVarint(buf, i);
      i = after + Number(length);
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else throw new Error(`wire ${wire}`);
  }
  return found;
}

function assertWire(url) {
  const query = new URL(url).searchParams;
  assert.equal(query.get('version_code'), '74532');
  assert.equal(query.get('version_name'), '7.4.5.32');
  assert.equal(query.get('update_version_code'), '74532');
  assert.equal(query.get('manifest_version_code'), '74532');
  assert.equal(query.get('channel'), 'update_64');
  assert.equal(query.get('device_type'), '25053RT47C');
  assert.equal(query.get('os_version'), '16');
}

test('player requests carry the current playback identity and signed field 21', () => {
  const stamp = { now: 1800000000123, rand: sequence(9), processNonce: 'nonce', processStarted: 1700000000000 };
  const signed = player.signedPlayerRequest(vid, identity, player.PLAYER_HOSTS[0], stamp);
  const tab = player.signedVideoTabRequest(vid, identity, player.PLAYER_HOSTS[1], { ...stamp, rand: sequence(9) });
  assertWire(signed.url);
  assertWire(tab.url);
  assert.match(signed.headers['User-Agent'], /^com\.phoenix\.read\/74532 .*25053RT47C/);
  assert.match(tab.headers['User-Agent'], /^com\.phoenix\.read\/74532 .*25053RT47C/);
  const query = Object.fromEntries(new URL(signed.url).searchParams);
  const device = {
    version_name: query.version_name, channel: query.channel, device_id: query.device_id,
    os_version: query.os_version, device_type: query.device_type,
  };
  const again = player.medusa(signed.url, signed.body, signed.khronos, device, { rand: sequence(9), processNonce: 'nonce', processStarted: 1700000000000 });
  assert.equal(again, signed.headers['x-medusa']);
  assert.match(player.medusa.toString(), /medusaMaterial\(/);
  const built = player.medusaMaterial(signed.url, signed.body, signed.khronos, device, { rand: () => 1, processNonce: 'nonce', processStarted: 1 });
  assert.equal(sintField(built.message, 21), 312n);
});
