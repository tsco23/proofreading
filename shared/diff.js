/**
 * 指摘の前後を並べて見るための差分。
 * 行（＝段落）単位で LCS を取り、置き換えになった対だけ文字単位で細かく取る。
 * 1 節はせいぜい 300 行なので素直な DP で足りる。
 */

function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

function backtrack(a, b, table) {
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', a: a[i], b: b[j], ai: i, bi: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: 'del', a: a[i], ai: i });
      i += 1;
    } else {
      ops.push({ type: 'ins', b: b[j], bi: j });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ type: 'del', a: a[i], ai: i++ });
  while (j < b.length) ops.push({ type: 'ins', b: b[j], bi: j++ });
  return ops;
}

export function diffSequence(a, b) {
  return backtrack(a, b, lcsTable(a, b));
}

/** 文字単位の差分。長すぎる行は丸ごと置き換え扱いにして DP を避ける。 */
export function diffChars(a, b) {
  const LIMIT = 2000;
  if (a.length > LIMIT || b.length > LIMIT) {
    return [{ type: 'del', text: a }, { type: 'ins', text: b }];
  }
  const ca = [...a];
  const cb = [...b];
  const ops = diffSequence(ca, cb);
  const out = [];
  for (const op of ops) {
    const text = op.type === 'ins' ? op.b : op.a;
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += text;
    else out.push({ type: op.type, text });
  }
  return out;
}

function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  const table = lcsTable([...a], [...b]);
  return (2 * table[0][0]) / (a.length + b.length);
}

/**
 * 前後 2 つの本文を並べた行を返す。
 * type は equal / change / del / ins。change には文字単位の内訳が付く。
 */
export function diffTexts(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const ops = diffSequence(a, b);

  const rows = [];
  let pendingDel = [];
  let pendingIns = [];

  const flush = () => {
    while (pendingDel.length || pendingIns.length) {
      const d = pendingDel[0];
      const i = pendingIns[0];
      if (d != null && i != null && similarity(d.text, i.text) >= 0.3) {
        rows.push({
          type: 'change',
          before: d.text,
          after: i.text,
          beforeLine: d.line,
          afterLine: i.line,
          parts: diffChars(d.text, i.text),
        });
        pendingDel.shift();
        pendingIns.shift();
      } else if (d != null && (i == null || pendingDel.length >= pendingIns.length)) {
        rows.push({ type: 'del', before: d.text, after: null, beforeLine: d.line, afterLine: null });
        pendingDel.shift();
      } else {
        rows.push({ type: 'ins', before: null, after: i.text, beforeLine: null, afterLine: i.line });
        pendingIns.shift();
      }
    }
    pendingDel = [];
    pendingIns = [];
  };

  for (const op of ops) {
    if (op.type === 'equal') {
      flush();
      rows.push({ type: 'equal', before: op.a, after: op.b, beforeLine: op.ai, afterLine: op.bi });
    } else if (op.type === 'del') {
      pendingDel.push({ text: op.a, line: op.ai });
    } else {
      pendingIns.push({ text: op.b, line: op.bi });
    }
  }
  flush();

  const changed = rows.filter((r) => r.type !== 'equal');
  return {
    rows,
    stats: {
      changed: changed.length,
      added: rows.filter((r) => r.type === 'ins').length,
      removed: rows.filter((r) => r.type === 'del').length,
      rewritten: rows.filter((r) => r.type === 'change').length,
    },
  };
}

/** 二つの文字列に共通する、いちばん長い連なり。直された箇所を探すのに使う。 */
function longestCommonRun(text, quote) {
  const a = [...text];
  const b = [...quote];
  let prev = new Uint32Array(b.length + 1);
  let best = { length: 0, end: 0 };
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Uint32Array(b.length + 1);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      row[j] = prev[j - 1] + 1;
      if (row[j] > best.length) best = { length: row[j], end: i };
    }
    prev = row;
  }
  return best;
}

/**
 * 指摘が付いた箇所が、いま本文のどこにあるか。
 * そのまま残っていれば exact、直されていれば手掛かりの位置を exact:false で返す。
 * 跡形もなければ null。
 *
 * 同じ言い回しが節の中に何度も出ることがあるので、**元の位置にいちばん近いもの**を選ぶ。
 */
export function locateQuote(text, quote, hintStart = 0) {
  if (!quote) return null;

  let best = null;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const distance = Math.abs(at - hintStart);
    if (!best || distance < best.distance) best = { start: at, distance };
    if (at > hintStart) break; // これ以上は遠ざかるだけ
  }
  if (best) return { start: best.start, end: best.start + quote.length, exact: true };

  const threshold = Math.max(3, Math.ceil(quote.length * 0.2));
  const run = longestCommonRun(text, quote);
  if (run.length >= threshold) {
    return { start: run.end - run.length, end: run.end, exact: false };
  }
  return null;
}

/**
 * 指摘の位置を、いまの本文に合わせ直す。
 *
 * 指摘は「本文の何文字目か」で持っているが、作者が前のほうを直せばその数はずれる。
 * 引用した文字列を今の本文から探し直して、色を敷く位置を決める。
 *   exact … 引用がそのまま残っている（動いていても構わない）
 *   near  … 直されていて、手掛かりの位置しか分からない
 *   lost  … 跡形もない
 *   none  … 引用のない指摘（節そのものへの指摘）
 */
export function relocate(text, annotation) {
  if (!annotation.quote) return { ...annotation, located: 'none' };
  const hit = locateQuote(text, annotation.quote, annotation.start ?? 0);
  if (!hit) return { ...annotation, start: null, end: null, located: 'lost' };
  return { ...annotation, start: hit.start, end: hit.end, located: hit.exact ? 'exact' : 'near' };
}

export function relocateAll(text, annotations) {
  return annotations.map((a) => relocate(text, a));
}
