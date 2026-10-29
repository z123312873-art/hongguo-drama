const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const spill = require('../src/native/online-spill');

(async () => {
  const entry = {};
  const stdout = new PassThrough();
  const signal = new AbortController().signal;
  const body = spill.tapContentKeyStdout(entry, stdout, signal);
  const chunks = [];
  body.on('data', c => chunks.push(c));
  stdout.write(Buffer.from('abc'));
  assert.equal(spill.spillFileSize(entry), 0, 'disk spill stays closed before gate');
  spill.openSpillGate(entry);
  await new Promise(r => setImmediate(r));
  stdout.write(Buffer.from('def'));
  stdout.end();
  await new Promise(r => body.on('end', r));
  for (let i = 0; i < 20 && spill.spillFileSize(entry) < 6; i++) await new Promise(r => setImmediate(r));
  assert.equal(Buffer.concat(chunks).toString(), 'abcdef');
  assert.ok(spill.spillFileSize(entry) >= 6);

  const rangeReq = new Request('http://local', { headers: { range: 'bytes=1-2' } });
  const ranged = spill.spillRangeResponse(rangeReq, entry);
  assert.equal(ranged.status, 206);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), 'bc');

  spill.disposeEntrySpill(entry);
  assert.equal(entry.spill, undefined);
  console.log('PASS online spill tap and range');
})().catch(error => {
  console.error('FAIL online spill:', error);
  process.exitCode = 1;
});
