import { randomBytes } from 'node:crypto';
import { users, sessions, newId } from './store.js';
import { SESSION_TTL_MS, SECURE_COOKIE } from './config.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../shared/password.js';

const COOKIE = 'pr_session';

export { hashPassword, verifyPassword };

export async function createUser({ loginId, name, password, role = 'proofreader', email = '' }) {
  const id = String(loginId || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(id)) {
    throw new Error('ログイン ID は英数字・ドット・ハイフン・アンダースコアの 2〜32 文字です');
  }
  if (!password || password.length < 8) throw new Error('パスワードは 8 文字以上にしてください');
  const passwordHash = await hashPassword(password);
  return users.update((data) => {
    if (data.users.some((u) => u.loginId === id)) throw new Error(`ID が既にあります: ${id}`);
    const user = {
      id: newId('usr'),
      loginId: id,
      name: (name || id).trim(),
      email: email.trim(),
      role,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    return publicUser(user);
  });
}

export async function countUsers() {
  const data = await users.read();
  return data.users.length;
}

export async function findByLoginId(loginId) {
  const data = await users.read();
  return data.users.find((u) => u.loginId === String(loginId || '').trim().toLowerCase()) || null;
}

export async function findById(id) {
  const data = await users.read();
  return data.users.find((u) => u.id === id) || null;
}

export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, loginId: user.loginId, name: user.name, email: user.email, role: user.role };
}

export async function authenticate(loginId, password) {
  const user = await findByLoginId(loginId);
  if (!user) {
    // ID が無い場合も同じだけ時間を使い、存在の有無を漏らさない
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user : null;
}

export async function startSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await sessions.update((data) => {
    for (const [key, value] of Object.entries(data.sessions)) {
      if (value.expiresAt < Date.now()) delete data.sessions[key];
    }
    data.sessions[token] = { userId, expiresAt, createdAt: Date.now() };
  });
  return { token, expiresAt };
}

export async function endSession(token) {
  if (!token) return;
  await sessions.update((data) => {
    delete data.sessions[token];
  });
}

export async function sessionUser(token) {
  if (!token) return null;
  const data = await sessions.read();
  const entry = data.sessions[token];
  if (!entry || entry.expiresAt < Date.now()) return null;
  return findById(entry.userId);
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionCookie(token, maxAgeSec) {
  const bits = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (SECURE_COOKIE) bits.push('Secure');
  return bits.join('; ');
}

export const COOKIE_NAME = COOKIE;
