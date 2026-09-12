import fs from 'node:fs/promises';
import path from 'node:path';
import * as git from './git.js';

const SECTION_RE = /^ch(\d+)-(\d+)$/;
const KANJI = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function kanjiNumber(n) {
  if (n < 10) return KANJI[n];
  if (n < 20) return `十${n % 10 ? KANJI[n % 10] : ''}`;
  if (n < 100) return `${KANJI[Math.floor(n / 10)]}十${n % 10 ? KANJI[n % 10] : ''}`;
  return String(n);
}

export function parseKanjiNumber(text) {
  const s = String(text).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const idx = KANJI.indexOf(s);
  if (idx > 0) return idx;
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) {
    const tens = m[1] ? KANJI.indexOf(m[1]) : 1;
    const ones = m[2] ? KANJI.indexOf(m[2]) : 0;
    return tens * 10 + ones;
  }
  return null;
}

export function isSectionId(id) {
  return SECTION_RE.test(String(id || ''));
}

export function sectionPath(novel, sectionId) {
  const m = SECTION_RE.exec(sectionId);
  if (!m) throw new Error(`節 ID が不正です: ${sectionId}`);
  return `${novel.manuscriptDir}/ch${Number(m[1])}/${sectionId}.md`;
}

export function sectionOrder(sectionId) {
  const m = SECTION_RE.exec(sectionId);
  return m ? Number(m[1]) * 1000 + Number(m[2]) : 0;
}

export function countChars(text) {
  let n = 0;
  for (const ch of text) if (!/\s/.test(ch)) n += 1;
  return n;
}

function stripMd(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** outline/structure.md の表から章題を拾う。 */
export function parseChapterTitles(text) {
  const out = new Map();
  if (!text) return out;
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => stripMd(c));
    if (cells.length < 2) continue;
    const num = parseKanjiNumber(cells[0]);
    if (!num || !cells[1] || cells[1] === '題') continue;
    out.set(num, { title: cells[1], period: cells[2] || '', role: cells[cells.length - 1] || '' });
  }
  return out;
}

/** outline/sections.md から節ごとの設計（視点・時・場所・あらすじ・引き）を拾う。 */
export function parseSectionMeta(text) {
  const out = new Map();
  if (!text) return out;
  let chapter = '';
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^# (?!#)/.test(line)) {
      chapter = line.slice(2).trim();
      continue;
    }
    const head = line.match(/^##\s+(ch\d+-\d+)/);
    if (head) {
      current = { id: head[1], chapterHeading: chapter, summary: [], viewpoint: '', time: '', place: '', hook: '', check: '' };
      out.set(head[1], current);
      continue;
    }
    if (line.startsWith('## ') || line.startsWith('# ')) {
      current = null;
      continue;
    }
    if (!current || !line.trim()) continue;

    const body = stripMd(line.replace(/^\s*-\s*/, ''));
    if (/^視点/.test(body)) {
      for (const part of body.split('／')) {
        const t = part.trim();
        if (t.startsWith('視点')) current.viewpoint = t.replace(/^視点\s*/, '');
        else if (t.startsWith('時')) current.time = t.replace(/^時\s*/, '');
        else if (t.startsWith('場所')) current.place = t.replace(/^場所\s*/, '');
      }
    } else if (/^引き/.test(body)) {
      current.hook = body.replace(/^引き\s*/, '');
    } else if (/^要確認/.test(body)) {
      current.check = body.replace(/^要確認\s*/, '');
    } else if (body) {
      current.summary.push(body);
    }
  }
  for (const meta of out.values()) meta.summary = meta.summary.join(' ');
  return out;
}

/** 本文ファイルを走査して章立てを組む。目次はこれで自動生成される。 */
export async function buildToc(novel) {
  const root = path.join(novel.workdir, novel.manuscriptDir);
  let chapterDirs = [];
  try {
    chapterDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^ch\d+$/.test(d.name))
      .map((d) => d.name);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const [structureText, sectionsText] = await Promise.all([
    readIfExists(path.join(novel.workdir, novel.structurePath)),
    readIfExists(path.join(novel.workdir, novel.sectionsPath)),
  ]);
  const titles = parseChapterTitles(structureText);
  const metas = parseSectionMeta(sectionsText);

  const chapters = [];
  for (const dir of chapterDirs.sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))) {
    const number = Number(dir.slice(2));
    const files = (await fs.readdir(path.join(root, dir)))
      .filter((f) => /^ch\d+-\d+\.md$/.test(f))
      .sort((a, b) => sectionOrder(a.replace(/\.md$/, '')) - sectionOrder(b.replace(/\.md$/, '')));

    const sections = [];
    for (const file of files) {
      const id = file.replace(/\.md$/, '');
      const rel = `${novel.manuscriptDir}/${dir}/${file}`;
      const text = await fs.readFile(path.join(novel.workdir, novel.manuscriptDir, dir, file), 'utf8');
      const meta = metas.get(id) || {};
      const index = Number(SECTION_RE.exec(id)[2]);
      sections.push({
        id,
        path: rel,
        chapter: number,
        index,
        label: `第${kanjiNumber(number)}章 第${kanjiNumber(index)}節`,
        chars: countChars(text),
        opening: firstLine(text).slice(0, 40),
        viewpoint: meta.viewpoint || '',
        time: meta.time || '',
        place: meta.place || '',
        summary: meta.summary || '',
        hook: meta.hook || '',
      });
    }

    const info = titles.get(number) || {};
    chapters.push({
      number,
      title: info.title || '',
      period: info.period || '',
      role: info.role || '',
      label: `第${kanjiNumber(number)}章${info.title ? ` ${info.title}` : ''}`,
      chars: sections.reduce((sum, s) => sum + s.chars, 0),
      sections,
    });
  }

  const planned = [];
  for (const [id, meta] of metas) {
    if (!chapters.some((c) => c.sections.some((s) => s.id === id))) {
      const m = SECTION_RE.exec(id);
      planned.push({
        id,
        chapter: Number(m[1]),
        index: Number(m[2]),
        label: `第${kanjiNumber(Number(m[1]))}章 第${kanjiNumber(Number(m[2]))}節`,
        summary: meta.summary || '',
        viewpoint: meta.viewpoint || '',
        written: false,
      });
    }
  }

  return {
    chapters,
    planned: planned.sort((a, b) => sectionOrder(a.id) - sectionOrder(b.id)),
    chars: chapters.reduce((sum, c) => sum + c.chars, 0),
    sections: chapters.flatMap((c) => c.sections.map((s) => s.id)),
  };
}

