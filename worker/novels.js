/**
 * 作品の設定。wrangler.toml の vars.NOVELS（JSON 文字列）から読む。
 *
 * 書き方は二通り。
 *   作品を一つずつ書く … { "id": "tozan", "repo": "…", "workDir": "works/tozan", … }
 *   置き場を書く       … { "repo": "…", "branch": "…", "worksDir": "works" }
 * 置き場を書いておけば、原稿側で作品を増やしてもここは書き換えなくてよい。
 * その下の作品を GitHub から拾って並べる（shared/works.js）。
 */
import { applyWorkDir } from '../shared/novel.js';
import { discoverWorks, parseSimpleToml, currentWork, expandLibrary } from '../shared/works.js';
import * as repo from './repo.js';

const DEFAULTS = {
  branch: 'main',
  manuscriptDir: 'manuscript',
  inboxPath: 'review/inbox.md',
  structurePath: 'outline/structure.md',
  sectionsPath: 'outline/sections.md',
};

function parseRepo(raw) {
  if (raw.owner && raw.name) return { owner: raw.owner, repo: raw.name, url: raw.url || `https://github.com/${raw.owner}/${raw.name}` };
  const url = String(raw.repo || raw.url || '');
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?\/?$/);
  if (!m) throw new Error(`repo を owner/name に分解できません: ${url}`);
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` };
}

/** 設定を「作品」と「置き場」に分けて読む。 */
export function loadEntries(env) {
  let raw;
  try {
    raw = env.NOVELS ? JSON.parse(env.NOVELS) : { novels: [] };
  } catch (err) {
    throw new Error(`NOVELS の JSON が読めません: ${err.message}`);
  }
  const list = Array.isArray(raw) ? raw : raw.novels || [];
  const novels = [];
  const libraries = [];
  for (const item of list) {
    if (item.worksDir && !item.id) {
      libraries.push({ ...DEFAULTS, ...item, ...parseRepo(item) });
      continue;
    }
    if (!item.id || !/^[A-Za-z0-9._-]+$/.test(item.id)) {
      throw new Error(`作品の id が不正です: ${JSON.stringify(item.id)}`);
    }
    novels.push(applyWorkDir({ ...DEFAULTS, ...item, ...parseRepo(item), title: item.title || item.id }));
  }
  return { novels, libraries };
}

/** 置き場の下の作品を、いまの枝の先端から拾う。 */
async function scan(gh, lib, { fresh }) {
  const headSha = await repo.head(gh, lib, { fresh });
  const entries = await repo.tree(gh, lib, headSha, { fresh });
  const names = discoverWorks(entries.map((e) => e.path), lib.worksDir);
  const sha = (p) => entries.find((e) => e.path === p)?.sha;

  const workToml = sha('work.toml');
  const current = workToml ? currentWork(await repo.blobText(gh, lib, workToml)) : null;
  const inputs = {};
  await Promise.all(names.map(async (name) => {
    const s = sha(`${lib.worksDir.replace(/\/+$/, '')}/${name}/input.toml`);
    if (s) inputs[name] = parseSimpleToml(await repo.blobText(gh, lib, s));
  }));
  return expandLibrary(lib, { names, inputs, current }).map((n) => applyWorkDir(n));
}

/** 作品の一覧。明示した作品と、置き場から拾った作品。名前が重なれば明示を優先する。 */
export async function listNovels(env, gh, { fresh = false } = {}) {
  const { novels, libraries } = loadEntries(env);
  const out = [...novels];
  for (const lib of libraries) out.push(...await scan(gh, lib, { fresh }));
  const seen = new Set();
  return out.filter((n) => (seen.has(n.id) ? false : seen.add(n.id)));
}

/** 増えた直後の作品も開けるよう、見つからなければ一度だけ取り直す。 */
export async function getNovel(env, gh, id) {
  const hit = (await listNovels(env, gh)).find((n) => n.id === id);
  if (hit) return hit;
  return (await listNovels(env, gh, { fresh: true })).find((n) => n.id === id) || null;
}
