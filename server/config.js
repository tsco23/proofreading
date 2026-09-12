import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = process.env.PROOFREADING_DATA_DIR
  ? path.resolve(process.env.PROOFREADING_DATA_DIR)
  : path.join(ROOT, 'data');

export const PUBLIC_DIR = path.join(ROOT, 'public');
export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspaces');

/**
 * この版の目印。画面が古いままかを見分けるのに使う。
 * 自前で動かすときは起動ごとに変わる（入れ替えれば変わる）。
 */
export const APP_VERSION = process.env.PROOFREADING_VERSION
  || `local-${Math.floor(Date.now() / 1000).toString(36)}`;

export const PORT = Number(process.env.PORT || 8787);
export const HOST = process.env.HOST || '0.0.0.0';

/** 招待コード。設定されているときだけ自己登録の画面が開く。 */
export const INVITE_CODE = process.env.PROOFREADING_INVITE_CODE || '';

/** セッションの寿命（既定 30 日）。 */
export const SESSION_TTL_MS = Number(process.env.PROOFREADING_SESSION_DAYS || 30) * 86400_000;

/** 本番で https の後ろに置くときは 1。Cookie に Secure が付く。 */
export const SECURE_COOKIE = process.env.PROOFREADING_SECURE_COOKIE === '1';

const DEFAULTS = {
  branch: 'main',
  manuscriptDir: 'manuscript',
  inboxPath: 'review/inbox.md',
  structurePath: 'outline/structure.md',
  sectionsPath: 'outline/sections.md',
  push: true,
};

function configFile() {
  if (process.env.PROOFREADING_NOVELS) return path.resolve(process.env.PROOFREADING_NOVELS);
  const local = path.join(ROOT, 'config', 'novels.json');
  if (fs.existsSync(local)) return local;
  return path.join(ROOT, 'config', 'novels.default.json');
}

function normalize(raw, file) {
  if (!raw.id || !/^[A-Za-z0-9._-]+$/.test(raw.id)) {
    throw new Error(`${file}: novel の id が不正です: ${JSON.stringify(raw.id)}`);
  }
  if (!raw.repo && !raw.localPath) {
    throw new Error(`${file}: ${raw.id} に repo か localPath のどちらかが要ります`);
  }
  const novel = { ...DEFAULTS, ...raw };
  novel.title = novel.title || novel.id;
  if (novel.localPath) novel.localPath = path.resolve(ROOT, novel.localPath);
  novel.workdir = novel.localPath || path.join(WORKSPACE_DIR, novel.id);
  return novel;
}

let cache = null;

export function loadNovels({ reload = false } = {}) {
  if (cache && !reload) return cache;
  const file = configFile();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed.novels;
  if (!Array.isArray(list)) throw new Error(`${file}: novels 配列が見つかりません`);
  cache = list.map((raw) => normalize(raw, file));
  const ids = new Set();
  for (const n of cache) {
    if (ids.has(n.id)) throw new Error(`${file}: id が重複しています: ${n.id}`);
    ids.add(n.id);
  }
  return cache;
}

export function getNovel(id) {
  return loadNovels().find((n) => n.id === id) || null;
}

export function configPath() {
  return configFile();
}
