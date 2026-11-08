'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { branch, f13, gorgon, helios, medusa, protoBody, aesV3, signInternational } = require('./account-sign');
const sm3 = require('./sm3');

const vector = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/passport-vectors.json'), 'utf8'));
const international = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/passport-international.json'), 'utf8'));

assert.equal(sm3(Buffer.from('abc')).toString('hex'), '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0');

const mixed = branch(vector.query, Buffer.from(vector.body), vector.ts);
assert.equal(mixed.iv, vector.iv);
assert.equal(mixed.queryHash.toString('hex'), vector.sm3);
const folded = f13(mixed.iv, vector.ts, mixed.queryHash, mixed.bodyHash);
assert.equal(folded.toString('hex'), vector.f13);
const payload = protoBody(vector.query, vector.ts, 0x12345678, '7000000000000000001', mixed.queryHash, mixed.bodyHash, folded, '7.3.5.32');
assert.equal(payload.toString('hex'), vector.proto);
assert.equal(helios(vector.ts, 0x12345678), vector.helios);
assert.equal(gorgon(vector.query, Buffer.from(vector.body), vector.ts, 0x4567, false), vector.gorgon);
vector.aes_v3.forEach((want, index) => {
  const input = Buffer.alloc(256, 0);
  for (let byte = 0; byte < input.length; byte += 1) input[byte] = byte;
  const got = aesV3(input, vector.ts + index);
  assert.equal(got.toString('hex'), want, `aes branch ${index}`);
});
assert.equal(medusa(vector.query, vector.ts, 0x12345678, 0x87654321, 0x33445566, '7000000000000000001', mixed.iv, mixed.queryHash, mixed.bodyHash), vector.medusa);

for (const sample of international.vectors) {
  assert.equal(gorgon(sample.query, Buffer.from(sample.body), sample.ts, sample.nonce, true), sample.gorgon);
  const random = Buffer.alloc(14);
  random.writeUInt16LE(sample.nonce);
  const signed = signInternational({ aid: '8662' }, Buffer.from(sample.body), sample.ts * 1000 + 123, random);
  assert.equal(signed.headers['X-Argus'], sample.argus);
  assert.equal(signed.headers['X-Ladon'], sample.ladon);
  assert.equal(signed.headers['X-Medusa'], undefined);
}

console.log('PASS account sign vectors');
