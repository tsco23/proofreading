import test from 'node:test';
import assert from 'node:assert/strict';
import {
  kanjiNumber, parseKanjiNumber, isSectionId, sectionOrder, countChars,
  parseChapterTitles, parseSectionMeta, insertIntoInbox, parseInboxMarkers, formatInboxEntry,
  stripNotes, buildToc, applyWorkDir, sectionPath,
} from '../shared/novel.js';

test('漢数字の変換', () => {
  assert.equal(kanjiNumber(1), '一');
  assert.equal(kanjiNumber(6), '六');
  assert.equal(kanjiNumber(10), '十');
  assert.equal(kanjiNumber(12), '十二');
  assert.equal(kanjiNumber(23), '二十三');
  assert.equal(parseKanjiNumber('三'), 3);
  assert.equal(parseKanjiNumber('十四'), 14);
  assert.equal(parseKanjiNumber('7'), 7);
});

test('節 ID の判定と並び', () => {
  assert.ok(isSectionId('ch1-01'));
  assert.ok(!isSectionId('ch1'));
  assert.ok(!isSectionId('../etc/passwd'));
  assert.ok(sectionOrder('ch1-06') < sectionOrder('ch2-01'));
  assert.ok(sectionOrder('ch2-02') > sectionOrder('ch2-01'));
});

test('字数は空白を数えない', () => {
  assert.equal(countChars('　あいう\nえお '), 5);
});

test('structure.md の表から章題を読む', () => {
  const titles = parseChapterTitles([
    '| 章 | 題 | 時期 | 節数 | 役割 |',
    '|---|---|---|---:|---|',
    '| 一 | 出遅れ | 4月中旬〜5月上旬 | **6** | 世界と人物の提示 |',
    '| 二 | 重さの分け方 | 5月 | 4 | 技術の習得 |',
  ].join('\n'));
  assert.equal(titles.get(1).title, '出遅れ');
  assert.equal(titles.get(2).title, '重さの分け方');
  assert.equal(titles.get(1).period, '4月中旬〜5月上旬');
  assert.equal(titles.size, 2);
});

test('sections.md から節の設計を読む', () => {
  const metas = parseSectionMeta([
    '# 第一章 出遅れ',
    '',
    '## ch1-01',
    '- **視点** 湊／**時** 四月中旬／**場所** 教室',
    '- 湊は新入生。窓から常念山脈が見える。',
    '- **引き** 緑色の扉が開く',
    '- **要確認** 確認済み',
    '',
    '## ch1-02',
    '- **視点** 樹／**時** 四月下旬／**場所** 雨宮家',
    '- 玄関を埋める父の山道具。',
  ].join('\n'));
  const one = metas.get('ch1-01');
  assert.equal(one.viewpoint, '湊');
  assert.equal(one.time, '四月中旬');
  assert.equal(one.place, '教室');
  assert.equal(one.hook, '緑色の扉が開く');
  assert.match(one.summary, /新入生/);
  assert.equal(metas.get('ch1-02').viewpoint, '樹');
});

test('inbox.md の未対応へ差し込み、（なし）は消える', () => {
  const before = [
    '# レビュー指摘の受け取り箱',
    '',
    '## 未対応',
    '',
    '（なし）',
    '',
    '## 済',
    '',
    '- 前に直した件',
  ].join('\n');
  const entry = formatInboxEntry({
    id: 'ann_1', sectionId: 'ch1-02', sectionLabel: '第一章 第二節', userName: '加藤',
    createdAt: '2026-09-12T10:00:00.000Z', quote: '扉が鳴った', body: 'ここは言い過ぎでは', start: 10, end: 16,
    baseSha: 'abcdef1234567890',
  });
  const after = insertIntoInbox(before, entry);
  assert.ok(!after.includes('（なし）'));
  assert.ok(after.includes('- **ch1-02**（第一章 第二節）／加藤／2026-09-12'));
  assert.ok(after.includes('  > 扉が鳴った'));
  assert.ok(after.includes('ここは言い過ぎでは'));
  assert.ok(after.indexOf('ann_1') < after.indexOf('## 済'), '未対応の側に入る');
  assert.ok(after.includes('- 前に直した件'), '済は残る');

  const second = insertIntoInbox(after, formatInboxEntry({
    id: 'ann_2', sectionId: 'ch1-03', sectionLabel: '第一章 第三節', userName: '茅野',
    createdAt: '2026-09-13T10:00:00.000Z', quote: '', body: '二件目', start: null, end: null, baseSha: '',
  }));
  assert.ok(second.indexOf('ann_1') < second.indexOf('ann_2'), '古い順に並ぶ');
  const markers = parseInboxMarkers(second);
  assert.equal(markers.get('ann_1'), 'open');
  assert.equal(markers.get('ann_2'), 'open');
});

test('済へ移された指摘は対応済みとして読める', () => {
  const text = [
    '## 未対応', '',
    '- **ch1-03**（第一章 第三節）／茅野／2026-09-13',
    '  <!-- pr:id=ann_2 section=ch1-03 -->', '',
    '## 済', '',
    '- **ch1-02**（第一章 第二節）／加藤／2026-09-12',
    '  <!-- pr:id=ann_1 section=ch1-02 -->',
  ].join('\n');
  const markers = parseInboxMarkers(text);
  assert.equal(markers.get('ann_1'), 'resolved');
  assert.equal(markers.get('ann_2'), 'open');
});

