/**
 * 原稿の読み取り（純粋な部分）。
 * ファイル入出力も git も触らないので、Node のサーバからも Cloudflare Workers からも使える。
 */

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

/**
 * 作品の根（workDir）を前に付けて、原稿・構成・節・受け取り箱の置き場を決める。
 *
 * 原稿リポジトリは一つの中に作品を複数持てる形（`works/<作品>/…`）になった。
 * 置き場の指定はどれも**作品の根からの相対**で書き、ここで根を前に付ける。
 * 根が無ければ（リポジトリ直下に作品がある古い形）何もしない。
 */
export const WORK_PATH_KEYS = ['manuscriptDir', 'inboxPath', 'structurePath', 'sectionsPath'];

export function applyWorkDir(novel) {
  const root = String(novel.workDir || '').replace(/^\/+|\/+$/g, '');
  if (!root) return novel;
  if (root.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`workDir に .. や . は使えません: ${novel.workDir}`);
  }
  const out = { ...novel, workDir: root };
  for (const key of WORK_PATH_KEYS) {
    out[key] = `${root}/${String(novel[key]).replace(/^\/+/, '')}`;
  }
  return out;
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

/**
 * 本文から注（<!-- … -->）を落とした清書を返す。**数えるときだけに使う。**
 * 本文にはビートの印（<!-- @b1 -->）や書きかけの覚え書きが入ることがあり、
 * 校正にも使うので**画面では消さない**。字数と目次の冒頭文だけは、
 * 作者の道具（`frame/tools/lib_beats.py` の strip()）と同じ清書から数える。
 */
export function stripNotes(text) {
  return String(text)
    .replace(/[ 　]*<!--[\s\S]*?-->[ 　]*\n?/g, '')
    .replace(/\n{3,}/g, '\n\n');
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


const CHAPTER_HEADING = /^#(?!#)\s*第([〇一二三四五六七八九十\d]+)章[\s　]*(.*)$/;
const CHAPTER_CELL = /^第([〇一二三四五六七八九十\d]+)章[\s　]*(.*)$/;

/**
 * outline/structure.md から章題を拾う。
 * 書き方が二通りある。どちらでも読む。
 *   表 … `| 一 | 出遅れ | … |` や `| 第一章 幌 | 4 | … |`
 *   見出し … `# 第一章　幌`（枠の schema.toml が求める形。こちらを優先する）
 */
export function parseChapterTitles(text) {
  const out = new Map();
  if (!text) return out;
  const fromHeadings = new Map();
  for (const line of text.split('\n')) {
    const heading = line.match(CHAPTER_HEADING);
    if (heading) {
      const num = parseKanjiNumber(heading[1]);
      if (num) fromHeadings.set(num, { title: stripMd(heading[2]), period: '', role: '' });
      continue;
    }
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => stripMd(c));
    if (cells.length < 2) continue;

    const labelled = cells[0].match(CHAPTER_CELL);
    if (labelled) {
      const num = parseKanjiNumber(labelled[1]);
      if (num && labelled[2] && !out.has(num)) out.set(num, { title: labelled[2], period: '', role: '' });
      continue;
    }
    const num = parseKanjiNumber(cells[0]);
    if (!num || !cells[1] || cells[1] === '題') continue;
    out.set(num, { title: cells[1], period: cells[2] || '', role: cells[cells.length - 1] || '' });
  }
  for (const [num, info] of fromHeadings) {
    if (info.title) out.set(num, { ...out.get(num), ...info });
  }
  return out;
}

const SECTION_FIELDS = {
  出来事: 'summary',
  視点: 'viewpoint',
  時: 'time',
  場所: 'place',
  型: 'type',
  引き: 'hook',
  要確認: 'check',
};

/**
 * outline/sections.md から節ごとの設計（出来事・視点・時・場所・型・引き）を拾う。
 *
 * 書き方が二通りある。どちらでも読む。
 *   旧 … `- **視点** 湊／**時** 四月中旬／**場所** 教室` を一行に並べ、あらすじは無印の箇条
 *   新 … `- **視点** 灯` のように一欄一行。**出来事**は次の行から字下げして続く
 * 「（設計に無い）」の欄は書き手への注なので、あらすじには混ぜない。
 */
