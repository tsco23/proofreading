import test from 'node:test';
import assert from 'node:assert/strict';
import { Tategaki, selectionSidePlacement, noteRanges } from '../public/js/tategaki.js';

test('段落は本文の文字位置を持つ', () => {
  const text = '　一行目。\n\n「二行目」\n「三行目」\n';
  const blocks = Tategaki.parse(text);
  const paras = blocks.filter((b) => b.type === 'p');
  assert.equal(paras.length, 3);
  assert.equal(paras[0].start, 0);
  assert.equal(text.slice(paras[1].start, paras[1].end), '「二行目」');
  assert.equal(text.slice(paras[2].start, paras[2].end), '「三行目」');
});

test('空行が二つ以上続くと場面の切れ目になる', () => {
  const blocks = Tategaki.parse('前。\n\n\n後。');
  assert.deepEqual(blocks.map((b) => b.type), ['p', 'gap', 'p']);
});

test('選んだのと反対側へ、縦に積んだ釦を出す', () => {
  const 画面 = { width: 1200, height: 800 };
  const 釦 = { width: 110, height: 170 };

  const 右を選択 = selectionSidePlacement({
    selection: { left: 900, right: 1000, top: 300, bottom: 400 },
    viewport: 画面, menu: 釦,
  });
  assert.equal(右を選択.side, 'left');
  assert.ok(右を選択.x + 釦.width <= 900, '選択にかからない');

  const 左を選択 = selectionSidePlacement({
    selection: { left: 200, right: 300, top: 300, bottom: 400 },
    viewport: 画面, menu: 釦,
  });
  assert.equal(左を選択.side, 'right');
  assert.ok(左を選択.x >= 300, '選択にかからない');
});

test('片側に入らなければ、入るほうへ回す', () => {
  const 画面 = { width: 400, height: 800 };
  const 釦 = { width: 110, height: 170 };

  // 画面の右端いっぱいを選ぶと、望みどおり左に置ける
  const 右端 = selectionSidePlacement({
    selection: { left: 260, right: 396, top: 100, bottom: 200 },
    viewport: 画面, menu: 釦,
  });
  assert.equal(右端.side, 'left');

  // 左端いっぱいなら右へ
  const 左端 = selectionSidePlacement({
    selection: { left: 4, right: 140, top: 100, bottom: 200 },
    viewport: 画面, menu: 釦,
  });
  assert.equal(左端.side, 'right');

  // 幅いっぱいに選ばれてどちらにも入らないときでも、画面の中に収まる
  const 全面 = selectionSidePlacement({
    selection: { left: 0, right: 400, top: 100, bottom: 200 },
    viewport: 画面, menu: 釦,
  });
  assert.ok(全面.x >= 0 && 全面.x + 釦.width <= 400);
});

test('画面の外を選んでいても、釦は画面の中に出す', () => {
  const 画面 = { width: 1200, height: 800 };
  const 釦 = { width: 110, height: 170 };

  // まだ送っていない先（画面の左の外）を選んだとき
  const 外 = selectionSidePlacement({
    selection: { left: -900, right: -800, top: 300, bottom: 400 },
    viewport: 画面, menu: 釦,
  });
  assert.ok(外.x >= 0 && 外.x + 釦.width <= 画面.width);
});

test('上下の帯に隠れない高さへ収める', () => {
  const 画面 = { width: 1200, height: 800 };
  const 釦 = { width: 110, height: 170 };
  const 上帯 = 52;
  const 下帯 = 740;

  const 上を選択 = selectionSidePlacement({
    selection: { left: 900, right: 1000, top: 0, bottom: 40 },
    viewport: 画面, menu: 釦, safeTop: 上帯, safeBottom: 下帯,
  });
  assert.ok(上を選択.y >= 上帯, '見出しの帯の下に来る');

  const 下を選択 = selectionSidePlacement({
    selection: { left: 900, right: 1000, top: 760, bottom: 800 },
    viewport: 画面, menu: 釦, safeTop: 上帯, safeBottom: 下帯,
  });
  assert.ok(下を選択.y + 釦.height <= 下帯, '送りの帯の上に収まる');

  // 選択の真ん中に合わせる（帯に当たらないとき）
  const 真ん中 = selectionSidePlacement({
    selection: { left: 900, right: 1000, top: 380, bottom: 420 },
    viewport: 画面, menu: 釦, safeTop: 上帯, safeBottom: 下帯,
  });
  assert.equal(真ん中.y, 400 - 釦.height / 2);
});

test('本文の注は消さずに、範囲だけを拾う', () => {
  const text = '<!-- @b1 -->\n　灯は<!-- 要確認 -->窓を見た。\n<!-- 二行に\nまたがる -->\n';
  const ranges = noteRanges(text);
  assert.equal(ranges.length, 3);
  assert.deepEqual(ranges.map(([a, b]) => text.slice(a, b)), ['<!-- @b1 -->', '<!-- 要確認 -->', '<!-- 二行に\nまたがる -->']);

  // 段落の字は元のまま（注も段落の中に残る）
  const paras = Tategaki.parse(text).filter((b) => b.type === 'p');
  assert.equal(paras[0].text, '<!-- @b1 -->');
  assert.equal(paras[1].text, '　灯は<!-- 要確認 -->窓を見た。');
});
