import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { uiScale } from '../../uiScale.mjs';
import { posterColumns } from '../../catalogFill.mjs';

const css = fs.readFileSync(new URL('../Browse.css', import.meta.url), 'utf8');

test('discover layout stays inside 1K, 2K and 4K widths', () => {
  assert.deepEqual([1280, 1920, 2560, 3840].map(uiScale), [1, 1.05, 1.1, 1.2]);
  const sidebar = 220;
  for (const width of [1280, 1920, 2560, 3840]) {
    const scale = uiScale(width);
    const content = width - sidebar;
    const columns = posterColumns({ width: content, minCard: 150 * scale, gapX: 20 });
    assert.ok(columns >= 4, `${width} keeps at least four posters`);
    assert.ok(150 * scale <= content / 2, `${width} poster does not swallow the row`);
  }
  assert.match(css, /\.browse-header \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.browse-title-row \{[^}]*justify-content: flex-start[^}]*flex-wrap: nowrap/);
  assert.match(css, /\.browse-title-row \.browse-upcoming \{[^}]*font-size: 15px/);
  assert.doesNotMatch(css.match(/\.browse-title-row \.browse-upcoming \{[^}]*\}/)[0], /font-scale/);
  assert.match(css, /\.browse-title-row \{[^}]*align-items: center/);
  const reserve = css.match(/\.browse-reserve-band \{[^}]*\}/)[0];
  assert.match(reserve, /font-size: 12px/);
  assert.match(reserve, /text-align: center/);
  assert.doesNotMatch(reserve, /font-scale/);
  assert.doesNotMatch(reserve, /#1d4ed8/);
  const title = css.match(/\.browse-card-title \{[^}]*\}/)[0];
  assert.match(title, /min-height: calc\(42px \* var\(--font-scale, 1\)\)/);
  assert.match(title, /-webkit-line-clamp: 2/);
  const date = css.match(/\.browse-card-date \{[^}]*\}/)[0];
  assert.match(date, /text-align: center/);
  assert.match(date, /font-size: 14px/);
  assert.doesNotMatch(date, /font-scale/);
  const calendar = fs.readFileSync(new URL('../ReleaseCalendar.css', import.meta.url), 'utf8');
  const online = calendar.match(/\.release-online \{[^}]*\}/)[0];
  assert.match(online, /font-size: 12px/);
  assert.doesNotMatch(online, /font-scale/);
  assert.match(calendar, /\.release-calendar \{[^}]*max-width: 1020px/);
  assert.match(css, /\.browse-container \.source-control select \{[^}]*height: 35px;[^}]*padding-block: 0;[^}]*line-height: 35px;/);
  assert.match(css, /minmax\(calc\(150px \* var\(--ui-scale, 1\)\), 1fr\)/);
});
