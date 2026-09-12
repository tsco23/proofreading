import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import worker from '../worker/index.js';
import { createD1 } from './helpers/d1.js';
import { startFakeGitHub } from './helpers/fake-github.js';

const run = promisify(execFile);
const BRANCH = 'main';

async function makeRepo(root) {
  const dir = path.join(root, 'novel');
  const git = (args) => run('git', args, { cwd: dir });
  await fs.mkdir(dir, { recursive: true });
  await run('git', ['init', `--initial-branch=${BRANCH}`, dir]);
  await git(['config', 'user.email', 'author@example.invalid']);
  await git(['config', 'user.name', '作者']);

  await fs.mkdir(path.join(dir, 'manuscript', 'ch1'), { recursive: true });
  await fs.mkdir(path.join(dir, 'outline'), { recursive: true });
  await fs.mkdir(path.join(dir, 'review'), { recursive: true });
  await fs.writeFile(path.join(dir, 'manuscript/ch1/ch1-01.md'),
    '　湊は窓の外を見た。\n\n「山です」\n「授業中もでしょ」\n\n　女子は笑った。\n');
  await fs.writeFile(path.join(dir, 'manuscript/ch1/ch1-02.md'),
    '　部室の匂いは灯油だった。\n\n　戸倉が地図を広げた。\n');
  await fs.writeFile(path.join(dir, 'outline/structure.md'),
    '# 章立て\n\n| 章 | 題 | 時期 | 節数 | 役割 |\n|---|---|---|---:|---|\n| 一 | 出遅れ | 4月 | 2 | 提示 |\n');
  await fs.writeFile(path.join(dir, 'outline/sections.md'),
    ['# 第一章 出遅れ', '', '## ch1-01', '- **視点** 湊／**時** 四月／**場所** 教室', '- 窓の山を見る。', '',
      '## ch1-02', '- **視点** 湊／**時** 四月／**場所** 部室', '- 部室に入る。', '',
      '## ch1-03', '- **視点** 樹／**時** 四月下旬／**場所** 雨宮家', '- まだ書かれていない節。', ''].join('\n'));
  await fs.writeFile(path.join(dir, 'review/inbox.md'),
    ['# レビュー指摘の受け取り箱', '', '## 未対応', '', '（なし）', '', '## 済', '', '- 前に直した件', ''].join('\n'));
  await git(['add', '-A']);
  await git(['commit', '-m', '種']);
  return dir;
}