test('見出しが無い inbox にも書ける', () => {
  const out = insertIntoInbox('# 受け取り箱\n', '- 指摘');
  assert.ok(out.includes('## 未対応'));
  assert.ok(out.includes('- 指摘'));
});

test('新しい書式：章題は「# 第一章　幌」の見出しからも読む', () => {
  const titles = parseChapterTitles([
    '# 章立て ──『縫い目』',
    '',
    '| 幕 | 節 | 累計字数 | どこで流れが変わるか |',
    '|---|---|---:|---|',
    '| 第一幕 | ch1-01 〜 ch2-04 | 〜36,000 | 四人が形だけ揃う |',
    '',
    '| 章 | 節数 | 字数 | 累計 |',
    '|---|---:|---:|---:|',
    '| 第一章 幌 | 4 | 18,000 | 18,000 |',
    '| 第二章 検定品 | 4 | 18,000 | 36,000 |',
    '',
    '# 第一章　幌',
    '',
    '- **役割** 部室に機械が据わる',
    '',
    '# 第三章　型紙',
  ].join('\n'));
  assert.equal(titles.get(1).title, '幌');
  assert.equal(titles.get(2).title, '検定品', '表の「第二章 検定品」からも拾う');
  assert.equal(titles.get(3).title, '型紙', '見出しだけにある章も拾う');
  assert.ok(![...titles.values()].some((t) => /幕/.test(t.title)), '幕の表は章と取り違えない');
});

test('新しい書式：節の欄は一欄一行、出来事は字下げで続く', () => {
  const metas = parseSectionMeta([
    '# 第一章　幌',
    '',
    '## ch1-01',
    '',
    '- **出来事**',
    '  灯が、祖父の幌屋からミシンを解体し、',
    '  部室に運ぶ。',
    '- **視点** 灯',
    '- **時** 四月上旬。放課後から夜',
    '- **場所** 祖父の幌屋 →（道）→ 部室',
    '- **型** 提示（運搬）',
    '- **引き** ミシンは動くのに、縫うべき物が一つも無い',
    '- **（設計に無い）** 祖父の生死・所在',
    '',
    '## ch1-02',
    '- **視点** 柏木',
  ].join('\n'));
  const one = metas.get('ch1-01');
  assert.equal(one.summary, '灯が、祖父の幌屋からミシンを解体し、部室に運ぶ。', '字下げの続きは一つの文につなぐ');
  assert.equal(one.viewpoint, '灯');
  assert.equal(one.time, '四月上旬。放課後から夜');
  assert.equal(one.place, '祖父の幌屋 →（道）→ 部室');
  assert.equal(one.type, '提示（運搬）');
  assert.equal(one.hook, 'ミシンは動くのに、縫うべき物が一つも無い');
  assert.ok(!one.summary.includes('設計に無い'), '書き手への注はあらすじに混ぜない');
  assert.equal(metas.get('ch1-02').viewpoint, '柏木');
});

test('字数は注を落とした清書から数える（作者の道具と同じ）', () => {
  const text = '<!-- @b1 -->\n　灯は窓を見た。\n\n<!-- 書きかけ：ここは後で -->\n「あ」\n';
  assert.equal(stripNotes(text), '　灯は窓を見た。\n\n「あ」\n');
  assert.equal(countChars(stripNotes(text)), 10);
  const toc = buildToc({ files: [{ path: 'manuscript/ch1/ch1-01.md', text }] });
  assert.equal(toc.chapters[0].sections[0].chars, 10);
  assert.equal(toc.chapters[0].sections[0].opening, '　灯は窓を見た。'.trim(), '目次の冒頭文に印を出さない');
});

test('作品の根（workDir）を置き場の前に付ける', () => {
  const novel = applyWorkDir({
    workDir: 'works/tozan/',
    manuscriptDir: 'manuscript',
    inboxPath: 'review/inbox.md',
    structurePath: 'outline/structure.md',
    sectionsPath: 'outline/sections.md',
  });
  assert.equal(novel.manuscriptDir, 'works/tozan/manuscript');
  assert.equal(novel.inboxPath, 'works/tozan/review/inbox.md');
  assert.equal(sectionPath(novel, 'ch1-01'), 'works/tozan/manuscript/ch1/ch1-01.md');

  const flat = applyWorkDir({ manuscriptDir: 'manuscript', inboxPath: 'review/inbox.md' });
  assert.equal(flat.manuscriptDir, 'manuscript', '根が無ければ今までどおり');

  assert.throws(() => applyWorkDir({ workDir: 'works/../..', manuscriptDir: 'm' }), /使えません/);
});

test('受け取り箱が無ければ、枠の型紙と同じ形で作る', () => {
  const out = insertIntoInbox(null, '- 指摘');
  assert.ok(out.startsWith('# 作者からの指摘'));
  assert.ok(out.indexOf('- 指摘') < out.indexOf('## 済'));
  assert.ok(!out.includes('（なし）'));
});
