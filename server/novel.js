/**
 * 原稿の読み取り（ファイル入出力の側）。
 * 解析そのものは shared/novel.js にあり、Workers 版と同じものを使う。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as git from './git.js';
import { buildToc as buildTocFrom, findSection, withNeighbours, sectionPath } from '../shared/novel.js';

export * from '../shared/novel.js';

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 作業コピーを走査して目次を組む。 */
export async function buildToc(novel) {
  const root = path.join(novel.workdir, novel.manuscriptDir);
  let chapterDirs = [];
  try {
    chapterDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^ch\d+$/.test(d.name))
      .map((d) => d.name);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const files = [];
  for (const dir of chapterDirs) {
    for (const name of await fs.readdir(path.join(root, dir))) {
      if (!/^ch\d+-\d+\.md$/.test(name)) continue;
      files.push({
        path: `${novel.manuscriptDir}/${dir}/${name}`,
        text: await fs.readFile(path.join(root, dir, name), 'utf8'),
      });
    }
  }

  const [structureText, sectionsText] = await Promise.all([
    readIfExists(path.join(novel.workdir, novel.structurePath)),
    readIfExists(path.join(novel.workdir, novel.sectionsPath)),
  ]);

  return buildTocFrom({ files, structureText: structureText || '', sectionsText: sectionsText || '' });
}

/** 本文 1 節ぶん。text は生のまま返し、段落分けは画面側で行う。 */
export async function getSection(novel, sectionId, toc) {
  const rel = sectionPath(novel, sectionId);
  const text = await readIfExists(path.join(novel.workdir, rel));
  if (text == null) return null;
  const commit = await git.lastCommitOf(novel, rel);
  return {
    ...findSection(toc, sectionId),
    text,
    commit,
    ...withNeighbours(toc, sectionId),
  };
}

export async function readInbox(novel) {
  return readIfExists(path.join(novel.workdir, novel.inboxPath));
}

export async function writeInbox(novel, text) {
  const file = path.join(novel.workdir, novel.inboxPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}
