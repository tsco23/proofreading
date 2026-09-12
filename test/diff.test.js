import test from 'node:test';
import assert from 'node:assert/strict';
import { diffTexts, diffChars, locateQuote } from '../shared/diff.js';

test('書き直された行は文字単位で並ぶ', () => {
  const before = '　湊は窓を見た。\n「山です」\n　女子は笑った。';
  const after = '　湊は窓の外を見た。\n「山です」\n　女子は少し笑った。';
  const { rows, stats } = diffTexts(before, after);
  assert.equal(stats.rewritten, 2);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
  const first = rows[0];
  assert.equal(first.type, 'change');
  assert.deepEqual(first.parts.filter((p) => p.type === 'ins').map((p) => p.text), ['の外']);
  assert.equal(rows[1].type, 'equal');
});

test('増えた行と消えた行', () => {
  const { stats } = diffTexts('あ\nい\nう', 'あ\nう\nえ');
  assert.equal(stats.removed, 1);
  assert.equal(stats.added, 1);
});

test('同じ本文なら差分は出ない', () => {
  const { stats } = diffTexts('あ\nい', 'あ\nい');
  assert.equal(stats.changed, 0);
});

test('長すぎる行は丸ごと置き換え扱い', () => {
  const a = 'あ'.repeat(3000);
  const b = 'い'.repeat(3000);
  assert.deepEqual(diffChars(a, b).map((p) => p.type), ['del', 'ins']);
});

test('指摘した箇所を本文から探す', () => {
  const text = '　湊は窓の外を見た。\n「山です」';
  assert.deepEqual(locateQuote(text, '窓の外'), { start: 3, end: 6, exact: true });
  assert.equal(locateQuote(text, '存在しない文'), null);
  const partial = locateQuote('　湊は窓の外をしばらく見ていた。', '窓の外をずっと見ていた');
  assert.ok(partial && !partial.exact, '直されていても手掛かりの位置が返る');
  assert.equal('　湊は窓の外をしばらく見ていた。'.slice(partial.start, partial.end), '窓の外を');
});
