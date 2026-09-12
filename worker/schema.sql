-- 校正室（Cloudflare Workers 版）の D1 スキーマ
-- 初期化: wrangler d1 execute proofreading --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  login_id      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'proofreader',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- 読みかけの位置（校正者 × 作品に 1 つ）
CREATE TABLE IF NOT EXISTS positions (
  user_id     TEXT NOT NULL,
  novel_id    TEXT NOT NULL,
  section_id  TEXT NOT NULL,
  char_offset INTEGER NOT NULL DEFAULT 0,
  percent     REAL NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, novel_id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  novel_id    TEXT NOT NULL,
  section_id  TEXT NOT NULL,
  char_offset INTEGER NOT NULL DEFAULT 0,
  quote       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bookmarks_owner ON bookmarks (user_id, novel_id);

-- inbox.md へ送った指摘の控え（本体は原稿リポジトリ側にある）
CREATE TABLE IF NOT EXISTS annotations (
  id            TEXT PRIMARY KEY,
  novel_id      TEXT NOT NULL,
  section_id    TEXT NOT NULL,
  section_label TEXT NOT NULL DEFAULT '',
  user_id       TEXT NOT NULL,
  user_name     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  quote         TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL,
  start_at      INTEGER,
  end_at        INTEGER,
  base_sha      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',
  inbox_commit  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS annotations_novel ON annotations (novel_id, section_id);
CREATE INDEX IF NOT EXISTS annotations_user ON annotations (novel_id, user_id);

-- 節ごとの字数と冒頭。blob の sha で決まるので、変わった節だけ読み直せばよい
CREATE TABLE IF NOT EXISTS section_cache (
  novel_id TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  chars    INTEGER NOT NULL,
  opening  TEXT NOT NULL,
  PRIMARY KEY (novel_id, blob_sha)
);

-- 目次は本文を全部読まないと作れないので、コミットが変わるまで取っておく
CREATE TABLE IF NOT EXISTS toc_cache (
  novel_id   TEXT PRIMARY KEY,
  head_sha   TEXT NOT NULL,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
