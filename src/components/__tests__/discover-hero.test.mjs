import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { posterColumns, posterSlots } from '../../catalogFill.mjs';
import { HERO_INTERVAL_MS, HERO_LIMIT, HERO_RESERVED_ROWS, heroLineup, heroOffsetPercent, heroSlides } from '../../discoverHero.mjs';
import { uiScale } from '../../uiScale.mjs';

const series = (rank, id = String(7600000000000000000n + BigInt(rank))) => ({
  series_id: id, series_title: `剧目${rank}`, rank, heat: `${rank}万热度`,
});

function posterPlan(width, height, reservedRows, sidebar = 214) {
  const minCard = 150 * uiScale(width);
  const boxWidth = Math.max(0, width - sidebar - 72);
  const boxHeight = Math.max(0, height - 300);
  const columns = posterColumns({ width: boxWidth, minCard });
  const open = posterSlots({ width: boxWidth, height: boxHeight, minCard });
  const held = posterSlots({ width: boxWidth, height: boxHeight, minCard, reservedRows });
  return { columns, openRows: columns ? open / columns : 0, heldRows: columns ? held / columns : 0 };
}

test('hot-drama banner keeps the hottest ten, in rank order, without a fixed series', () => {
  const hottest = series(1);
  const shuffled = [{ ...hottest, rank: 9 }, series(3), series(2), hottest, ...Array.from({ length: 9 }, (_, index) => series(index + 4))];
  shuffled.push({ series_id: '12', series_title: '太短', rank: 1 });
  shuffled.push({ series_id: '7600000000000000999', series_title: '没有名次' });
  shuffled.push(null);
  const lineup = heroLineup(shuffled);
  assert.equal(lineup.length, HERO_LIMIT);
  assert.deepEqual(lineup.map(item => item.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(lineup[0].series_id, series(1).series_id);
  assert.equal(heroLineup(shuffled, 0).length, 0);
  assert.deepEqual(heroLineup(null), []);
  assert.equal(HERO_INTERVAL_MS, 5000);
  assert.equal(HERO_RESERVED_ROWS, 2);
});

test('banner track clones only the first slide and moves by one slide of the track', () => {
  assert.deepEqual(heroSlides([]), []);
  assert.equal(heroSlides([series(1)]).length, 1);
  const slides = heroSlides([series(1), series(2), series(3)]);
  assert.equal(slides.length, 4);
  assert.equal(slides.at(-1).series_id, slides[0].series_id);
  assert.equal(heroOffsetPercent(0, 4), 0);
  assert.equal(heroOffsetPercent(1, 4), -25);
  assert.equal(heroOffsetPercent(3, 4), -75);
  assert.equal(heroOffsetPercent(9, 4), -75);
  assert.equal(heroOffsetPercent(1, 11), -100 / 11);
  assert.equal(heroOffsetPercent(Number.NaN, 4), 0);
});

test('1K, 2K and 4K poster grids lose two rows and never drop the last row', () => {
  const windows = [
    ['1K', 1920, 1080],
    ['2K', 2560, 1440],
    ['4K', 3840, 2160],
  ];
  for (const [label, width, height] of windows) {
    const plan = posterPlan(width, height, HERO_RESERVED_ROWS);
    assert.ok(plan.columns >= 8, `${label} columns ${plan.columns}`);
    assert.ok(plan.openRows >= 2, `${label} open rows ${plan.openRows}`);
    assert.equal(plan.heldRows, Math.max(1, plan.openRows - HERO_RESERVED_ROWS), label);
    assert.equal(plan.heldRows % 1, 0, label);
  }
  const portrait = posterPlan(620, 940, HERO_RESERVED_ROWS, 0);
  assert.ok(portrait.columns >= 2, `portrait columns ${portrait.columns}`);
  assert.ok(portrait.heldRows >= 1 && portrait.heldRows <= portrait.openRows);
  const cramped = posterSlots({ width: 900, height: 120, minCard: 150, reservedRows: 9 });
  assert.equal(cramped, posterColumns({ width: 900, minCard: 150 }), 'a short window keeps one poster row');
  assert.equal(posterSlots({ width: 0, height: 800, reservedRows: 2 }), 0);
});

test('discover page asks the live hot-drama list and the sidebar no longer has a feed page', () => {
  const browse = fs.readFileSync(new URL('../Browse.jsx', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
  const hero = fs.readFileSync(new URL('../DiscoverHero.jsx', import.meta.url), 'utf8');
  assert.match(browse, /category:\s*'hot-drama'/);
  assert.match(browse, /HERO_RESERVED_ROWS/);
  assert.doesNotMatch(browse, /76\d{8,}/);
  assert.doesNotMatch(hero, /76\d{8,}/);
  assert.doesNotMatch(app, /热播推荐/);
  assert.doesNotMatch(app, /DramaFeed/);
  assert.match(hero, /HERO_INTERVAL_MS/);
  assert.match(hero, /translateX/);
});