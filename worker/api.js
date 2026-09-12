/**
 * API の中身（Workers 版）。
 * 返す形は Node 版と同じにしてあるので、public/ の画面はそのまま動く。
 */
import { insertIntoInbox, parseInboxMarkers, formatInboxEntry, isSectionId, sectionPath } from '../shared/novel.js';
import { diffTexts, locateQuote } from '../shared/diff.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../shared/password.js';
import * as db from './db.js';
import * as repo from './repo.js';
import { getNovel, loadNovels } from './novels.js';
import { GitHubError } from './github.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_CHARS = 4000;
const MAX_QUOTE_CHARS = 400;

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'ログインしてください');
  return ctx.user;
}

function requireNovel(ctx) {
  const novel = getNovel(ctx.env, ctx.params.novelId);
  if (!novel) throw new HttpError(404, `作品が見つかりません: ${ctx.params.novelId}`);
  return novel;
}

function requireSectionId(id) {
  if (!isSectionId(id)) throw new HttpError(400, '節 ID が不正です');
  return id;
}

function sessionCookie(ctx, token, maxAgeSec) {
  const bits = [`pr_session=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (ctx.env.SECURE_COOKIE !== '0') bits.push('Secure');
  return bits.join('; ');
}

function sessionTtlMs(env) {
  return Number(env.SESSION_DAYS || 30) * 86_400_000;
}

/** 指摘の状態は inbox.md が正。未対応から消えていれば「対応済み」とみなす。 */
async function annotationsWithStatus(ctx, novel, filter) {
  const [rows, inbox] = await Promise.all([
    db.listAnnotations(ctx.db, { novelId: novel.id, ...filter }),
    repo.readInbox(ctx.gh, novel).catch(() => null),
  ]);
  const markers = parseInboxMarkers(inbox);
  return rows.map((a) => ({ ...a, status: markers.get(a.id) || a.status || 'open' }));
}

export const routes = [
  ['GET', '/api/me', async (ctx) => {
    const userCount = await db.countUsers(ctx.db);
    const invite = ctx.env.INVITE_CODE || '';
    return {
      user: ctx.user || null,
      // 画面側がこれを見て、古いままなら読み込み直しを促す
      version: ctx.env.CF_VERSION_METADATA?.id?.slice(0, 8) || '',
      signup: {
        enabled: userCount === 0 || Boolean(invite),
        // 招待コードを設けたら、最初の一人にも要る
        needsInvite: Boolean(invite),
        bootstrap: userCount === 0,
      },
    };
  }],

  ['POST', '/api/auth/login', async (ctx) => {
    const { loginId, password } = ctx.body || {};
    const user = await db.userByLogin(ctx.db, loginId);
    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'ID かパスワードが違います');
    const ttl = sessionTtlMs(ctx.env);
    const { token } = await db.createSession(ctx.db, user.id, ttl);
    ctx.setCookie(sessionCookie(ctx, token, Math.floor(ttl / 1000)));
    return { user: db.publicUser(user) };
  }],

  ['POST', '/api/auth/logout', async (ctx) => {
    await db.deleteSession(ctx.db, ctx.token);
    ctx.setCookie(sessionCookie(ctx, '', 0));
    return { ok: true };
  }],

  ['POST', '/api/auth/signup', async (ctx) => {
    const { loginId, name, password, inviteCode } = ctx.body || {};
    const userCount = await db.countUsers(ctx.db);
    const bootstrap = userCount === 0;
    const invite = ctx.env.INVITE_CODE || '';
    // 招待コードがあるなら、最初の一人にも要る。
    // 誰も登録していない隙に、管理者の席を横から取られないようにするため。
    if (invite) {
      if (inviteCode !== invite) throw new HttpError(403, '招待コードが違います');
    } else if (!bootstrap) {
      throw new HttpError(403, '自己登録は止めてあります。管理者に作ってもらってください');
    }
    const id = String(loginId || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,32}$/.test(id)) {
      throw new HttpError(400, 'ログイン ID は英数字・ドット・ハイフン・アンダースコアの 2〜32 文字です');
    }
    if (!password || password.length < 8) throw new HttpError(400, 'パスワードは 8 文字以上にしてください');
    if (await db.userByLogin(ctx.db, id)) throw new HttpError(409, `ID が既にあります: ${id}`);

    const user = {
      id: db.newId('usr'),
      loginId: id,
      name: String(name || id).trim(),
      email: '',
      role: bootstrap ? 'admin' : 'proofreader',
      passwordHash: await hashPassword(password, Number(ctx.env.PBKDF2_ITERATIONS) || undefined),
      createdAt: new Date().toISOString(),
    };
    await db.insertUser(ctx.db, user);
    const ttl = sessionTtlMs(ctx.env);
    const { token } = await db.createSession(ctx.db, user.id, ttl);
    ctx.setCookie(sessionCookie(ctx, token, Math.floor(ttl / 1000)));
    return { user: db.publicUser(user) };
  }],

  ['GET', '/api/novels', async (ctx) => {
    const user = requireUser(ctx);
    const out = [];
    for (const novel of loadNovels(ctx.env)) {
      const [position, bookmarks] = await Promise.all([
        db.getPosition(ctx.db, user.id, novel.id),
        db.countBookmarks(ctx.db, user.id, novel.id),
      ]);
      let stats = null;
      let error = null;
      try {
        const built = await repo.toc(ctx.db, ctx.gh, novel);
        stats = built.toc;
      } catch (err) {
        error = err.message;
        stats = await repo.cachedToc(ctx.db, novel.id);
      }
      out.push({
        id: novel.id,
        title: novel.title,
        author: novel.author || '',
        repo: novel.url,
        branch: novel.branch,
        ready: Boolean(stats),
        error,
        chars: stats?.chars ?? null,
        sections: stats?.sections.length ?? null,
        position,
        bookmarks,
      });
    }
    return { novels: out };
  }],

  ['GET', '/api/novels/:novelId/toc', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx);
    const fresh = ctx.query.get('sync') === '1';
    const built = await repo.toc(ctx.db, ctx.gh, novel, { fresh });
    const annotations = await annotationsWithStatus(ctx, novel, {});

    const counts = new Map();
    for (const a of annotations) {
      const c = counts.get(a.sectionId) || { open: 0, resolved: 0 };
      if (a.status === 'resolved') c.resolved += 1;
      else c.open += 1;
      counts.set(a.sectionId, c);
    }
    const toc = structuredClone(built.toc);
    for (const chapter of toc.chapters) {
      for (const section of chapter.sections) {
        section.annotations = counts.get(section.id) || { open: 0, resolved: 0 };
      }
    }
    return {
      novel: { id: novel.id, title: novel.title, branch: novel.branch, repo: novel.url },
      head: built.head,
      lastSync: Date.now(),
      error: null,
      toc,
    };
  }],

  ['POST', '/api/novels/:novelId/sync', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx);
    await repo.invalidate(ctx.db, novel);
    const built = await repo.toc(ctx.db, ctx.gh, novel, { fresh: true });
    return { head: built.head, lastSync: Date.now(), error: null };
  }],

  ['GET', '/api/novels/:novelId/sections/:sectionId', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx);
    const sectionId = requireSectionId(ctx.params.sectionId);
    const built = await repo.toc(ctx.db, ctx.gh, novel);
    const section = await repo.section(ctx.gh, novel, sectionId, built.toc, built.head);
    if (!section) throw new HttpError(404, `本文が見つかりません: ${sectionId}`);
    const [annotations, bookmarks] = await Promise.all([
      annotationsWithStatus(ctx, novel, { sectionId }),
      db.listBookmarks(ctx.db, user.id, novel.id),
    ]);
    return {
      section,
      head: built.head,
      annotations,
      bookmarks: bookmarks.filter((b) => b.sectionId === sectionId),
    };
  }],

  ['GET', '/api/novels/:novelId/inbox', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx);
    return { path: novel.inboxPath, text: (await repo.readInbox(ctx.gh, novel)) || '' };
  }],

  ['GET', '/api/novels/:novelId/annotations', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx);
    const filter = {};
    if (ctx.query.get('section')) filter.sectionId = ctx.query.get('section');
    if (ctx.query.get('mine') === '1') filter.userId = user.id;
    return { annotations: await annotationsWithStatus(ctx, novel, filter) };
  }],

  ['POST', '/api/novels/:novelId/annotations', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx);
    const { sectionId, quote = '', body = '', start = null, end = null } = ctx.body || {};
    requireSectionId(sectionId);
    const text = String(body).trim();
    if (!text) throw new HttpError(400, '指摘の中身が空です');
    if (text.length > MAX_BODY_CHARS) throw new HttpError(400, `指摘は ${MAX_BODY_CHARS} 字までです`);
    if (String(quote).length > MAX_QUOTE_CHARS) throw new HttpError(400, `引用は ${MAX_QUOTE_CHARS} 字までです`);

    const built = await repo.toc(ctx.db, ctx.gh, novel, { fresh: true });
    const entry = built.toc.chapters.flatMap((c) => c.sections).find((s) => s.id === sectionId);
    if (!entry) throw new HttpError(404, `本文が見つかりません: ${sectionId}`);

    const path = sectionPath(novel, sectionId);
    const current = await ctx.gh.fileText(novel, path, built.head);
    const located = quote ? locateQuote(current || '', quote, start ?? 0) : null;
    const commits = await ctx.gh.commitsFor(novel, path, 1);

    const record = {
      id: db.newId('ann'),
      novelId: novel.id,
      sectionId,
      sectionLabel: entry.label,
      userId: user.id,
      userName: user.name,
      createdAt: new Date().toISOString(),
      quote: String(quote),
      body: text,
      start: located ? located.start : (Number.isInteger(start) ? start : null),
      end: located ? located.end : (Number.isInteger(end) ? end : null),
      baseSha: commits[0]?.sha || built.head,
      status: 'open',
    };

    const entryText = formatInboxEntry({ ...record, sectionLabel: entry.label, userName: user.name });
    const author = { name: user.name, email: user.email || `${user.loginId}@proofreading.local` };

    // 誰かが先に書いていたら sha が合わずに弾かれる。読み直して作り直す。
    let commit = null;
    for (let attempt = 0; attempt < 3 && !commit; attempt += 1) {
      const inbox = await ctx.gh.fileWithSha(novel, novel.inboxPath, novel.branch);
      const next = insertIntoInbox(inbox?.text ?? null, entryText);
      try {
        commit = await ctx.gh.putFile(novel, {
          path: novel.inboxPath,
          text: next,
          message: `校正指摘: ${sectionId}（${user.name}）`,
          sha: inbox?.sha,
          author,
        });
      } catch (err) {
        const clash = err instanceof GitHubError && (err.status === 409 || err.status === 422);
        if (!clash || attempt === 2) throw err;
      }
    }

    record.inboxCommit = commit.sha || '';
    await db.insertAnnotation(ctx.db, record);
    return {
      annotation: record,
      commit: { sha: commit.sha, committed: true, pushed: true },
    };
  }],

  ['GET', '/api/novels/:novelId/annotations/:annotationId/compare', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx);
    const ann = await db.getAnnotation(ctx.db, novel.id, ctx.params.annotationId);
    if (!ann) throw new HttpError(404, '指摘が見つかりません');

    const path = sectionPath(novel, ann.sectionId);
    const [before, after, history] = await Promise.all([
      ctx.gh.fileText(novel, path, ann.baseSha),
      ctx.gh.fileText(novel, path, novel.branch),
      ctx.gh.commitsFor(novel, path, 20),
    ]);
    if (before == null || after == null) throw new HttpError(409, '前後を比べる本文が読めません');

    const sinceBase = [];
    for (const c of history) {
      if (c.sha === ann.baseSha) break;
      sinceBase.push(c);
    }
    const diff = diffTexts(before, after);
    return {
      annotation: ann,
      before: { sha: ann.baseSha, text: before, quoteAt: locateQuote(before, ann.quote, ann.start ?? 0) },
      after: { sha: history[0]?.sha || null, text: after, quoteAt: locateQuote(after, ann.quote, ann.start ?? 0) },
      commits: sinceBase,
      diff,
      changed: diff.stats.changed > 0,
    };
  }],

  ['GET', '/api/novels/:novelId/sections/:sectionId/compare', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx);
    const sectionId = requireSectionId(ctx.params.sectionId);
    const from = ctx.query.get('from');
    const to = ctx.query.get('to') || 'HEAD';
    if (!from) throw new HttpError(400, 'from にコミットを指定してください');
    const path = sectionPath(novel, sectionId);
    const [before, after] = await Promise.all([
      ctx.gh.fileText(novel, path, from),
      ctx.gh.fileText(novel, path, to === 'HEAD' ? novel.branch : to),
    ]);
    if (before == null || after == null) throw new HttpError(404, '指定の版が見つかりません');
    return { from, to, diff: diffTexts(before, after), before: { text: before }, after: { text: after } };
  }],

  ['GET', '/api/novels/:novelId/sections/:sectionId/history', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx);
    const sectionId = requireSectionId(ctx.params.sectionId);
    return { history: await ctx.gh.commitsFor(novel, sectionPath(novel, sectionId), 30) };
  }],

  ['GET', '/api/state/:novelId', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx);
    const [position, bookmarks] = await Promise.all([
      db.getPosition(ctx.db, user.id, novel.id),
      db.listBookmarks(ctx.db, user.id, novel.id),
    ]);
    return { position, bookmarks };
  }],

  ['PUT', '/api/state/:novelId/position', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx);
    const { sectionId, offset = 0, percent = 0 } = ctx.body || {};
    requireSectionId(sectionId);
    const position = {
      sectionId,
      offset: Math.max(0, Number(offset) || 0),
      percent: Math.min(1, Math.max(0, Number(percent) || 0)),
      updatedAt: new Date().toISOString(),
    };
    await db.setPosition(ctx.db, user.id, novel.id, position);
    return { position };
  }],

  ['POST', '/api/state/:novelId/bookmarks', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx);
    const { sectionId, offset = 0, quote = '', note = '' } = ctx.body || {};
    requireSectionId(sectionId);
    const bookmark = {
      id: db.newId('bm'),
      sectionId,
      offset: Math.max(0, Number(offset) || 0),
      quote: String(quote).slice(0, 120),
      note: String(note).slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    await db.insertBookmark(ctx.db, user.id, novel.id, bookmark);
    return { bookmark };
  }],

  ['DELETE', '/api/state/:novelId/bookmarks/:bookmarkId', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx);
    await db.deleteBookmark(ctx.db, user.id, novel.id, ctx.params.bookmarkId);
    return { ok: true };
  }],
];
