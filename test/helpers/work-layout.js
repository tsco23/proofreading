import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 原稿リポジトリの中に `works/<名前>/` として置かれた作品を作る。
 * 新しい書式（章は「# 第一章　…」の見出し、節の欄は一欄一行）で、
 * 本文にはビートの印（<!-- @b1 -->）を入れておく。受け取り箱はまだ無い。
 */
export const WORK_SECTION = [
  '<!-- @b1 -->',
  '　灯はミシンを台から外した。',
  '',
  '「あ」',
  '<!-- @b2 -->',
  '　錆の割れる音がした。',
  '',
].join('\n');

export async function writeWork(repoDir, name = 'second') {
  const root = path.join(repoDir, 'works', name);
  await fs.mkdir(path.join(root, 'manuscript', 'ch1'), { recursive: true });
  await fs.mkdir(path.join(root, 'outline'), { recursive: true });
  await fs.mkdir(path.join(root, 'review'), { recursive: true });
  await fs.writeFile(path.join(root, 'manuscript', 'ch1', 'ch1-01.md'), WORK_SECTION);
  await fs.writeFile(path.join(root, 'outline', 'structure.md'), [
    '# 章立て', '', '| 章 | 節数 | 字数 | 累計 |', '|---|---:|---:|---:|', '| 第一章 幌 | 2 | 9,000 | 9,000 |', '',
    '# 第一章　幌', '', '- **役割** 部室に機械が据わる', '',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'outline', 'sections.md'), [
    '# 第一章　幌', '',
    '## ch1-01', '- **出来事**', '  灯がミシンを解体し、', '  部室へ運ぶ。',
    '- **視点** 灯', '- **時** 四月上旬', '- **場所** 幌屋', '- **型** 提示', '- **引き** 縫う物が無い',
    '- **（設計に無い）** 祖父の所在', '',
    '## ch1-02', '- **出来事**', '  柏木が壁を明け渡す。', '- **視点** 柏木', '',
  ].join('\n'));
  return root;
}
