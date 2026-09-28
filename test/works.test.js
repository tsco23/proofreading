import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSimpleToml, discoverWorks, workTitle, currentWork, expandLibrary, seriesTitle } from '../shared/works.js';

test('作品の設定に使う TOML を読む', () => {
  const t = parseSimpleToml([
    '# いま書いている作品',
    '["作品"]',
    '"path" = "works/hachinin"',
    '"title" = "（未定）小学校の同級生八人"   # 題は未定',
  ].join('\n'));
  assert.equal(t['作品'].path, 'works/hachinin');
  assert.equal(t['作品'].title, '（未定）小学校の同級生八人');

  const input = parseSimpleToml('"題材" = "日常の謎ミステリ"\n"ジャンル" = ["ミステリ"]\n"題" = "夏の\\"謎\\""');
  assert.equal(input[''].題材, '日常の謎ミステリ');
  assert.equal(input[''].題, '夏の"謎"');
  assert.equal(input[''].ジャンル, undefined, '配列は読み飛ばす');
});

test('works/ の下で、原稿か設計を持つ場所だけを作品とみなす', () => {
  const names = discoverWorks([
    'works/tozan/manuscript/ch1/ch1-01.md',
    'works/tozan/outline/sections.md',
    'works/nazo/manuscript/.gitkeep',
    'works/hachinin/outline',
    'works/資料/README.md',         // 原稿も設計も無い
    'works/.draft/outline/x.md',    // 隠し
    'works/README.md',              // ファイル
    'frame/templates/outline/sections.md',
  ], 'works');
  assert.deepEqual(names.sort(), ['hachinin', 'nazo', 'tozan']);
});

test('題は、作者の題 → いまの作品の題 → 題材 → フォルダ名 の順で決める', () => {
  const current = { path: 'works/hachinin', title: '（未定）八人の夏' };
  assert.equal(workTitle({ name: 'a', workDir: 'works/a', input: { '': { 題: '縫い目', 題材: '山岳部' } }, current }), '縫い目');
  assert.equal(workTitle({ name: 'hachinin', workDir: 'works/hachinin', input: { '': { 題材: '八人' } }, current }), '（未定）八人の夏');
  assert.equal(workTitle({ name: 'nazo', workDir: 'works/nazo', input: { '': { 題材: '日常の謎ミステリ' } }, current }), '（未定）日常の謎ミステリ');
  assert.match(workTitle({ name: 'x', workDir: 'works/x', input: { '': { 題材: 'あ'.repeat(80) } } }), /…$/, '長い題材は詰める');
  assert.equal(workTitle({ name: 'plain', workDir: 'works/plain' }), 'plain');
});

test('いま書いている作品を先頭に、残りは名前の順に並べる', () => {
  const current = currentWork('["作品"]\n"path" = "works/hachinin/"\n"title" = "八人"');
  const list = expandLibrary(
    { repo: 'r', branch: 'b', worksDir: 'works', push: true },
    { names: ['tozan', 'nazo', 'hachinin'], current },
  );
  assert.deepEqual(list.map((n) => n.id), ['hachinin', 'nazo', 'tozan']);
  assert.equal(list[0].workDir, 'works/hachinin');
  assert.equal(list[0].title, '八人');
  assert.equal(list[0].repo, 'r', '置き場の設定を受け継ぐ');
  assert.equal(list[0].worksDir, undefined);
});

test('シリーズものは「題」が巻の題、「シリーズ」がシリーズ名', () => {
  // 原稿側の実際の書き方（桁を揃える空白と、行末の注）
  const input = parseSimpleToml([
    '"題"       = "火球は地面を走る"   # 巻の題（作者 2026-09-28）',
    '"シリーズ" = "八人の夏"           # シリーズ名（作者 2026-09-28）',
    '"題材" = "小学校の同級生八人"',
  ].join('\n'));
  assert.equal(workTitle({ name: 'hachinin', workDir: 'works/hachinin', input }), '火球は地面を走る');
  assert.equal(seriesTitle(input), '八人の夏');

  const [one] = expandLibrary({ repo: 'r', branch: 'b', worksDir: 'works' }, { names: ['hachinin'], inputs: { hachinin: input } });
  assert.equal(one.title, '火球は地面を走る');
  assert.equal(one.series, '八人の夏');
});

test('雛形のまま（"題" = ""）なら、題は決まっていないものとして次の候補へ', () => {
  const input = parseSimpleToml('"題" = ""\n"シリーズ" = ""\n"題材" = "日常の謎ミステリ"');
  assert.equal(workTitle({ name: 'nazo', workDir: 'works/nazo', input }), '（未定）日常の謎ミステリ');
  assert.equal(seriesTitle(input), '', 'シリーズでなければ空');
});
