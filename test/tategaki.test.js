import test from 'node:test';
import assert from 'node:assert/strict';
import { Tategaki } from '../public/js/tategaki.js';

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
