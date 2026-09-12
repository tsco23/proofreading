/**
 * パスワードのハッシュ。
 * Node にも Cloudflare Workers にもある Web Crypto（PBKDF2-SHA256）だけで作ってあるので、
 * どちらで作った校正者のデータもそのまま通る。
 */

const DEFAULT_ITERATIONS = 100_000;
const KEY_BITS = 256;

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(text) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS);
}

export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, iterations);
  return `pbkdf2$${iterations}$${hex(salt)}$${hex(bits)}`;
}

/** 突き合わせは、長さも中身も一定時間で比べる。 */
export async function verifyPassword(password, stored) {
  const [scheme, iterations, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'pbkdf2' || !saltHex || !hashHex) return false;
  const rounds = Number(iterations);
  if (!Number.isInteger(rounds) || rounds < 1000 || rounds > 5_000_000) return false;
  const bits = new Uint8Array(await derive(password, unhex(saltHex), rounds));
  const expected = unhex(hashHex);
  if (expected.length !== bits.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i += 1) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

/** ID が無いときも同じだけ時間を使い、存在の有無を漏らさないための当て馬。 */
export const DUMMY_HASH = `pbkdf2$${DEFAULT_ITERATIONS}$${'0'.repeat(32)}$${'0'.repeat(64)}`;
