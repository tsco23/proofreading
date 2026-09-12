import test from 'node:test';
import assert from 'node:assert/strict';
import { Tategaki, selectionMenuMode } from '../public/js/tategaki.js';

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
