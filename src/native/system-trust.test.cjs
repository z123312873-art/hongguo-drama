// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict');
const test = require('node:test');
const { trustSystemCertificates } = require('./system-trust');

const fakeTls = (system, base = ['A', 'B']) => {
  const applied = [];
  return { applied, getCACertificates: kind => kind === 'system' ? system : base, setDefaultCACertificates: list => applied.push(list) };
};

test('system certificates are merged once into the default trust list', () => {
  const tls = fakeTls(['B', 'C', 'D']);
  assert.deepEqual(trustSystemCertificates(tls), { applied: true, count: 4 });
  assert.deepEqual(tls.applied, [['A', 'B', 'C', 'D']]);
});

test('an empty, missing or failing system store leaves the default trust untouched', () => {
  const empty = fakeTls([]);
  assert.deepEqual(trustSystemCertificates(empty), { applied: false, reason: 'empty' });
  assert.equal(empty.applied.length, 0);
  assert.deepEqual(trustSystemCertificates({}), { applied: false, reason: 'unsupported' });
  const broken = { getCACertificates() { throw new Error('denied'); }, setDefaultCACertificates() { assert.fail('must not apply'); } };
  assert.deepEqual(trustSystemCertificates(broken), { applied: false, reason: 'error' });
  const junk = fakeTls([null, 7, '']);
  assert.deepEqual(trustSystemCertificates(junk), { applied: true, count: 2 });
});

test('the real Node implementation applies without throwing', () => {
  const result = trustSystemCertificates();
  assert.equal(typeof result.applied, 'boolean');
});
