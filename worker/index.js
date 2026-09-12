/**
 * Cloudflare Workers の入口。
 * /api/* はここで処理し、それ以外は静的アセット（public/）を返す。
 */
import { routes, HttpError } from './api.js';
import { GitHub, GitHubError } from './github.js';
import { userForToken } from './db.js';

const compiled = routes.map(([method, pattern, handler]) => {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  })}$`);
  return { method, regex, keys, handler };
});

const OPEN_ROUTES = new Set(['/api/me', '/api/auth/login', '/api/auth/logout', '/api/auth/signup']);

function json(payload, { status = 200, cookies = [] } = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(payload), { status, headers });
}

function cookieValue(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

async function handleApi(request, env, url) {
  if (!env.DB) return json({ error: 'D1（DB）が結び付けられていません' }, { status: 500 });
  if (!env.GITHUB_TOKEN) return json({ error: 'GITHUB_TOKEN が設定されていません' }, { status: 500 });

  const match = compiled.find((r) => r.method === request.method && r.regex.test(url.pathname));
  if (!match) return json({ error: 'そのような窓口はありません' }, { status: 404 });
  if (request.method !== 'GET' && !sameOrigin(request, url)) {
    return json({ error: '別のサイトからの操作は受け付けません' }, { status: 403 });
  }

  const token = cookieValue(request, 'pr_session');
  const user = await userForToken(env.DB, token);
  if (!user && !OPEN_ROUTES.has(url.pathname)) {
    return json({ error: 'ログインしてください' }, { status: 401 });
  }

  const params = {};
  const values = match.regex.exec(url.pathname).slice(1);
  match.keys.forEach((key, i) => { params[key] = decodeURIComponent(values[i]); });

  let body = null;
  if (request.method !== 'GET' && request.method !== 'DELETE') {
    const raw = await request.text();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: 'JSON として読めません' }, { status: 400 });
      }
    }
  }

  const cookies = [];
  const ctx = {
    env,
    db: env.DB,
    gh: new GitHub({ token: env.GITHUB_TOKEN, apiBase: env.GITHUB_API_BASE || 'https://api.github.com' }),
    request,
    url,
    query: url.searchParams,
    params,
    body,
    user,
    token,
    setCookie: (value) => cookies.push(value),
  };

  try {
    const payload = await match.handler(ctx);
    return json(payload ?? { ok: true }, { cookies });
  } catch (err) {
    let status = 500;
    if (err instanceof HttpError) status = err.status;
    else if (err instanceof GitHubError) status = err.status === 404 ? 404 : 502;
    if (status >= 500) console.error(`[api] ${request.method} ${url.pathname}`, err);
    return json({ error: err.message || 'サーバ側の不具合です' }, { status, cookies });
  }
}

async function handleAsset(request, env, url) {
  if (!env.ASSETS) return new Response('静的アセットが結び付けられていません', { status: 500 });
  const res = await env.ASSETS.fetch(request);
  if (res.status !== 404) return res;
  // 拡張子の無い URL は画面側の道筋なので、index.html を返す
  if (/\.[a-z0-9]+$/i.test(url.pathname)) return res;
  return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    return handleAsset(request, env, url);
  },
};
