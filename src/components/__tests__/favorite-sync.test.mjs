import test from 'node:test';
import assert from 'node:assert/strict';
import { planFavorites, newCancels, markConfirmed } from '../../favoriteSync.mjs';

const NOW = 1_800_000_000_000;
const U = '1234567890123456', OTHER = '6543210987654321';
const item = (id, extra = {}) => ({ id, title: `剧${id}`, published_at: null, favorite: true, favorited_at: 1_700_000_000_000, cover: '', online_time: null, cloud_user: null, ...extra });
const cloud = (id, extra = {}) => ({ id, favoritedAt: 1_750_000_000_000, title: `云${id}`, cover: 'https://x/c.jpg', ...extra });
const ids = list => list.filter(i => i.favorite).map(i => i.id).sort();

test('first sign-in merges both sides: phone favorites come in, playable local ones go up', () => {
  const plan = planFavorites({ items: [item('7300000000000000001'), item('7300000000000000002')], cloud: [cloud('7300000000000000002'), cloud('7300000000000000003')], userId: U, now: NOW });
  assert.deepEqual(ids(plan.items), ['7300000000000000001', '7300000000000000002', '7300000000000000003']);
  assert.deepEqual(plan.toAdd, ['7300000000000000001']);
  const added = plan.items.find(i => i.id === '7300000000000000003');
  assert.equal(added.title, '云7300000000000000003');
  assert.equal(added.cloud_user, U);
  assert.equal(added.favorited_at, 1_750_000_000_000);
  assert.equal(plan.items.find(i => i.id === '7300000000000000002').title, '剧7300000000000000002', 'local name kept');
});

test('removed on the phone: a confirmed favorite disappears here too', () => {
  const plan = planFavorites({ items: [item('7300000000000000001', { cloud_user: U }), item('7300000000000000002', { cloud_user: U })], cloud: [cloud('7300000000000000002')], userId: U, now: NOW });
  assert.deepEqual(ids(plan.items), ['7300000000000000002']);
  assert.deepEqual(plan.toAdd, []);
  assert.equal(plan.items.find(i => i.id === '7300000000000000001').cloud_user, null);
});

test('an empty account list never clears this computer', () => {
  const plan = planFavorites({ items: [item('7300000000000000001', { cloud_user: U })], cloud: [], userId: U, now: NOW });
  assert.deepEqual(ids(plan.items), ['7300000000000000001']);
  assert.match(plan.notice, /先保留/);
  assert.equal(plan.changed, false);
});

test('not online yet: stays here, never sent', () => {
  const plan = planFavorites({ items: [item('7300000000000000001', { online_time: NOW + 86400000 })], cloud: [cloud('7300000000000000002')], userId: U, now: NOW });
  assert.deepEqual(plan.toAdd, []);
  assert.deepEqual(ids(plan.items), ['7300000000000000001', '7300000000000000002']);
  const online = planFavorites({ items: [item('7300000000000000001', { online_time: NOW - 1 })], cloud: [cloud('7300000000000000002')], userId: U, now: NOW });
  assert.deepEqual(online.toAdd, ['7300000000000000001'], 'goes up once online');
});

test('another account: favorites confirmed elsewhere are neither sent nor removed', () => {
  const plan = planFavorites({ items: [item('7300000000000000001', { cloud_user: OTHER })], cloud: [cloud('7300000000000000002')], userId: U, now: NOW });
  assert.deepEqual(plan.toAdd, []);
  assert.deepEqual(ids(plan.items), ['7300000000000000001', '7300000000000000002']);
});

test('cancellations: pending ones are sent and not re-added; favorited again means keep', () => {
  const items = [item('7300000000000000001', { favorite: false, cloud_user: U })];
  const plan = planFavorites({ items, cloud: [cloud('7300000000000000001')], userId: U, cancels: ['7300000000000000001'], now: NOW });
  assert.deepEqual(plan.toCancel, ['7300000000000000001']);
  assert.deepEqual(ids(plan.items), [], 'the phone copy does not bring it back while the cancel is pending');
  const again = planFavorites({ items: [item('7300000000000000001', { cloud_user: U })], cloud: [cloud('7300000000000000001')], userId: U, cancels: ['7300000000000000001'], now: NOW });
  assert.deepEqual(again.toCancel, []);
  assert.deepEqual(again.cancels, []);
  const done = planFavorites({ items, cloud: [], userId: U, cancels: ['7300000000000000001'], now: NOW });
  assert.deepEqual(done.cancels, [], 'already gone from the account');
});

test('new cancellations only for confirmed favorites of this account', () => {
  const before = [item('a', { cloud_user: U }), item('b', { cloud_user: U }), item('c'), item('d', { cloud_user: OTHER })];
  const after = [item('a', { cloud_user: U, favorite: false }), item('c', { favorite: false })];
  assert.deepEqual(newCancels(before, after, U), ['a', 'b']);
  assert.equal(markConfirmed(before, 'c', U, true).find(i => i.id === 'c').cloud_user, U);
  assert.equal(markConfirmed(before, 'a', U, false).find(i => i.id === 'a').cloud_user, null);
});

