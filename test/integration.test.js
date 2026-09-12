import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = (args, cwd) => run('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

/** 本物の原稿には触らずに済むよう、試験用のリポジトリをその場で作る。 */
async function makeFixture(root) {
  const remote = path.join(root, 'novel.git');
  const seed = path.join(root, 'seed');
  await git(['init', '--bare', '--initial-branch=main', remote]);
  await git(['clone', remote, seed]);
  await git(['config', 'user.email', 'test@example.invalid'], seed);
  await git(['config', 'user.name', '試験'], seed);

  await fs.mkdir(path.join(seed, 'manuscript', 'ch1'), { recursive: true });
  await fs.mkdir(path.join(seed, 'outline'), { recursive: true });
  await fs.mkdir(path.join(seed, 'review'), { recursive: true });
  await fs.writeFile(
    path.join(seed, 'manuscript', 'ch1', 'ch1-01.md'),
    '　湊は窓の外を見た。\n\n「山です」\n「授業中もでしょ」\n\n　女子は笑った。\n',
  );
  await fs.writeFile(
    path.join(seed, 'manuscript', 'ch1', 'ch1-02.md'),
    '　部室の匂いは灯油だった。\n\n　戸倉が地図を広げた。\n',
  );
  await fs.writeFile(
    path.join(seed, 'outline', 'structure.md'),
    ['# 章立て', '', '| 章 | 題 | 時期 | 節数 | 役割 |', '|---|---|---|---:|---|', '| 一 | 出遅れ | 4月 | 2 | 提示 |'].join('\n'),
  );
  await fs.writeFile(
    path.join(seed, 'outline', 'sections.md'),
    ['# 第一章 出遅れ', '', '## ch1-01', '- **視点** 湊／**時** 四月／**場所** 教室', '- 窓の山を見る。', '',
      '## ch1-02', '- **視点** 湊／**時** 四月／**場所** 部室', '- 部室に入る。', '',
      '## ch1-03', '- **視点** 樹／**時** 四月下旬／**場所** 雨宮家', '- まだ書かれていない節。'].join('\n'),
  );
  await fs.writeFile(
    path.join(seed, 'review', 'inbox.md'),
    ['# レビュー指摘の受け取り箱', '', '## 未対応', '', '（なし）', '', '## 済', '', '- 前に直した件', ''].join('\n'),
  );
  await git(['add', '-A'], seed);
  await git(['commit', '-m', '種'], seed);
  await git(['push', 'origin', 'main'], seed);
  return { remote, seed };
}

async function startServer(root, remote) {
  const novelsFile = path.join(root, 'novels.json');
  await fs.writeFile(novelsFile, JSON.stringify({
    novels: [{ id: 'testnovel', title: '試験作品', repo: remote, branch: 'main', push: true }],
  }));
  process.env.PROOFREADING_NOVELS = novelsFile;
  process.env.PROOFREADING_DATA_DIR = path.join(root, 'data');
  process.env.PROOFREADING_SYNC_SEC = '0';

  const { server } = await import('../server/index.js');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

test('ログインから指摘の書き戻し、前後の比較まで', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proofreading-'));
  const { remote, seed } = await makeFixture(root);
  const { server, base } = await startServer(root, remote);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.()[0];
    if (setCookie) cookie = setCookie.split(';')[0];
    const payload = await res.json().catch(() => null);
    return { status: res.status, payload };
  };

  await t.test('ログイン前は本文を読めない', async () => {
    const res = await call('GET', '/api/novels');
    assert.equal(res.status, 401);
  });

  await t.test('最初の校正者を登録できる', async () => {
    const me = await call('GET', '/api/me');
    assert.equal(me.payload.signup.bootstrap, true);
    const res = await call('POST', '/api/auth/signup', { loginId: 'kato', name: '加藤', password: 'password123' });
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.user.name, '加藤');
  });

  await t.test('目次が自動で組み上がる', async () => {
    const res = await call('GET', '/api/novels/testnovel/toc');
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    const { toc } = res.payload;
    assert.equal(toc.chapters.length, 1);
    assert.equal(toc.chapters[0].label, '第一章 出遅れ');
    assert.deepEqual(toc.sections, ['ch1-01', 'ch1-02']);
    assert.equal(toc.chapters[0].sections[0].viewpoint, '湊');
    assert.equal(toc.planned[0].id, 'ch1-03', 'まだ書かれていない節は別に並ぶ');
  });

  await t.test('本文が読める', async () => {
    const res = await call('GET', '/api/novels/testnovel/sections/ch1-01');
    assert.equal(res.status, 200);
    assert.match(res.payload.section.text, /窓の外を見た/);
    assert.equal(res.payload.section.next, 'ch1-02');
    assert.equal(res.payload.section.prev, null);
  });

  await t.test('節 ID を偽っても外へ出られない', async () => {
    const res = await call('GET', '/api/novels/testnovel/sections/..%2F..%2Fetc%2Fpasswd');
    assert.equal(res.status, 400);
  });

  let annotationId = null;

  await t.test('指摘が inbox.md へ書かれ、push される', async () => {
    const res = await call('POST', '/api/novels/testnovel/annotations', {
      sectionId: 'ch1-01',
      quote: '窓の外を見た',
      start: 1,
      end: 7,
      body: 'ここは「窓の外」より「窓」だけでよいのでは。',
    });
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.commit.pushed, true);
    annotationId = res.payload.annotation.id;

    const { stdout } = await git(['show', 'main:review/inbox.md'], remote);
    assert.match(stdout, /- \*\*ch1-01\*\*（第一章 第一節）／加藤／/);
    assert.match(stdout, /> 窓の外を見た/);
    assert.match(stdout, /「窓の外」より「窓」だけでよいのでは/);
    assert.ok(!stdout.includes('（なし）'), '（なし）は消える');
    assert.ok(stdout.indexOf(annotationId) < stdout.indexOf('## 済'), '未対応の側に入る');
    assert.match(stdout, /- 前に直した件/, '済の側は残る');

    const log = await git(['log', '-1', '--format=%s%n%an'], remote);
    assert.match(log.stdout, /校正指摘: ch1-01（加藤）/);
    assert.match(log.stdout, /加藤/);
  });

  await t.test('指摘は目次と本文に返ってくる', async () => {
    const res = await call('GET', '/api/novels/testnovel/sections/ch1-01');
    assert.equal(res.payload.annotations.length, 1);
    assert.equal(res.payload.annotations[0].status, 'open');
    const toc = await call('GET', '/api/novels/testnovel/toc');
    assert.equal(toc.payload.toc.chapters[0].sections[0].annotations.open, 1);
  });

  await t.test('中身の無い指摘は断られる', async () => {
    const res = await call('POST', '/api/novels/testnovel/annotations', { sectionId: 'ch1-01', body: '   ' });
    assert.equal(res.status, 400);
  });

  await t.test('作者が直したら、前後を比べられる', async () => {
    await git(['pull', '--rebase', 'origin', 'main'], seed);
    await fs.writeFile(
      path.join(seed, 'manuscript', 'ch1', 'ch1-01.md'),
      '　湊は窓を見た。\n\n「山です」\n「授業中もでしょ」\n\n　女子は声を立てて笑った。\n',
    );
    await git(['commit', '-am', 'ch1-01 を直す'], seed);
    await git(['push', 'origin', 'main'], seed);

    await call('POST', '/api/novels/testnovel/sync', {});
    const res = await call('GET', `/api/novels/testnovel/annotations/${annotationId}/compare`);
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    assert.equal(res.payload.changed, true);
    assert.equal(res.payload.diff.stats.rewritten, 2);
    assert.equal(res.payload.before.quoteAt.exact, true, '指摘した時点には引用がそのままある');
    assert.ok(!res.payload.after.quoteAt?.exact, 'いまの本文では直されている');
    assert.equal(res.payload.commits[0].subject, 'ch1-01 を直す');
  });

  await t.test('作者が済へ移すと、対応済みとして見える', async () => {
    const inboxPath = path.join(seed, 'review', 'inbox.md');
    const text = await fs.readFile(inboxPath, 'utf8');
    const lines = text.split('\n');
    const head = lines.findIndex((l) => l.startsWith('## 未対応'));
    const done = lines.findIndex((l) => l.startsWith('## 済'));
    const moved = [
      ...lines.slice(0, head + 1), '',
      ...lines.slice(done),
      ...lines.slice(head + 1, done).filter((l) => l.trim()),
    ].join('\n');
    await fs.writeFile(inboxPath, moved);
    await git(['commit', '-am', '指摘に対応した'], seed);
    await git(['push', 'origin', 'main'], seed);

    await call('POST', '/api/novels/testnovel/sync', {});
    const res = await call('GET', '/api/novels/testnovel/annotations?section=ch1-01');
    assert.equal(res.payload.annotations[0].status, 'resolved');
  });

  await t.test('読みかけとしおりが残る', async () => {
    await call('PUT', '/api/state/testnovel/position', { sectionId: 'ch1-02', offset: 12, percent: 0.4 });
    const mark = await call('POST', '/api/state/testnovel/bookmarks', { sectionId: 'ch1-02', offset: 12, quote: '灯油' });
    assert.equal(mark.status, 200);

    const state = await call('GET', '/api/state/testnovel');
    assert.equal(state.payload.position.sectionId, 'ch1-02');
    assert.equal(state.payload.position.offset, 12);
    assert.equal(state.payload.bookmarks.length, 1);

    const novels = await call('GET', '/api/novels');
    assert.equal(novels.payload.novels[0].position.sectionId, 'ch1-02');
    assert.equal(novels.payload.novels[0].bookmarks, 1);

    await call('DELETE', `/api/state/testnovel/bookmarks/${mark.payload.bookmark.id}`);
    const after = await call('GET', '/api/state/testnovel');
    assert.equal(after.payload.bookmarks.length, 0);
  });

  await t.test('別の校正者は招待コードが要る', async () => {
    const res = await call('POST', '/api/auth/signup', { loginId: 'chino', name: '茅野', password: 'password123' });
    assert.equal(res.status, 403);
  });

  await t.test('出ると読めなくなる', async () => {
    await call('POST', '/api/auth/logout', {});
    const res = await call('GET', '/api/novels/testnovel/toc');
    assert.equal(res.status, 401);
  });

  await fs.rm(root, { recursive: true, force: true });
});
