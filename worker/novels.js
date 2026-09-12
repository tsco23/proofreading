/** 作品の設定。wrangler.toml の vars.NOVELS（JSON 文字列）から読む。 */

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

export function loadNovels(env) {
  let raw;
  try {
    raw = env.NOVELS ? JSON.parse(env.NOVELS) : { novels: [] };
  } catch (err) {
    throw new Error(`NOVELS の JSON が読めません: ${err.message}`);
  }
  const list = Array.isArray(raw) ? raw : raw.novels || [];
  return list.map((item) => {
    if (!item.id || !/^[A-Za-z0-9._-]+$/.test(item.id)) {
      throw new Error(`作品の id が不正です: ${JSON.stringify(item.id)}`);
    }
    return { ...DEFAULTS, ...item, ...parseRepo(item), title: item.title || item.id };
  });
}

export function getNovel(env, id) {
  return loadNovels(env).find((n) => n.id === id) || null;
}
