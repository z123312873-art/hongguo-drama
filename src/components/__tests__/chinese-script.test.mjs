import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { matchesText, toTraditional } from '../../chineseScript.mjs';
import { convertConfig } from '../../script-jsx/convert.mjs';
import { uiScale } from '../../uiScale.mjs';
import { pagesToFill, posterSlots, sourcePageWindow } from '../../catalogFill.mjs';
import { fontChoice, getFontChoice, setFontChoice } from '../../fontScale.mjs';

test('traditional display keeps ambiguous senses and stays stable', () => {
  const pairs = [
    ['皇后', '皇后'],
    ['以后的皇后', '以後的皇后'],
    ['头发', '頭髮'],
    ['发展', '發展'],
    ['发财', '發財'],
    ['里面', '裡面'],
    ['干活', '幹活'],
    ['干燥', '乾燥'],
    ['干脆', '乾脆'],
    ['面条', '麵條'],
    ['下面', '下面'],
    ['只是一只', '只是一隻'],
    ['后台', '後臺'],
    ['太后', '太后'],
    ['质量', '品質'],
    ['最高质量', '最高品質'],
    ['设置', '設定'],
    ['软件', '軟體'],
    ['视频', '影片'],
    ['默认', '預設'],
    ['网络', '網路'],
    ['窗口', '視窗'],
    ['发现短剧', '發現短劇'],
    ['热播榜', '熱播榜'],
    ['分类', '分類'],
  ];
  for (const [source, expected] of pairs) {
    assert.equal(toTraditional(source), expected, source);
    assert.equal(toTraditional(expected), expected, `${source} idempotent`);
  }
  assert.equal(toTraditional('皇后驾到以后'), toTraditional(toTraditional('皇后驾到以后')));
  assert.equal(toTraditional(''), '');
  assert.equal(toTraditional(null), null);
  assert.equal(toTraditional('1080p'), '1080p');
});

test('rendered text converts while search values and kept paths do not', () => {
  const shown = convertConfig({ children: '最高质量', value: '质量', placeholder: '搜索短剧' });
  assert.equal(shown.children, '最高品質');
  assert.equal(shown.value, '质量');
  assert.equal(shown.placeholder, '搜尋短劇');
  const kept = convertConfig({ 'data-script': 'keep', children: '下载目录/红果短剧/剧名/' });
  assert.equal(kept.children, '下载目录/红果短剧/剧名/');
});

test('search text the caller still holds is not rewritten', () => {
  const typed = '後宮';
  const submitted = typed.trim();
  assert.equal(submitted, typed);
  assert.equal(matchesText('后宫风云', typed), true);
  assert.equal(matchesText('软件设置', '軟體'), true);
  assert.equal(matchesText('软件设置', '软件'), true);
  assert.equal(matchesText('皇后驾到', '駕到'), true);
  assert.equal(matchesText('皇后驾到', '不存在'), false);
  assert.equal(matchesText(null, '   '), true);
  assert.equal(matchesText(null, '剧'), false);
});

test('wide windows scale continuously and the default window does not', () => {
  assert.equal(uiScale(1100), 1);
  assert.equal(uiScale(1280), 1);
  assert.equal(uiScale(1920), 1.05);
  assert.equal(uiScale(2000), 1.056);
  assert.equal(uiScale(2560), 1.1);
  assert.equal(uiScale(3840), 1.2);
  assert.equal(uiScale(7680), 1.2);
  assert.equal(uiScale(Number.NaN), 1);
  assert.equal(uiScale(-1), 1);
  assert.equal(uiScale(undefined), 1);
  const samples = [1400, 1600, 2200, 3000];
  for (let i = 1; i < samples.length; i++) assert.ok(uiScale(samples[i]) > uiScale(samples[i - 1]));
  const layout = fs.readFileSync(new URL('../../index.css', import.meta.url), 'utf8').match(/\.app-layout\s*\{[^}]+\}/)[0];
  assert.match(layout, /height:\s*100vh/);
  assert.doesNotMatch(layout, /zoom\s*:/);
  assert.doesNotMatch(layout, /100%\s*\/\s*var\(--ui-scale\)/);
  const posters = fs.readFileSync(new URL('../Browse.css', import.meta.url), 'utf8');
  assert.match(posters, /minmax\(calc\(150px \* var\(--ui-scale, 1\)\), 1fr\)/);
});

test('catalog pages grow only when the window can show more than one source page', () => {
  const narrow = posterSlots({ width: 814, height: 450, minCard: 150 });
  assert.ok(narrow > 0 && narrow < 20);
  assert.equal(pagesToFill(narrow, 20, 5), 1);
  const wide = posterSlots({ width: 2274, height: 1140, minCard: 165 });
  assert.ok(wide > 20);
  assert.equal(pagesToFill(wide, 20, 5), 2);
  assert.equal(pagesToFill(wide, 20, 1), 1);
  assert.equal(pagesToFill(0, 20, 5), 1);
  assert.equal(pagesToFill(wide, 0, 5), 1);
  assert.equal(pagesToFill(80, 20, 8), 4);
  assert.deepEqual(sourcePageWindow(1, 1, 5), { start: 1, count: 1, uiPages: 5 });
  assert.deepEqual(sourcePageWindow(2, 2, 5), { start: 3, count: 2, uiPages: 3 });
  assert.equal(sourcePageWindow(3, 2, 5).count, 1);
});

test('font size defaults to the original interface size', () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
  globalThis.document = { documentElement: { style: { setProperty() {} } } };
  assert.equal(getFontChoice(), 'default');
  assert.equal(fontChoice('default').scale, 1);
  assert.equal(fontChoice('missing').scale, 1);
  assert.equal(setFontChoice('larger'), 'larger');
  assert.equal(getFontChoice(), 'larger');
  assert.equal(fontChoice(getFontChoice()).scale, 1.08);
  assert.throws(() => setFontChoice('huge'), /字号/);
  assert.equal(getFontChoice(), 'larger');
});
