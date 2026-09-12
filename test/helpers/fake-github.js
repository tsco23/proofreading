import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * GitHub の API のうち、このアプリが使う分だけを本物の git リポジトリの上で真似る。
 * 中身は本物の git なので、コミット・sha・履歴の振る舞いは実物と同じになる。
 */
export async function startFakeGitHub({ workdir, owner, repo, branch }) {
  const git = (args, cwd = workdir) => run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  const prefix = `/repos/${owner}/${repo}`;
  const calls = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const accept = req.headers.accept || '';
    calls.push(`${req.method} ${url.pathname}`);

    const send = (status, payload, raw = false) => {
      const body = raw ? payload : JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json' });
      res.end(body);
    };

    try {
      if (!url.pathname.startsWith(prefix)) return send(404, { message: 'Not Found' });
      if (!req.headers.authorization?.startsWith('Bearer ')) return send(401, { message: 'Bad credentials' });
      const rest = url.pathname.slice(prefix.length);

      // ブランチの先端
      const commitRef = rest.match(/^\/commits\/(.+)$/);
      if (req.method === 'GET' && commitRef && accept.includes('.sha')) {
        const { stdout } = await git(['rev-parse', decodeURIComponent(commitRef[1])]);
        return send(200, stdout.trim(), true);
      }

      // ファイルの履歴
      if (req.method === 'GET' && rest === '/commits') {
        const path = url.searchParams.get('path');
        const sha = url.searchParams.get('sha') || branch;
        const limit = url.searchParams.get('per_page') || '20';
        const { stdout } = await git(['log', `-${limit}`, '--format=%H%x00%aI%x00%an%x00%s', sha, '--', path]);
        const list = stdout.split('\n').filter(Boolean).map((line) => {
          const [id, date, author, subject] = line.split('\0');
          return { sha: id, commit: { author: { date, name: author }, message: subject } };
        });
        return send(200, list);
      }

      // 木（目次づくり）
      const tree = rest.match(/^\/git\/trees\/(.+)$/);
      if (req.method === 'GET' && tree) {
        const { stdout } = await git(['ls-tree', '-r', decodeURIComponent(tree[1])]);
        const entries = stdout.split('\n').filter(Boolean).map((line) => {
          const [meta, path] = line.split('\t');
          const [, type, sha] = meta.split(/\s+/);
          return { path, type: type === 'blob' ? 'blob' : type, sha };
        });
        return send(200, { tree: entries });
      }

      // blob
      const blob = rest.match(/^\/git\/blobs\/(.+)$/);
      if (req.method === 'GET' && blob) {
        const { stdout } = await git(['cat-file', 'blob', blob[1]]);
        return send(200, { encoding: 'base64', content: Buffer.from(stdout, 'utf8').toString('base64') });
      }

      // ファイルの中身
      const contents = rest.match(/^\/contents\/(.+)$/);
      if (contents) {
        const path = decodeURIComponent(contents[1]);
        const ref = url.searchParams.get('ref') || branch;

        if (req.method === 'GET') {
          let text;
          try {
            ({ stdout: text } = await git(['show', `${ref}:${path}`]));
          } catch {
            return send(404, { message: 'Not Found' });
          }
          if (accept.includes('raw')) return send(200, text, true);
          const { stdout: sha } = await git(['rev-parse', `${ref}:${path}`]);
          return send(200, {
            sha: sha.trim(),
            encoding: 'base64',
            content: Buffer.from(text, 'utf8').toString('base64'),
          });
        }

        if (req.method === 'PUT') {
          const raw = await new Promise((resolve) => {
            let data = '';
            req.on('data', (c) => { data += c; });
            req.on('end', () => resolve(data));
          });
          const payload = JSON.parse(raw);
          let currentSha = null;
          try {
            const { stdout } = await git(['rev-parse', `${branch}:${path}`]);
            currentSha = stdout.trim();
          } catch { /* 新規ファイル */ }
          if ((payload.sha || null) !== currentSha) {
            return send(409, { message: 'is at ' + currentSha + ' but expected ' + payload.sha });
          }
          const fs = await import('node:fs/promises');
          const nodePath = await import('node:path');
          const file = nodePath.join(workdir, path);
          await fs.mkdir(nodePath.dirname(file), { recursive: true });
          await fs.writeFile(file, Buffer.from(payload.content, 'base64'));
          await git(['add', '--', path]);
          const author = payload.author || { name: 'bot', email: 'bot@example.invalid' };
          await git([
            '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,
            'commit', '--author', `${author.name} <${author.email}>`, '-m', payload.message,
          ]);
          const { stdout: head } = await git(['rev-parse', 'HEAD']);
          const { stdout: blobSha } = await git(['rev-parse', `HEAD:${path}`]);
          return send(200, { commit: { sha: head.trim() }, content: { sha: blobSha.trim() } });
        }
      }

      return send(404, { message: 'Not Found' });
    } catch (err) {
      send(500, { message: err.message });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
