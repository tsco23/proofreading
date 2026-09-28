/**
 * 作品の一覧（自前サーバ版）。
 * 明示した作品に加え、置き場（worksDir）の下の作品を作業コピーから拾う。
 * 原稿側で作品を増やしても、設定は書き換えなくてよい。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import * as git from './git.js';
import { applyWorkDir } from '../shared/novel.js';
import { discoverWorks, parseSimpleToml, currentWork, expandLibrary } from '../shared/works.js';

const SYNC_INTERVAL_MS = Number(process.env.PROOFREADING_SYNC_SEC || 120) * 1000;
const scanned = new Map(); // 作業コピー → { at, novels }

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function scan(lib, { fresh }) {
  const hit = scanned.get(lib.workdir);
  if (hit && !fresh && Date.now() - hit.at < SYNC_INTERVAL_MS) return hit.novels;

  const novels = await git.withRepoLock(lib.workdir, async () => {
    await git.ensureClone(lib);
    await git.sync(lib);
    const worksDir = lib.worksDir.replace(/^\/+|\/+$/g, '');
    const root = path.join(lib.workdir, worksDir);
    const paths = [];
    for (const dir of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory()) continue;
      for (const child of await fs.readdir(path.join(root, dir.name)).catch(() => [])) {
        paths.push(`${worksDir}/${dir.name}/${child}`);
      }
    }
    const names = discoverWorks(paths, worksDir);
    const current = currentWork(await readIfExists(path.join(lib.workdir, 'work.toml')));
    const inputs = {};
    for (const name of names) {
      const text = await readIfExists(path.join(root, name, 'input.toml'));
      if (text != null) inputs[name] = parseSimpleToml(text);
    }
    return expandLibrary(lib, { names, inputs, current })
      .map((n) => ({ ...applyWorkDir(n), workdir: lib.workdir }));
  });
  scanned.set(lib.workdir, { at: Date.now(), novels });
  return novels;
}

/** 作品の一覧。名前が重なれば明示した作品を優先する。 */
export async function listNovels({ fresh = false } = {}) {
  const { novels, libraries } = loadConfig();
  const out = [...novels];
  for (const lib of libraries) {
    try {
      out.push(...await scan(lib, { fresh }));
    } catch (err) {
      console.error(`[${lib.id}] 作品を拾えませんでした: ${err.message}`);
    }
  }
  const seen = new Set();
  return out.filter((n) => (seen.has(n.id) ? false : seen.add(n.id)));
}

/** 増えた直後の作品も開けるよう、見つからなければ一度だけ取り直す。 */
export async function getNovel(id) {
  const hit = (await listNovels()).find((n) => n.id === id);
  if (hit) return hit;
  return (await listNovels({ fresh: true })).find((n) => n.id === id) || null;
}
