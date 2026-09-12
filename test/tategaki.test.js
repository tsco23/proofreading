import test from 'node:test';
import assert from 'node:assert/strict';
import { Tategaki, selectionMenuMode, selectionBarSlot } from '../public/js/tategaki.js';

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

test('指で選んだときは操作メニューを下端へ逃がす', () => {
  // Chrome のネイティブの操作バーが選択範囲の直上に出るので、そこを避ける
  assert.equal(selectionMenuMode('touch'), 'bar');
  assert.equal(selectionMenuMode('pen'), 'bar');
  assert.equal(selectionMenuMode('mouse'), 'float');
  assert.equal(selectionMenuMode('mouse', true), 'float', 'マウスならネイティブのバーは出ない');
  assert.equal(selectionMenuMode('', true), 'bar', '何で選んだか分からないときは機械の質で決める');
  assert.equal(selectionMenuMode('', false), 'float');
});

test('帯はネイティブの操作バーと下の検索バーの両方を避ける', () => {
  const 画面 = { viewportHeight: 900, headerBottom: 52, barHeight: 56 };
  const 上端 = 58; // headerBottom + 6
  const 下端 = 900 - 104 - 56; // 検索の帯のぶんを空けた高さ

  // 選択が下half にあるなら上へ
  const 下を選択 = selectionBarSlot({ ...画面, selectionTop: 600, selectionBottom: 700 });
  assert.equal(下を選択.at, 'top');
  assert.equal(下を選択.y, 上端);

  // 選択が上にあるなら下へ（ただし検索の帯の上）
  const 上を選択 = selectionBarSlot({ ...画面, selectionTop: 100, selectionBottom: 200 });
  assert.equal(上を選択.at, 'bottom');
  assert.equal(上を選択.y, 下端);
  assert.ok(上を選択.y + 画面.barHeight <= 900 - 104, "検索の帯にかからない");

  // 選択が画面いっぱいに伸びていても、遠いほうへ逃げる
  const 全面 = selectionBarSlot({ ...画面, selectionTop: 60, selectionBottom: 860 });
  assert.ok(['top', 'bottom'].includes(全面.at));

  // 選択の上下 72px には置かない
  for (const [top, bottom] of [[60, 140], [300, 420], [700, 800], [820, 880]]) {
    const 置き場 = selectionBarSlot({ ...画面, selectionTop: top, selectionBottom: bottom });
    const 離れている = 置き場.y + 画面.barHeight < top - 72 || 置き場.y > bottom + 72;
    const 逃げ場がない = top - 72 < 58 + 画面.barHeight && bottom + 72 > 下端;
    assert.ok(離れている || 逃げ場がない, `${top}〜${bottom} で ${置き場.y}`);
  }
});
