import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesText, toTraditional } from '../../chineseScript.mjs';
import { convertConfig } from '../../script-jsx/convert.mjs';
import { uiScale } from '../../uiScale.mjs';

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
});
