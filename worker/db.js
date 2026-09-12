/** D1（SQLite）への出し入れ。Node 版の data/*.json にあたる。 */

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

const USER_COLUMNS = 'id, login_id AS loginId, name, email, role, password_hash AS passwordHash, created_at AS createdAt';

export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, loginId: user.loginId, name: user.name, email: user.email, role: user.role };
}

export async function countUsers(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  return Number(row?.n || 0);
}

export function userByLogin(db, loginId) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE login_id = ?`).bind(String(loginId || '').trim().toLowerCase()).first();
}

export function userById(db, id) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
}

export async function insertUser(db, user) {
  await db.prepare(
    'INSERT INTO users (id, login_id, name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(user.id, user.loginId, user.name, user.email, user.role, user.passwordHash, user.createdAt).run();
  return user;
}

export async function createSession(db, userId, ttlMs) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(token, userId, now + ttlMs, now).run();
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  return { token, expiresAt: now + ttlMs };
}

export function deleteSession(db, token) {
  if (!token) return Promise.resolve();
  return db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

export async function userForToken(db, token) {
  if (!token) return null;
  const row = await db.prepare(
    `SELECT u.id, u.login_id AS loginId, u.name, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`,
  ).bind(token, Date.now()).first();
  return row || null;
}

export async function getPosition(db, userId, novelId) {
  const row = await db.prepare(
    'SELECT section_id AS sectionId, char_offset AS offset, percent, updated_at AS updatedAt FROM positions WHERE user_id = ? AND novel_id = ?',
  ).bind(userId, novelId).first();
  return row || null;
}

export async function setPosition(db, userId, novelId, position) {
  await db.prepare(
    `INSERT INTO positions (user_id, novel_id, section_id, char_offset, percent, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, novel_id) DO UPDATE SET
       section_id = excluded.section_id, char_offset = excluded.char_offset,
       percent = excluded.percent, updated_at = excluded.updated_at`,
  ).bind(userId, novelId, position.sectionId, position.offset, position.percent, position.updatedAt).run();
  return position;
}

export async function listBookmarks(db, userId, novelId) {
  const { results } = await db.prepare(
    `SELECT id, section_id AS sectionId, char_offset AS offset, quote, note, created_at AS createdAt
       FROM bookmarks WHERE user_id = ? AND novel_id = ? ORDER BY section_id, char_offset`,
  ).bind(userId, novelId).all();
  return results || [];
}

export async function insertBookmark(db, userId, novelId, bookmark) {
  await db.prepare(
    'INSERT INTO bookmarks (id, user_id, novel_id, section_id, char_offset, quote, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(bookmark.id, userId, novelId, bookmark.sectionId, bookmark.offset, bookmark.quote, bookmark.note, bookmark.createdAt).run();
  return bookmark;
}

export function deleteBookmark(db, userId, novelId, id) {
  return db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ? AND novel_id = ?')
    .bind(id, userId, novelId).run();
}

export async function countBookmarks(db, userId, novelId) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = ? AND novel_id = ?')
    .bind(userId, novelId).first();
  return Number(row?.n || 0);
}

const ANNOTATION_COLUMNS = `id, novel_id AS novelId, section_id AS sectionId, section_label AS sectionLabel,
  user_id AS userId, user_name AS userName, created_at AS createdAt, quote, body,
  start_at AS start, end_at AS end, base_sha AS baseSha, status, inbox_commit AS inboxCommit`;

export async function listAnnotations(db, { novelId, sectionId, userId }) {
  let sql = `SELECT ${ANNOTATION_COLUMNS} FROM annotations WHERE novel_id = ?`;
  const binds = [novelId];
  if (sectionId) {
    sql += ' AND section_id = ?';
    binds.push(sectionId);
  }
  if (userId) {
    sql += ' AND user_id = ?';
    binds.push(userId);
  }
  sql += ' ORDER BY created_at DESC';
  const { results } = await db.prepare(sql).bind(...binds).all();
  return results || [];
}

export function getAnnotation(db, novelId, id) {
  return db.prepare(`SELECT ${ANNOTATION_COLUMNS} FROM annotations WHERE id = ? AND novel_id = ?`)
    .bind(id, novelId).first();
}

export async function insertAnnotation(db, a) {
  await db.prepare(
    `INSERT INTO annotations (id, novel_id, section_id, section_label, user_id, user_name, created_at,
       quote, body, start_at, end_at, base_sha, status, inbox_commit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    a.id, a.novelId, a.sectionId, a.sectionLabel, a.userId, a.userName, a.createdAt,
    a.quote, a.body, a.start, a.end, a.baseSha, a.status, a.inboxCommit || '',
  ).run();
  return a;
}

/** 節ごとの字数・冒頭の控え（blob の sha が鍵）。 */
export async function getSectionStats(db, novelId, shas) {
  if (!shas.length) return new Map();
  const holes = shas.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT blob_sha AS sha, chars, opening FROM section_cache WHERE novel_id = ? AND blob_sha IN (${holes})`,
  ).bind(novelId, ...shas).all();
  return new Map((results || []).map((r) => [r.sha, { chars: r.chars, opening: r.opening }]));
}

export async function putSectionStats(db, novelId, rows) {
  for (const row of rows) {
    await db.prepare(
      'INSERT OR REPLACE INTO section_cache (novel_id, blob_sha, chars, opening) VALUES (?, ?, ?, ?)',
    ).bind(novelId, row.sha, row.chars, row.opening).run();
  }
}

export async function getTocCache(db, novelId, headSha) {
  const row = await db.prepare('SELECT json FROM toc_cache WHERE novel_id = ? AND head_sha = ?')
    .bind(novelId, headSha).first();
  return row ? JSON.parse(row.json) : null;
}

export function setTocCache(db, novelId, headSha, toc) {
  return db.prepare(
    `INSERT INTO toc_cache (novel_id, head_sha, json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (novel_id) DO UPDATE SET head_sha = excluded.head_sha, json = excluded.json, updated_at = excluded.updated_at`,
  ).bind(novelId, headSha, JSON.stringify(toc), Date.now()).run();
}

export function clearTocCache(db, novelId) {
  return db.prepare('DELETE FROM toc_cache WHERE novel_id = ?').bind(novelId).run();
}
