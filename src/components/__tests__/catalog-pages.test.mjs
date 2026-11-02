import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { joinPages, loadPage } from '../../catalogPages.mjs';
import { DEFAULT_BROWSE_CATEGORIES } from '../../browseCategories.mjs';

const card = (n) => ({ series_id: String(8000000 + n), series_title: `剧${n}` });
const page = (from, to, extra = {}) => ({ success: true, results: Array.from({ length: to - from + 1 }, (_, i) => card(from + i)), ...extra });

test('a page that succeeds is asked for once', async () => {
  let calls = 0;
  const reply = await loadPage(async () => { calls += 1; return page(1, 3); }, {});
  assert.equal(calls, 1);
  assert.equal(reply.results.length, 3);
});

test('a failed or thrown page gets one more try and the retry result wins', async () => {
  let calls = 0;
  const reply = await loadPage(async () => { calls += 1; if (calls === 1) return { success: false, error: '超时' }; return page(1, 2); }, {});
  assert.equal(calls, 2);
  assert.equal(reply.success, true);
  let threw = 0;
  const second = await loadPage(async () => { threw += 1; if (threw === 1) throw new Error('boom'); return page(1, 1); }, {});
  assert.equal(second.success, true);
});

test('a page that never answers is cut off, retried once, then reported as a timeout', async () => {
  let calls = 0;
  const started = Date.now();
  const reply = await loadPage(() => { calls += 1; return new Promise(() => {}); }, { timeoutMs: 20 });
  assert.equal(calls, 2);
  assert.equal(reply.success, false);
  assert.match(reply.error, /超时/);
  assert.ok(Date.now() - started < 1000);
});

test('a request that is no longer wanted is not retried', async () => {
  let calls = 0;
  const reply = await loadPage(async () => { calls += 1; return { success: false, error: 'x' }; }, { isCurrent: () => false });
  assert.equal(calls, 1);
  assert.equal(reply.success, false);
  assert.equal((await loadPage(async () => ({ success: false }), { attempts: 1 })).success, false);
});

test('joined pages keep their order, drop repeats, and stop at the first page that is missing', () => {
  const first = page(1, 3).results;
  const all = joinPages(first, [page(3, 5, { hasMore: true }), page(6, 7, { hasMore: false })], true);
  assert.deepEqual(all.results.map((item) => item.series_id), [1, 2, 3, 4, 5, 6, 7].map((n) => String(8000000 + n)));
  assert.equal(all.complete, true);
  assert.equal(all.hasMore, false);
  const hole = joinPages(first, [null, page(6, 7)], true);
  assert.equal(hole.results.length, 3, 'a later page is not shown while an earlier one is missing');
  assert.equal(hole.complete, false);
  assert.equal(hole.hasMore, false);
  assert.equal(joinPages(first, [{ success: true, results: [] }, page(6, 7)]).results.length, 3, 'an empty page ends the list');
  assert.equal(joinPages(first, [], true).hasMore, true, 'the first page decides when nothing else was asked for');
  assert.deepEqual(joinPages(undefined, undefined).results, []);
  assert.deepEqual(joinPages([{ series_id: '' }, null, card(1)], []).results.length, 1);
});

test('the category rows shown before the main process answers match the main process list', () => {
  const source = fs.readFileSync(new URL('../../../main.js', import.meta.url), 'utf8');
  const block = source.match(/const BROWSE_CATEGORIES = \[([\s\S]*?)\n\];/)[1];
  const fromMain = [...block.matchAll(/slug: '([^']+)', label: '([^']+)'(?:, group: '([^']+)')?/g)].map(([, slug, label, group]) => ({ slug, label, ...(group ? { group } : {}) }));
  assert.equal(fromMain.length, 8);
  assert.deepEqual(DEFAULT_BROWSE_CATEGORIES.map((item) => ({ ...item })), fromMain);
});