function firstLine(text) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** 本文 1 節ぶん。text は生のまま返し、段落分けは画面側で行う。 */
export async function getSection(novel, sectionId, toc) {
  const rel = sectionPath(novel, sectionId);
  const text = await readIfExists(path.join(novel.workdir, rel));
  if (text == null) return null;
  const commit = await git.lastCommitOf(novel, rel);
  const ids = toc.sections;
  const at = ids.indexOf(sectionId);
  const entry = toc.chapters.flatMap((c) => c.sections).find((s) => s.id === sectionId);
  return {
    ...entry,
    text,
    commit,
    prev: at > 0 ? ids[at - 1] : null,
    next: at >= 0 && at < ids.length - 1 ? ids[at + 1] : null,
  };
}

const MARKER = 'pr';

export function formatInboxEntry({ id, sectionId, sectionLabel, userName, createdAt, quote, body, start, end, baseSha }) {
  const date = new Date(createdAt);
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const lines = [];
  lines.push(`- **${sectionId}**（${sectionLabel}）／${userName}／${stamp}`);
  if (quote) {
    for (const q of quote.split('\n')) lines.push(`  > ${q}`);
  }
  for (const b of String(body).trim().split('\n')) {
    lines.push(`  ${b.trim()}`);
  }
  const range = Number.isInteger(start) && Number.isInteger(end) ? ` range=${start}-${end}` : '';
  const base = baseSha ? ` base=${baseSha.slice(0, 10)}` : '';
  lines.push(`  <!-- ${MARKER}:id=${id} section=${sectionId}${range}${base} -->`);
  return lines.join('\n');
}

/**
 * review/inbox.md の「未対応」の末尾へ指摘を足す。
 * 「（なし）」の目印は取り除く。見出しが無いファイルなら作って足す。
 */
export function insertIntoInbox(inboxText, entryText) {
  const text = inboxText == null ? '# レビュー指摘の受け取り箱\n\n## 未対応\n\n（なし）\n\n## 済\n' : inboxText;
  const lines = text.split('\n');
  const headIdx = lines.findIndex((l) => /^##\s*未対応/.test(l));
  if (headIdx < 0) {
    const trimmed = text.replace(/\s*$/, '');
    return `${trimmed}\n\n## 未対応\n\n${entryText}\n`;
  }
  let endIdx = lines.length;
  for (let i = headIdx + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const block = lines.slice(headIdx + 1, endIdx).filter((l) => !/^\s*（なし）\s*$/.test(l));
  while (block.length && !block[block.length - 1].trim()) block.pop();
  const body = block.filter((l) => l.trim()).length ? [...block, entryText] : [entryText];
  const next = [...lines.slice(0, headIdx + 1), '', ...body, '', ...lines.slice(endIdx)];
  return `${next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`;
}

/** inbox.md に残っている目印を読む。未対応から消えていれば「対応済み」とみなす。 */
export function parseInboxMarkers(inboxText) {
  const status = new Map();
  if (!inboxText) return status;
  let current = '';
  for (const line of inboxText.split('\n')) {
    const head = line.match(/^##\s*(.+)$/);
    if (head) {
      current = head[1].trim();
      continue;
    }
    const marker = line.match(new RegExp(`<!--\\s*${MARKER}:id=([A-Za-z0-9_]+)`));
    if (marker) status.set(marker[1], /未対応/.test(current) ? 'open' : 'resolved');
  }
  return status;
}

export async function readInbox(novel) {
  return readIfExists(path.join(novel.workdir, novel.inboxPath));
}

export async function writeInbox(novel, text) {
  const file = path.join(novel.workdir, novel.inboxPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}
