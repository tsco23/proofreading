import { $, el, busy, toast, formatDate } from './util.js';
import { api } from './api.js';

let current = null;

function lineNodes(row, side) {
  const text = side === 'before' ? row.before : row.after;
  if (text == null) {
    return el('p', { class: 'compare__line compare__line--gap', text: side === 'before' ? '（この行は無かった）' : '（この行は消えた）' });
  }
  if (row.type === 'change' && row.parts) {
    const p = el('p', { class: `compare__line compare__line--${side === 'before' ? 'del' : 'ins'}` });
    for (const part of row.parts) {
      if (part.type === 'equal') p.append(document.createTextNode(part.text));
      else if (part.type === 'del' && side === 'before') p.append(el('del', { text: part.text }));
      else if (part.type === 'ins' && side === 'after') p.append(el('ins', { text: part.text }));
    }
    return p;
  }
  const cls = row.type === 'del' ? 'compare__line--del' : row.type === 'ins' ? 'compare__line--ins' : '';
  return el('p', { class: `compare__line ${cls}`.trim(), text });
}

function pickRows(rows, showAll) {
  if (showAll) return rows.map((row) => ({ row }));
  const keep = new Set();
  rows.forEach((row, i) => {
    if (row.type === 'equal') return;
    for (let j = i - 1; j <= i + 1; j += 1) if (rows[j]) keep.add(j);
  });
  const out = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    if (keep.has(i)) {
      if (skipped) {
        out.push({ gap: skipped });
        skipped = 0;
      }
      out.push({ row });
    } else {
      skipped += 1;
    }
  });
  if (skipped) out.push({ gap: skipped });
  return out;
}

function renderPanes() {
  if (!current) return;
  const showAll = $('#compare-all').checked;
  const yoko = $('#compare-yoko').checked;
  const picked = pickRows(current.diff.rows, showAll);

  const build = (side, title) => {
    const lines = el('div', { class: `compare__lines ${yoko ? '' : 'tategaki-mini'}`.trim() });
    for (const item of picked) {
      if (item.gap) {
        lines.append(el('p', {
          class: 'compare__line compare__line--gap',
          title: `変わっていない ${item.gap} 行`,
          text: `⋯ ${item.gap} 行 ⋯`,
        }));
      } else {
        lines.append(lineNodes(item.row, side));
      }
    }
    if (!picked.length) lines.append(el('p', { class: 'compare__line compare__line--gap', text: 'この節は指摘の時点から変わっていません' }));
    return el('div', { class: 'compare__pane' }, [el('h3', { text: title }), lines]);
  };

  $('#compare-body').replaceChildren(
    build('before', `指摘した時点（${current.before.sha.slice(0, 7)}）`),
    build('after', current.after.sha ? `いま（${current.after.sha.slice(0, 7)}）` : 'いま'),
  );
}

function renderSummary(payload) {
  const { annotation, diff, commits } = payload;
  const stats = diff.stats;
  const summary = $('#compare-summary');
  const parts = [
    el('div', {}, [
      el('strong', { text: `${annotation.sectionLabel || annotation.sectionId}` }),
      ` ／ ${annotation.userName} ／ ${formatDate(annotation.createdAt)}`,
    ]),
    annotation.quote ? el('div', { class: 'note__quote', text: annotation.quote }) : null,
    el('div', { text: annotation.body }),
    el('div', {
      text: stats.changed
        ? `指摘のあと ${stats.rewritten} 行が書き直され、${stats.added} 行増え、${stats.removed} 行消えました`
        : '指摘のあと、この節の本文はまだ変わっていません',
    }),
    commits.length
      ? el('div', { text: `この節に入ったコミット: ${commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join(' / ')}` })
      : null,
  ];
  summary.replaceChildren(...parts.filter(Boolean));
}

export async function openCompare(novelId, annotationId) {
  busy(true);
  try {
    const payload = await api.compare(novelId, annotationId);
    current = payload;
    renderSummary(payload);
    // 直しが入っていなければ、比べるものが無いので全文を出しておく
    $('#compare-all').checked = payload.diff.stats.changed === 0;
    renderPanes();
    $('#compare').hidden = false;
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    busy(false);
  }
}

export function initCompare() {
  $('#compare-all').addEventListener('change', renderPanes);
  $('#compare-yoko').addEventListener('change', renderPanes);
}

export function closeCompare() {
  $('#compare').hidden = true;
  current = null;
}