test('a phone favorite without a known name keeps an id-based label, never a made-up name', () => {
  const plan = planFavorites({ items: [], cloud: [cloud('7300000000000000009', { title: '', cover: '' })], userId: U, now: NOW });
  assert.equal(plan.items[0].title, '短剧 000009');
  const named = planFavorites({ items: plan.items, cloud: [cloud('7300000000000000009', { title: '真名' })], userId: U, now: NOW });
  assert.equal(named.items[0].title, '真名', 'the real name replaces the label later');
  assert.equal(named.toAdd.length, 0);
});

test('caps the account changes sent in one pass', () => {
  const items = Array.from({ length: 30 }, (_, i) => item(String(7300000000000000100n + BigInt(i))));
  assert.equal(planFavorites({ items, cloud: [cloud('7300000000000000001')], userId: U, now: NOW }).toAdd.length, 20);
});

test('category: the account label fills new and existing favorites; a local guess fills only a gap', () => {
  const plan = planFavorites({
    items: [item('7300000000000000001', { category: 'real' }), item('7300000000000000002', { category: 'real' }), item('7300000000000000004', { category: 'comic' })],
    cloud: [cloud('7300000000000000001', { category: '' }), cloud('7300000000000000002', { category: 'ai' }), cloud('7300000000000000003', { category: 'ai' })],
    userId: U, now: NOW,
  });
  const kind = id => plan.items.find(i => i.id === id).category;
  assert.equal(kind('7300000000000000001'), 'real', 'no account label keeps the local one');
  assert.equal(kind('7300000000000000002'), 'ai', 'the account label wins');
  assert.equal(kind('7300000000000000003'), 'ai', 'phone-only favorite brings its label');
  assert.equal(kind('7300000000000000004'), 'comic', 'local-only favorite is untouched');
  assert.equal(planFavorites({ items: [], cloud: [cloud('7300000000000000005', { category: 'weird' })], userId: U, now: NOW }).items[0].category, '');
});

test('an unchanged list with categories does not report a change again', () => {
  const first = planFavorites({ items: [], cloud: [cloud('7300000000000000001', { category: 'ai' })], userId: U, now: NOW });
  const again = planFavorites({ items: first.items, cloud: [cloud('7300000000000000001', { category: 'ai' })], userId: U, now: NOW });
  assert.equal(again.changed, false);
});


test('both sides have the favorite: a newer local favorite time wins', () => {
  const id = '7300000000000000001';
  const localAt = NOW - 1000, cloudAt = NOW - 9000;
  const mine = item(id, { favorited_at: localAt, cloud_user: U, category: 'real' });
  const plan = planFavorites({ items: [mine], cloud: [cloud(id, { favoritedAt: cloudAt })], userId: U, now: NOW });
  assert.equal(plan.items[0].favorited_at, localAt);
  assert.equal(plan.items[0].favorite, true);
  assert.equal(plan.items[0].title, mine.title);
  assert.deepEqual(plan.toAdd, [], 'already present in the account: no redundant add');
  assert.deepEqual(plan.toCancel, []);
  assert.equal(mine.favorited_at, localAt, 'the input is not mutated');
});

test('both sides have the favorite: a newer account time wins and stays stable', () => {
  const id = '7300000000000000001';
  const localAt = NOW - 9000, cloudAt = NOW - 1000;
  const mine = item(id, { favorited_at: localAt, cloud_user: U });
  const remote = cloud(id, { favoritedAt: cloudAt, category: 'ai' });
  const plan = planFavorites({ items: [mine], cloud: [remote], userId: U, now: NOW });
  assert.equal(plan.items[0].favorited_at, cloudAt);
  assert.equal(plan.items[0].favorite, true);
  assert.equal(plan.items[0].category, 'ai');
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.toAdd, []);
  assert.deepEqual(plan.toCancel, []);
  assert.equal(mine.favorited_at, localAt);
  const again = planFavorites({ items: plan.items, cloud: [remote], userId: U, now: NOW });
  assert.equal(again.items[0].favorited_at, cloudAt);
  assert.equal(again.changed, false);
});

test('favorite time: equal times stay stable; missing or invalid times cannot beat a known time', () => {
  const id = '7300000000000000001', at = NOW - 1000;
  for (const bad of [0, null, undefined, -1, NaN, Infinity]) {
    const mine = item(id, { favorited_at: at, cloud_user: U });
    const plan = planFavorites({ items: [mine], cloud: [cloud(id, { favoritedAt: bad })], userId: U, now: NOW });
    assert.equal(plan.items[0].favorited_at, at);
    const remote = planFavorites({ items: [item(id, { favorited_at: bad })], cloud: [cloud(id, { favoritedAt: at })], userId: U, now: NOW });
    assert.equal(remote.items[0].favorited_at, at);
  }
  const known = planFavorites({ items: [], cloud: [cloud(id, { favoritedAt: at })], userId: U, now: NOW });
  assert.equal(planFavorites({ items: known.items, cloud: [cloud(id, { favoritedAt: at })], userId: U, now: NOW }).changed, false);
  const unknown = planFavorites({ items: [item(id, { favorited_at: null })], cloud: [cloud(id, { favoritedAt: 0 })], userId: U, now: NOW });
  assert.equal(unknown.items[0].favorited_at, NOW);
});
