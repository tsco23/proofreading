/**
 * 原稿リポジトリの読み書き（Workers 版）。
 * Node 版の workspace.js ＋ novel.js にあたる。clone の代わりに GitHub API を叩く。
 */
import { buildToc, sectionPath, findSection, withNeighbours, countChars, stripNotes } from '../shared/novel.js';
import { remember, forget } from './cache.js';
import { getTocCache, setTocCache, clearTocCache, getSectionStats, putSectionStats } from './db.js';

const HEAD_TTL = 15_000;
const TREE_TTL = 15_000;
const TEXT_TTL = 5 * 60_000;

export async function head(gh, novel, { fresh = false } = {}) {
  if (fresh) forget(`head:${novel.id}`);
  return remember(`head:${novel.id}`, HEAD_TTL, () => gh.headSha(novel));
}

async function tree(gh, novel, sha, { fresh = false } = {}) {
  if (fresh) forget(`tree:${novel.id}`);
  return remember(`tree:${novel.id}:${sha}`, TREE_TTL, () => gh.tree(novel, sha));
}

/** blob は sha で決まるので、いくらでも取っておける。 */
function blobText(gh, novel, sha) {
  return remember(`blob:${novel.id}:${sha}`, TEXT_TTL, () => gh.blobText(novel, sha));
}

/** 手当たり次第に並べず、少しずつ取る（GitHub に嫌われないため）。 */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 目次。本文を全部読む必要があるので、
 * 「本文の木 ＋ outline の 2 ファイル」が変わっていない限り D1 の控えを使う。
 * こうしておくと、指摘のコミットが増えても目次は組み直さずに済む。
 */
export async function toc(db, gh, novel, { fresh = false } = {}) {
  const headSha = await head(gh, novel, { fresh });
  const entries = await tree(gh, novel, headSha, { fresh });

  const dir = novel.manuscriptDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const manuscript = entries.filter((e) => new RegExp(`^${dir}/ch\\d+/ch\\d+-\\d+\\.md$`).test(e.path));
  const structure = entries.find((e) => e.path === novel.structurePath);
  const sections = entries.find((e) => e.path === novel.sectionsPath);

  const fingerprint = [
    manuscript.map((e) => `${e.path}@${e.sha}`).join(','),
    structure?.sha || '-',
    sections?.sha || '-',
  ].join('|');
  const key = await digest(fingerprint);

  if (!fresh) {
    const cached = await getTocCache(db, novel.id, key);
    if (cached) return { toc: cached, head: headSha, built: false };
  }

  // 字数と冒頭だけ分かればよいので、控えのある節は読み直さない
  const known = await getSectionStats(db, novel.id, manuscript.map((e) => e.sha));
  const learned = [];
  const files = await mapLimited(manuscript, 6, async (entry) => {
    const hit = known.get(entry.sha);
    if (hit) return { path: entry.path, chars: hit.chars, opening: hit.opening };
    // 字数と冒頭は、作者の道具と同じく注を落とした清書から数える
    const clean = stripNotes(await blobText(gh, novel, entry.sha));
    const stats = { sha: entry.sha, chars: countChars(clean), opening: firstLine(clean).slice(0, 40) };
    learned.push(stats);
    return { path: entry.path, chars: stats.chars, opening: stats.opening };
  });
  if (learned.length) await putSectionStats(db, novel.id, learned);
  const [structureText, sectionsText] = await Promise.all([
    structure ? blobText(gh, novel, structure.sha) : '',
    sections ? blobText(gh, novel, sections.sha) : '',
  ]);

  const built = buildToc({ files, structureText, sectionsText });
  await setTocCache(db, novel.id, key, built);
  return { toc: built, head: headSha, built: true };
}

/** D1 に残っている最後の目次（GitHub を叩かずに一覧へ数字を出すため）。 */
export async function cachedToc(db, novelId) {
  const row = await db.prepare('SELECT json FROM toc_cache WHERE novel_id = ?').bind(novelId).first();
  return row ? JSON.parse(row.json) : null;
}

export async function section(gh, novel, sectionId, tocData, headSha) {
  const path = sectionPath(novel, sectionId);
  const text = await gh.fileText(novel, path, headSha);
  if (text == null) return null;
  const commits = await gh.commitsFor(novel, path, 1);
  return {
    ...findSection(tocData, sectionId),
    text,
    commit: commits[0] || null,
    ...withNeighbours(tocData, sectionId),
  };
}

export function readInbox(gh, novel, ref) {
  return gh.fileText(novel, novel.inboxPath, ref);
}

export async function invalidate(db, novel) {
  forget(`head:${novel.id}`);
  forget(`tree:${novel.id}`);
  await clearTocCache(db, novel.id);
}

function firstLine(text) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}
