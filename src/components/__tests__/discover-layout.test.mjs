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
  assert.match(css, /\.browse-upcoming \{ flex: none; \}/);
  assert.match(css, /\.browse-container \.source-control select \{[^}]*height: 35px;[^}]*padding-block: 0;[^}]*line-height: 35px;/);
  assert.match(css, /minmax\(calc\(150px \* var\(--ui-scale, 1\)\), 1fr\)/);
});
