import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PORT, HOST, PUBLIC_DIR, DATA_DIR, loadNovels, configPath } from './config.js';
import * as auth from './auth.js';
import * as ws from './workspace.js';
import { routes, HttpError } from './api.js';

const MAX_BODY = 512 * 1024;

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}));

const compiled = routes.map(([method, pattern, handler]) => {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  })}$`);
  return { method, regex, keys, handler };
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '送られた内容が大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 同一オリジンの fetch では付かないことがある
  try {
    const url = new URL(origin);
    return url.host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(res, status, payload, cookies = []) {
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(status, headers);
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let file = target;
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    // SPA なので、拡張子の無い URL は index.html に落とす
    if (path.extname(target)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('見つかりません');
      return;
    }
    file = path.join(PUBLIC_DIR, 'index.html');
  }
  const type = TYPES.get(path.extname(file)) || 'application/octet-stream';
  const cache = /\.(?:css|js|svg|png|woff2)$/.test(file) ? 'no-cache' : 'no-store';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

const OPEN_ROUTES = new Set(['/api/me', '/api/auth/login', '/api/auth/logout', '/api/auth/signup']);

async function handleApi(req, res, url) {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.COOKIE_NAME];
  const user = await auth.sessionUser(token);

  const match = compiled.find((r) => r.method === req.method && r.regex.test(url.pathname));
  if (!match) {
    sendJson(res, 404, { error: 'そのような窓口はありません' });
    return;
  }
  if (req.method !== 'GET' && !sameOrigin(req)) {
    sendJson(res, 403, { error: '別のサイトからの操作は受け付けません' });
    return;
  }
  if (!user && !OPEN_ROUTES.has(url.pathname)) {
    sendJson(res, 401, { error: 'ログインしてください' });
    return;
  }

  const params = {};
  const values = match.regex.exec(url.pathname).slice(1);
  match.keys.forEach((key, i) => { params[key] = decodeURIComponent(values[i]); });

  let body = null;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    const raw = await readBody(req);
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'JSON として読めません' });
        return;
      }
    }
  }

  const setCookies = [];
  const ctx = {
    req,
    res,
    url,
    query: url.searchParams,
    params,
    body,
    user: user ? { ...auth.publicUser(user) } : null,
    token,
    setCookie: (value) => setCookies.push(value),
  };

  try {
    const payload = await match.handler(ctx);
    sendJson(res, 200, payload ?? { ok: true }, setCookies);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[api] ${req.method} ${url.pathname}:`, err);
    sendJson(res, status, { error: err.message || 'サーバ側の不具合です' }, setCookies);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const run = url.pathname.startsWith('/api/')
    ? handleApi(req, res, url)
    : serveStatic(req, res, url.pathname);
  run.catch((err) => {
    console.error('[http]', err);
    if (!res.headersSent) {
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { error: err.message || 'サーバ側の不具合です' });
    } else {
      res.end();
    }
  });
});

async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const novels = loadNovels();
  console.log(`設定: ${configPath()}`);
  console.log(`作品: ${novels.map((n) => `${n.id}(${n.branch})`).join(', ') || 'なし'}`);

  server.listen(PORT, HOST, () => {
    console.log(`校正アプリを http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} で待ち受けます`);
  });

  // クローンは起動を止めずに裏で用意する
  for (const novel of novels) {
    ws.ensureReady(novel)
      .then((s) => console.log(`[${novel.id}] 準備できました HEAD=${s.head?.slice(0, 8)} 節=${s.toc?.sections.length ?? 0}`))
      .catch((err) => console.error(`[${novel.id}] 準備できませんでした: ${err.message}`));
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) {
  main();
}

export { server, main };