export function parseSectionMeta(text) {
  const out = new Map();
  if (!text) return out;
  let chapter = '';
  let current = null;
  let field = null; // 字下げの続きの行を、どの欄へ足すか

  const put = (key, value) => {
    if (key === 'summary') current.summary.push(value);
    else current[key] = value;
    field = key;
  };
  const extend = (value) => {
    if (field === 'summary') current.summary[current.summary.length - 1] += value;
    else current[field] += value;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (/^# (?!#)/.test(line)) {
      chapter = line.slice(2).trim();
      current = null;
      continue;
    }
    const head = line.match(/^##\s+(ch\d+-\d+)/);
    if (head) {
      current = {
        id: head[1], chapterHeading: chapter, summary: [],
        viewpoint: '', time: '', place: '', type: '', hook: '', check: '',
      };
      out.set(head[1], current);
      field = null;
      continue;
    }
    if (line.startsWith('## ') || line.startsWith('# ')) {
      current = null;
      continue;
    }
    if (!current) continue;
    if (!line.trim()) {
      field = null;
      continue;
    }

    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (!bullet) {
      // 箇条の続き（字下げした行）
      if (field) extend(stripMd(line));
      continue;
    }

    const body = bullet[1];
    const plain = stripMd(body);

    // 旧書式：視点・時・場所を「／」で一行に並べていた
    if (/^視点/.test(plain) && plain.includes('／')) {
      for (const part of plain.split('／')) {
        const t = part.trim();
        if (t.startsWith('視点')) current.viewpoint = t.replace(/^視点\s*/, '');
        else if (t.startsWith('時')) current.time = t.replace(/^時\s*/, '');
        else if (t.startsWith('場所')) current.place = t.replace(/^場所\s*/, '');
      }
      field = null;
      continue;
    }

    const labelled = body.match(/^\*\*(.+?)\*\*\s*(.*)$/);
    const label = labelled ? stripMd(labelled[1]) : '';
    if (labelled && SECTION_FIELDS[label]) {
      put(SECTION_FIELDS[label], stripMd(labelled[2]));
    } else if (labelled && /設計に無い/.test(label)) {
      field = null; // 書き手への注。読む人には出さない
    } else if (plain) {
      put('summary', plain); // 旧書式の無印の箇条、または太字で始まるだけの文
    }
  }
  for (const meta of out.values()) meta.summary = meta.summary.filter(Boolean).join(' ');
  return out;
}

function firstLine(text) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/**
 * 本文ファイルの一覧から章立てを組む。目次はこれで自動生成される。
 * files: [{ path, text }]。字数と冒頭が分かっているときは
 * [{ path, chars, opening }] でもよい（控えから組み直すとき）。
 */
export function buildToc({ files, structureText = '', sectionsText = '' }) {
  const titles = parseChapterTitles(structureText);
  const metas = parseSectionMeta(sectionsText);

  const byChapter = new Map();
  for (const file of files) {
    const m = /(?:^|\/)ch(\d+)-(\d+)\.md$/.exec(file.path);
    if (!m) continue;
    const chapter = Number(m[1]);
    const index = Number(m[2]);
    const id = `ch${chapter}-${String(m[2])}`;
    const meta = metas.get(id) || {};
    if (!byChapter.has(chapter)) byChapter.set(chapter, []);
    byChapter.get(chapter).push({
      id,
      path: file.path,
      chapter,
      index,
      label: `第${kanjiNumber(chapter)}章 第${kanjiNumber(index)}節`,
      chars: file.chars ?? countChars(stripNotes(file.text)),
      opening: file.opening ?? firstLine(stripNotes(file.text)).slice(0, 40),
      viewpoint: meta.viewpoint || '',
      time: meta.time || '',
      place: meta.place || '',
      summary: meta.summary || '',
      hook: meta.hook || '',
    });
  }

  const chapters = [...byChapter.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, sections]) => {
      sections.sort((a, b) => a.index - b.index);
      const info = titles.get(number) || {};
      return {
        number,
        title: info.title || '',
        period: info.period || '',
        role: info.role || '',
        label: `第${kanjiNumber(number)}章${info.title ? ` ${info.title}` : ''}`,
        chars: sections.reduce((sum, s) => sum + s.chars, 0),
        sections,
      };
    });

  const written = new Set(chapters.flatMap((c) => c.sections.map((s) => s.id)));
  const planned = [];
  for (const [id, meta] of metas) {
    if (written.has(id)) continue;
    const m = SECTION_RE.exec(id);
    if (!m) continue;
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

  return {
    chapters,
    planned: planned.sort((a, b) => sectionOrder(a.id) - sectionOrder(b.id)),
    chars: chapters.reduce((sum, c) => sum + c.chars, 0),
    sections: chapters.flatMap((c) => c.sections.map((s) => s.id)),
  };
}

/** 目次の中から節を引く。 */
export function findSection(toc, sectionId) {
  return toc.chapters.flatMap((c) => c.sections).find((s) => s.id === sectionId) || null;
}

/** 前後の節を添える。 */
export function withNeighbours(toc, sectionId) {
  const ids = toc.sections;
  const at = ids.indexOf(sectionId);
  return {
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
  // 無ければ枠の型紙（frame/templates/review/inbox.md）と同じ形で作る
  const text = inboxText == null ? '# 作者からの指摘\n\n## 未対応\n\n（なし）\n\n## 済\n' : inboxText;
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

