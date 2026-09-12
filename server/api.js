import path from 'node:path';
import fs from 'node:fs/promises';
import { getNovel, loadNovels, INVITE_CODE, SESSION_TTL_MS, APP_VERSION } from './config.js';
import * as auth from './auth.js';
import * as git from './git.js';
import * as novelLib from './novel.js';
import * as ws from './workspace.js';
import { diffTexts, locateQuote, relocateAll } from '../shared/diff.js';
import { annotations, readerState, newId, userSlot } from './store.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const MAX_BODY_CHARS = 4000;
const MAX_QUOTE_CHARS = 400;

function requireNovel(id) {
  const novel = getNovel(id);
  if (!novel) throw new HttpError(404, `作品が見つかりません: ${id}`);
  return novel;
}

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'ログインしてください');
  return ctx.user;
}

/**
 * 指摘の一覧。節を指してあるときは、色を敷く位置をいまの本文に合わせ直す。
 * 指摘は「何文字目か」で持っているので、作者が前のほうを直せばその数はずれるため。
 */
async function annotationsFor(novel, filter = {}, sectionText = null) {
  const data = await annotations.read();
  let list = data.annotations.filter((a) => a.novelId === novel.id);
  if (filter.sectionId) list = list.filter((a) => a.sectionId === filter.sectionId);
  if (filter.userId) list = list.filter((a) => a.userId === filter.userId);
  const inbox = await novelLib.readInbox(novel);
  const markers = novelLib.parseInboxMarkers(inbox);

  let out = list.map((a) => ({ ...a, status: markers.get(a.id) || a.status || 'open' }));
  if (filter.sectionId) {
    const text = sectionText ?? await readSectionText(novel, filter.sectionId);
    if (text != null) out = relocateAll(text, out);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function readSectionText(novel, sectionId) {
  try {
    return await fs.readFile(path.join(novel.workdir, novelLib.sectionPath(novel, sectionId)), 'utf8');
  } catch {
    return null;
  }
}

export const routes = [
  // ---------- 認証 ----------
  ['GET', '/api/me', async (ctx) => {
    const userCount = await auth.countUsers();
    return {
      user: auth.publicUser(ctx.user),
      // 画面側がこれを見て、古いままなら読み込み直しを促す
      version: APP_VERSION,
      signup: {
        enabled: userCount === 0 || Boolean(INVITE_CODE),
        // 招待コードを設けたら、最初の一人にも要る
        needsInvite: Boolean(INVITE_CODE),
        bootstrap: userCount === 0,
      },
    };
  }],

  ['POST', '/api/auth/login', async (ctx) => {
    const { loginId, password } = ctx.body || {};
    const user = await auth.authenticate(loginId, password);
    if (!user) throw new HttpError(401, 'ID かパスワードが違います');
    const { token } = await auth.startSession(user.id);
    ctx.setCookie(auth.sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
    return { user: auth.publicUser(user) };
  }],

  ['POST', '/api/auth/logout', async (ctx) => {
    await auth.endSession(ctx.token);
    ctx.setCookie(auth.sessionCookie('', 0));
    return { ok: true };
  }],

  ['POST', '/api/auth/signup', async (ctx) => {
    const { loginId, name, password, inviteCode } = ctx.body || {};
    const userCount = await auth.countUsers();
    const bootstrap = userCount === 0;
    // 招待コードがあるなら、最初の一人にも要る。
    // 誰も登録していない隙に、管理者の席を横から取られないようにするため。
    if (INVITE_CODE) {
      if (inviteCode !== INVITE_CODE) throw new HttpError(403, '招待コードが違います');
    } else if (!bootstrap) {
      throw new HttpError(403, '自己登録は止めてあります。管理者に作ってもらってください');
    }
    const user = await auth.createUser({ loginId, name, password, role: bootstrap ? 'admin' : 'proofreader' });
    const { token } = await auth.startSession(user.id);
    ctx.setCookie(auth.sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
    return { user };
  }],

  // ---------- 作品 ----------
  ['GET', '/api/novels', async (ctx) => {
    requireUser(ctx);
    const list = loadNovels();
    const state = await readerState.read();
    const out = [];
    for (const novel of list) {
      const s = ws.status(novel);
      const slot = state.byUser?.[ctx.user.id]?.[novel.id];
      out.push({
        id: novel.id,
        title: novel.title,
        author: novel.author || '',
        repo: novel.repo || novel.localPath,
        branch: novel.branch,
        ready: s.ready,
        error: s.error,
        chars: s.toc?.chars ?? null,
        sections: s.toc?.sections.length ?? null,
        position: slot?.position || null,
        bookmarks: slot?.bookmarks?.length || 0,
      });
    }
    return { novels: out };
  }],

  ['GET', '/api/novels/:novelId/toc', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    const s = await ws.ensureReady(novel, { force: ctx.query.get('sync') === '1' });
    const marks = novelLib.parseInboxMarkers(await novelLib.readInbox(novel));
    const mine = await annotationsFor(novel, {});
    const counts = new Map();
    for (const a of mine) {
      const key = a.sectionId;
      const c = counts.get(key) || { open: 0, resolved: 0 };
      if ((marks.get(a.id) || a.status) === 'resolved') c.resolved += 1;
      else c.open += 1;
      counts.set(key, c);
    }
    const toc = structuredClone(s.toc);
    for (const chapter of toc.chapters) {
      for (const section of chapter.sections) {
        section.annotations = counts.get(section.id) || { open: 0, resolved: 0 };
      }
    }
    return {
      novel: { id: novel.id, title: novel.title, branch: novel.branch, repo: novel.repo || novel.localPath },
      head: s.head,
      lastSync: s.lastSync,
      error: s.error,
      toc,
    };
  }],

  ['POST', '/api/novels/:novelId/sync', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    const s = await ws.ensureReady(novel, { force: true });
    return { head: s.head, lastSync: s.lastSync, error: s.error };
  }],

  ['GET', '/api/novels/:novelId/sections/:sectionId', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    const { sectionId } = ctx.params;
    if (!novelLib.isSectionId(sectionId)) throw new HttpError(400, '節 ID が不正です');
    const s = await ws.ensureReady(novel);
    const section = await novelLib.getSection(novel, sectionId, s.toc);
    if (!section) throw new HttpError(404, `本文が見つかりません: ${sectionId}`);
    const list = await annotationsFor(novel, { sectionId }, section.text);
    const state = await readerState.read();
    const slot = state.byUser?.[ctx.user.id]?.[novel.id];
    return {
      section,
      head: s.head,
      annotations: list,
      bookmarks: (slot?.bookmarks || []).filter((b) => b.sectionId === sectionId),
    };
  }],

  ['GET', '/api/novels/:novelId/inbox', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    await ws.ensureReady(novel);
    return { path: novel.inboxPath, text: (await novelLib.readInbox(novel)) || '' };
  }],

  // ---------- 指摘 ----------
  ['GET', '/api/novels/:novelId/annotations', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    await ws.ensureReady(novel);
    const sectionId = ctx.query.get('section') || undefined;
    const mine = ctx.query.get('mine') === '1' ? ctx.user.id : undefined;
    return { annotations: await annotationsFor(novel, { sectionId, userId: mine }) };
  }],

  ['POST', '/api/novels/:novelId/annotations', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    const { sectionId, quote = '', body = '', start = null, end = null } = ctx.body || {};
    if (!novelLib.isSectionId(sectionId)) throw new HttpError(400, '節 ID が不正です');
    const text = String(body).trim();
    if (!text) throw new HttpError(400, '指摘の中身が空です');
    if (text.length > MAX_BODY_CHARS) throw new HttpError(400, `指摘は ${MAX_BODY_CHARS} 字までです`);
    if (String(quote).length > MAX_QUOTE_CHARS) throw new HttpError(400, `引用は ${MAX_QUOTE_CHARS} 字までです`);

    return git.withRepoLock(novel.id, async () => {
      const s = await ws.prepare(novel, { force: true });
      const entry = novelLib.findSection(s.toc, sectionId);
      if (!entry) throw new HttpError(404, `本文が見つかりません: ${sectionId}`);

      const rel = novelLib.sectionPath(novel, sectionId);
      const current = await fs.readFile(path.join(novel.workdir, rel), 'utf8');
      const located = quote ? locateQuote(current, quote, start ?? 0) : null;
      const commit = await git.lastCommitOf(novel, rel);

      const id = newId('ann');
      const createdAt = new Date().toISOString();
      const record = {
        id,
        novelId: novel.id,
        sectionId,
        sectionLabel: entry.label,
        userId: user.id,
        userName: user.name,
        createdAt,
        quote: String(quote),
        body: text,
        start: located ? located.start : (Number.isInteger(start) ? start : null),
        end: located ? located.end : (Number.isInteger(end) ? end : null),
        baseSha: commit?.sha || s.head,
        status: 'open',
        quoteFound: Boolean(located),
      };

      const entryText = novelLib.formatInboxEntry({
        ...record,
        sectionLabel: entry.label,
        userName: user.name,
      });
      const inbox = await novelLib.readInbox(novel);
      await novelLib.writeInbox(novel, novelLib.insertIntoInbox(inbox, entryText));

      const result = await git.commitFiles(novel, {
        files: [novel.inboxPath],
        message: `校正指摘: ${sectionId}（${user.name}）`,
        authorName: user.name,
        authorEmail: user.email || `${user.loginId}@proofreading.local`,
      });
      await ws.refresh(novel);

      await annotations.update((data) => {
        data.annotations.push({ ...record, inboxCommit: result.sha, pushed: result.pushed });
      });

      return { annotation: { ...record, inboxCommit: result.sha }, commit: result };
    });
  }],

  /** 指摘を付けた時点の本文と、いまの本文を突き合わせる。 */
  ['GET', '/api/novels/:novelId/annotations/:annotationId/compare', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    await ws.ensureReady(novel);
    const data = await annotations.read();
    const ann = data.annotations.find((a) => a.id === ctx.params.annotationId && a.novelId === novel.id);
    if (!ann) throw new HttpError(404, '指摘が見つかりません');

    const rel = novelLib.sectionPath(novel, ann.sectionId);
    const before = await git.showFileAt(novel, ann.baseSha, rel);
    const after = await fs.readFile(path.join(novel.workdir, rel), 'utf8').catch(() => null);
    if (before == null || after == null) throw new HttpError(409, '前後を比べる本文が読めません');

    const diff = diffTexts(before, after);
    const history = await git.fileHistory(novel, rel, 20);
    const sinceBase = [];
    for (const c of history) {
      if (c.sha === ann.baseSha) break;
      sinceBase.push(c);
    }
    return {
      annotation: ann,
      before: { sha: ann.baseSha, text: before, quoteAt: locateQuote(before, ann.quote, ann.start ?? 0) },
      after: { sha: history[0]?.sha || null, text: after, quoteAt: locateQuote(after, ann.quote, ann.start ?? 0) },
      commits: sinceBase,
      diff,
      changed: diff.stats.changed > 0,
    };
  }],

  /** 任意の 2 つの版を突き合わせる（版を選んで比べたいとき）。 */
  ['GET', '/api/novels/:novelId/sections/:sectionId/compare', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    const { sectionId } = ctx.params;
    if (!novelLib.isSectionId(sectionId)) throw new HttpError(400, '節 ID が不正です');
    await ws.ensureReady(novel);
    const rel = novelLib.sectionPath(novel, sectionId);
    const from = ctx.query.get('from');
    const to = ctx.query.get('to') || 'HEAD';
    if (!from) throw new HttpError(400, 'from にコミットを指定してください');
    const before = await git.showFileAt(novel, from, rel);
    const after = to === 'HEAD'
      ? await fs.readFile(path.join(novel.workdir, rel), 'utf8').catch(() => null)
      : await git.showFileAt(novel, to, rel);
    if (before == null || after == null) throw new HttpError(404, '指定の版が見つかりません');
    return { from, to, diff: diffTexts(before, after), before: { text: before }, after: { text: after } };
  }],

  ['GET', '/api/novels/:novelId/sections/:sectionId/history', async (ctx) => {
    requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    const { sectionId } = ctx.params;
    if (!novelLib.isSectionId(sectionId)) throw new HttpError(400, '節 ID が不正です');
    await ws.ensureReady(novel);
    return { history: await git.fileHistory(novel, novelLib.sectionPath(novel, sectionId), 30) };
  }],

  // ---------- しおりと読みかけ ----------
  ['GET', '/api/state/:novelId', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    const data = await readerState.read();
    const slot = data.byUser?.[user.id]?.[novel.id] || { position: null, bookmarks: [] };
    return { position: slot.position, bookmarks: slot.bookmarks };
  }],

  ['PUT', '/api/state/:novelId/position', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    const { sectionId, offset = 0, percent = 0 } = ctx.body || {};
    if (!novelLib.isSectionId(sectionId)) throw new HttpError(400, '節 ID が不正です');
    const position = {
      sectionId,
      offset: Math.max(0, Number(offset) || 0),
      percent: Math.min(1, Math.max(0, Number(percent) || 0)),
      updatedAt: new Date().toISOString(),
    };
    await readerState.update((data) => {
      userSlot(data, user.id, novel.id).position = position;
    });
    return { position };
  }],

  ['POST', '/api/state/:novelId/bookmarks', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    const { sectionId, offset = 0, quote = '', note = '' } = ctx.body || {};
    if (!novelLib.isSectionId(sectionId)) throw new HttpError(400, '節 ID が不正です');
    const bookmark = {
      id: newId('bm'),
      sectionId,
      offset: Math.max(0, Number(offset) || 0),
      quote: String(quote).slice(0, 120),
      note: String(note).slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    await readerState.update((data) => {
      const slot = userSlot(data, user.id, novel.id);
      slot.bookmarks.push(bookmark);
      slot.bookmarks.sort((a, b) => novelLib.sectionOrder(a.sectionId) - novelLib.sectionOrder(b.sectionId) || a.offset - b.offset);
    });
    return { bookmark };
  }],

  ['DELETE', '/api/state/:novelId/bookmarks/:bookmarkId', async (ctx) => {
    const user = requireUser(ctx);
    const novel = requireNovel(ctx.params.novelId);
    await readerState.update((data) => {
      const slot = userSlot(data, user.id, novel.id);
      slot.bookmarks = slot.bookmarks.filter((b) => b.id !== ctx.params.bookmarkId);
    });
    return { ok: true };
  }],
];