test('Workers 版：ログインから指摘の書き戻し、前後の比較まで', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofreading-worker-'));
  const workdir = await makeRepo(root);
  const github = await startFakeGitHub({ workdir, owner: 'tsco23', repo: 'novel1', branch: BRANCH });
  const schema = await fs.readFile(new URL('../worker/schema.sql', import.meta.url), 'utf8');
  const db = createD1(schema);

  const env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('画面', { status: 200 }) },
    GITHUB_TOKEN: 'test-token',
    GITHUB_API_BASE: github.base,
    NOVELS: JSON.stringify({
      novels: [{ id: 'novel1', title: '試験作品', repo: 'https://github.com/tsco23/novel1', branch: BRANCH }],
    }),
    SECURE_COOKIE: '0',
    PBKDF2_ITERATIONS: '1000',
  };

  t.after(async () => {
    await github.close();
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  let cookie = '';
  const call = async (method, url, body) => {
    const res = await worker.fetch(new Request(`https://example.test${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }), env);
    const setCookie = res.headers.getSetCookie?.()[0];
    if (setCookie) cookie = setCookie.split(';')[0];
    const payload = await res.json().catch(() => null);
    return { status: res.status, payload };
  };

  await t.test('ログイン前は読めない', async () => {
    assert.equal((await call('GET', '/api/novels')).status, 401);
  });

  await t.test('最初の校正者を登録できる', async () => {
    const me = await call('GET', '/api/me');
    assert.equal(me.payload.signup.bootstrap, true);
    assert.equal(typeof me.payload.version, 'string', '動いている版を返す');
    const res = await call('POST', '/api/auth/signup', { loginId: 'kato', name: '加藤', password: 'password123' });
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.user.role, 'admin');
  });

  await t.test('目次が自動で組み上がる', async () => {
    const res = await call('GET', '/api/novels/novel1/toc');
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    const { toc } = res.payload;
    assert.equal(toc.chapters[0].label, '第一章 出遅れ');
    assert.deepEqual(toc.sections, ['ch1-01', 'ch1-02']);
    assert.equal(toc.chapters[0].sections[0].viewpoint, '湊');
    assert.equal(toc.planned[0].id, 'ch1-03');
  });

  await t.test('二度目の目次は D1 の控えで済む（GitHub を叩き直さない）', async () => {
    const before = github.calls.filter((c) => c.includes('/git/blobs/')).length;
    await call('GET', '/api/novels/novel1/toc');
    const after = github.calls.filter((c) => c.includes('/git/blobs/')).length;
    assert.equal(after, before, '本文の再取得が起きない');
  });

  await t.test('本文が読める', async () => {
    const res = await call('GET', '/api/novels/novel1/sections/ch1-01');
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    assert.match(res.payload.section.text, /窓の外を見た/);
    assert.equal(res.payload.section.next, 'ch1-02');
  });

  await t.test('節 ID を偽っても外へ出られない', async () => {
    const res = await call('GET', '/api/novels/novel1/sections/..%2F..%2Fetc%2Fpasswd');
    assert.equal(res.status, 400);
  });

  let annotationId = null;

  await t.test('指摘が inbox.md へ書かれ、コミットになる', async () => {
    const res = await call('POST', '/api/novels/novel1/annotations', {
      sectionId: 'ch1-01',
      quote: '窓の外を見た',
      start: 1,
      end: 7,
      body: 'ここは「窓の外」より「窓」だけでよいのでは。',
    });
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.commit.pushed, true);
    annotationId = res.payload.annotation.id;

    const { stdout } = await run('git', ['show', `${BRANCH}:review/inbox.md`], { cwd: workdir });
    assert.match(stdout, /- \*\*ch1-01\*\*（第一章 第一節）／加藤／/);
    assert.match(stdout, /> 窓の外を見た/);
    assert.ok(!stdout.includes('（なし）'));
    assert.ok(stdout.indexOf(annotationId) < stdout.indexOf('## 済'));
    assert.match(stdout, /- 前に直した件/);

    const log = await run('git', ['log', '-1', '--format=%s%n%an'], { cwd: workdir });
    assert.match(log.stdout, /校正指摘: ch1-01（加藤）/);
    assert.match(log.stdout, /加藤/, 'コミットの著者は校正者');
  });

  await t.test('指摘は目次と本文に返ってくる', async () => {
    const section = await call('GET', '/api/novels/novel1/sections/ch1-01');
    assert.equal(section.payload.annotations.length, 1);
    assert.equal(section.payload.annotations[0].status, 'open');
    const toc = await call('GET', '/api/novels/novel1/toc');
    assert.equal(toc.payload.toc.chapters[0].sections[0].annotations.open, 1);
  });

  await t.test('中身の無い指摘は断られる', async () => {
    const res = await call('POST', '/api/novels/novel1/annotations', { sectionId: 'ch1-01', body: '  ' });
    assert.equal(res.status, 400);
  });

  await t.test('作者が直したら、前後を比べられる', async () => {
    await fs.writeFile(path.join(workdir, 'manuscript/ch1/ch1-01.md'),
      '　湊は窓を見た。\n\n「山です」\n「授業中もでしょ」\n\n　女子は声を立てて笑った。\n');
    await run('git', ['commit', '-am', 'ch1-01 を直す'], { cwd: workdir });

    await call('POST', '/api/novels/novel1/sync', {});
    const res = await call('GET', `/api/novels/novel1/annotations/${annotationId}/compare`);
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.changed, true);
    assert.equal(res.payload.diff.stats.rewritten, 2);
    assert.equal(res.payload.before.quoteAt.exact, true);
    assert.ok(!res.payload.after.quoteAt?.exact);
    assert.equal(res.payload.commits[0].subject, 'ch1-01 を直す');
  });

  await t.test('節が増えても、読み直すのは増えた節だけ', async () => {
    await fs.writeFile(path.join(workdir, 'manuscript/ch1/ch1-03.md'), '　樹は玄関に立っていた。\n');
    await run('git', ['add', '-A'], { cwd: workdir });
    await run('git', ['commit', '-m', 'ch1-03 を書く'], { cwd: workdir });

    const before = github.calls.filter((c) => c.includes('/git/blobs/')).length;
    const res = await call('POST', '/api/novels/novel1/sync', {});
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    const after = github.calls.filter((c) => c.includes('/git/blobs/')).length;
    assert.equal(after - before, 1, '新しい節 1 つぶんしか読まない');

    const toc = await call('GET', '/api/novels/novel1/toc');
    assert.deepEqual(toc.payload.toc.sections, ['ch1-01', 'ch1-02', 'ch1-03']);
    assert.equal(toc.payload.toc.planned.length, 0, '書かれた節は「これから」から外れる');
  });

  await t.test('作者が済へ移すと、対応済みとして見える', async () => {
    const inboxPath = path.join(workdir, 'review/inbox.md');
    const lines = (await fs.readFile(inboxPath, 'utf8')).split('\n');
    const head = lines.findIndex((l) => l.startsWith('## 未対応'));
    const done = lines.findIndex((l) => l.startsWith('## 済'));
    await fs.writeFile(inboxPath, [
      ...lines.slice(0, head + 1), '',
      ...lines.slice(done),
      ...lines.slice(head + 1, done).filter((l) => l.trim()),
    ].join('\n'));
    await run('git', ['commit', '-am', '指摘に対応した'], { cwd: workdir });

    const res = await call('GET', '/api/novels/novel1/annotations?section=ch1-01');
    assert.equal(res.payload.annotations[0].status, 'resolved');
  });

  await t.test('読みかけとしおりが残る', async () => {
    await call('PUT', '/api/state/novel1/position', { sectionId: 'ch1-02', offset: 12, percent: 0.4 });
    const mark = await call('POST', '/api/state/novel1/bookmarks', { sectionId: 'ch1-02', offset: 12, quote: '灯油' });
    assert.equal(mark.status, 200, JSON.stringify(mark.payload));

    const state = await call('GET', '/api/state/novel1');
    assert.equal(state.payload.position.sectionId, 'ch1-02');
    assert.equal(state.payload.bookmarks.length, 1);

    const novels = await call('GET', '/api/novels');
    assert.equal(novels.payload.novels[0].position.sectionId, 'ch1-02');
    assert.equal(novels.payload.novels[0].bookmarks, 1);
    assert.equal(novels.payload.novels[0].sections, 3, '一覧の節数は目次と揃う');

    await call('DELETE', `/api/state/novel1/bookmarks/${mark.payload.bookmark.id}`);
    assert.equal((await call('GET', '/api/state/novel1')).payload.bookmarks.length, 0);
  });

  await t.test('招待コードを設けたら、最初の一人にも要る', async () => {
    const guarded = { ...env, DB: createD1(schema), INVITE_CODE: 'yamanoue' };
    const post = (body) => worker.fetch(new Request('https://example.test/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), guarded);

    const me = await worker.fetch(new Request('https://example.test/api/me'), guarded);
    const status = await me.json();
    assert.equal(status.signup.bootstrap, true, 'まだ誰も居ない');
    assert.equal(status.signup.needsInvite, true, 'それでも合言葉は要る');

    const refused = await post({ loginId: 'stranger', name: '通りすがり', password: 'password123' });
    assert.equal(refused.status, 403, '合言葉なしでは管理者になれない');

    const ok = await post({ loginId: 'kato', name: '加藤', password: 'password123', inviteCode: 'yamanoue' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).user.role, 'admin');
  });

  await t.test('別の校正者は招待コードが要る', async () => {
    const res = await call('POST', '/api/auth/signup', { loginId: 'chino', name: '茅野', password: 'password123' });
    assert.equal(res.status, 403);
  });

  await t.test('招待コードがあれば二人目も入れる', async () => {
    const invited = { ...env, INVITE_CODE: 'yamanoue' };
    const res = await worker.fetch(new Request('https://example.test/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: 'chino', name: '茅野', password: 'password123', inviteCode: 'yamanoue' }),
    }), invited);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.role, 'proofreader');
  });

  await t.test('別のサイトからの書き込みは弾く', async () => {
    const res = await worker.fetch(new Request('https://example.test/api/state/novel1/position', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: cookie },
      body: JSON.stringify({ sectionId: 'ch1-01' }),
    }), env);
    assert.equal(res.status, 403);
  });

  await t.test('画面は静的アセットから返る', async () => {
    const res = await worker.fetch(new Request('https://example.test/'), env);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '画面');
  });

  await t.test('出ると読めなくなる', async () => {
    await call('POST', '/api/auth/logout', {});
    assert.equal((await call('GET', '/api/novels/novel1/toc')).status, 401);
  });
});
