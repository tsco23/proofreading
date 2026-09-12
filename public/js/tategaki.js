/**
 * 縦書きの本文表示。
 * 原稿の生テキストを段落に割り、各段落に「本文の何文字目から」を持たせる。
 * 選択・しおり・指摘の位置は、すべてこの文字位置で表す。
 */
export class Tategaki {
  constructor(container) {
    this.el = container;
    this.text = '';
    this.blocks = [];
    this.showNumbers = false;
    this.el.addEventListener('wheel', (ev) => {
      // 縦書きなので、縦のホイールを横スクロールに振り替える
      if (ev.deltaY === 0) return;
      ev.preventDefault();
      this.el.scrollLeft -= ev.deltaY + ev.deltaX;
    }, { passive: false });
  }

  /** 生テキストを段落に割る。行の位置（文字数）を保つ。 */
  static parse(text) {
    const blocks = [];
    let index = 0;
    let blanks = 0;
    for (const line of text.split('\n')) {
      if (line.trim()) {
        if (blanks >= 2) blocks.push({ type: 'gap' });
        blocks.push({ type: 'p', start: index, end: index + line.length, text: line });
        blanks = 0;
      } else {
        blanks += 1;
      }
      index += line.length + 1;
    }
    return blocks;
  }

  render(text, { showNumbers = false } = {}) {
    this.text = text;
    this.showNumbers = showNumbers;
    this.blocks = Tategaki.parse(text);
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const block of this.blocks) {
      if (block.type === 'gap') {
        frag.append(Object.assign(document.createElement('p'), { className: 'spacer' }));
        continue;
      }
      n += 1;
      const p = document.createElement('p');
      p.className = 'para';
      p.dataset.start = String(block.start);
      p.dataset.end = String(block.end);
      if (showNumbers) p.dataset.n = String(n);
      p.textContent = block.text;
      frag.append(p);
    }
    const end = document.createElement('p');
    end.className = 'section-end';
    end.textContent = '（節の終わり）';
    frag.append(end);

    this.el.replaceChildren(frag);
    this.el.scrollLeft = 0;
    this.toStart();
  }

  paragraphs() {
    return [...this.el.querySelectorAll('p.para')];
  }

  /** 指摘やしおりの位置に色を敷く。ranges: [{start,end,className,id,title}] */
  highlight(ranges) {
    for (const p of this.paragraphs()) {
      const start = Number(p.dataset.start);
      const end = Number(p.dataset.end);
      const hits = ranges
        .filter((r) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > start && r.start < end)
        .map((r) => ({ ...r, from: Math.max(0, r.start - start), to: Math.min(end - start, r.end - start) }))
        .sort((a, b) => a.from - b.from);
      const text = this.text.slice(start, end);
      if (!hits.length) {
        if (p.childNodes.length !== 1 || p.firstChild.nodeType !== 3) p.textContent = text;
        continue;
      }
      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const hit of hits) {
        const from = Math.max(cursor, hit.from);
        if (from >= hit.to) continue;
        if (from > cursor) frag.append(document.createTextNode(text.slice(cursor, from)));
        const mark = document.createElement('mark');
        mark.className = hit.className || '';
        if (hit.id) mark.dataset.markId = hit.id;
        if (hit.title) mark.title = hit.title;
        mark.textContent = text.slice(from, hit.to);
        frag.append(mark);
        cursor = hit.to;
      }
      if (cursor < text.length) frag.append(document.createTextNode(text.slice(cursor)));
      p.replaceChildren(frag);
    }
  }

  paragraphOf(node) {
    let current = node;
    while (current && current !== this.el) {
      if (current.nodeType === 1 && current.classList.contains('para')) return current;
      current = current.parentNode;
    }
    return null;
  }

  /** いま選択されている範囲を、本文の文字位置で返す。 */
  selectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.el.contains(range.commonAncestorContainer)) return null;
    const startP = this.paragraphOf(range.startContainer);
    const endP = this.paragraphOf(range.endContainer);
    if (!startP || !endP) return null;

    const offsetIn = (p, node, offset) => {
      const probe = document.createRange();
      probe.selectNodeContents(p);
      probe.setEnd(node, offset);
      return probe.toString().length;
    };
    const start = Number(startP.dataset.start) + offsetIn(startP, range.startContainer, range.startOffset);
    const end = Number(endP.dataset.start) + offsetIn(endP, range.endContainer, range.endOffset);
    if (end <= start) return null;
    return { start, end, text: this.text.slice(start, end), rect: range.getBoundingClientRect() };
  }

  paragraphAt(offset) {
    const paras = this.paragraphs();
    let found = null;
    for (const p of paras) {
      if (Number(p.dataset.start) <= offset) found = p;
      if (Number(p.dataset.start) > offset) break;
    }
    return found || paras[0] || null;
  }

  /** 文字位置まで送る。scrollIntoView は縦書きだと当てにならないので実測で寄せる。 */
  scrollToOffset(offset, { smooth = false, flash = false } = {}) {
    const p = this.paragraphAt(offset);
    if (!p) return;
    const behavior = this.el.style.scrollBehavior;
    this.el.style.scrollBehavior = smooth ? 'smooth' : 'auto';
    const box = this.el.getBoundingClientRect();
    const style = getComputedStyle(this.el);
    const padRight = parseFloat(style.paddingRight) || 0;
    const target = box.right - padRight;
    this.el.scrollLeft += p.getBoundingClientRect().right - target;
    this.el.style.scrollBehavior = behavior;
    if (flash) {
      p.classList.add('para--flash');
      const mark = p.querySelector('mark');
      if (mark) {
        mark.classList.add('mark--flash');
        setTimeout(() => mark.classList.remove('mark--flash'), 2400);
      }
    }
  }

  toStart() {
    const first = this.paragraphs()[0];
    if (first) this.scrollToOffset(Number(first.dataset.start));
  }

  /** いま画面のいちばん右（＝読んでいる先頭）にある段落から、現在位置を出す。 */
  position() {
    const box = this.el.getBoundingClientRect();
    let best = null;
    for (const p of this.paragraphs()) {
      const rect = p.getBoundingClientRect();
      if (rect.right < box.left - 1 || rect.left > box.right + 1) continue;
      if (!best || rect.right > best.rect.right) best = { p, rect };
    }
    const offset = best ? Number(best.p.dataset.start) : 0;
    const total = Math.max(1, this.text.length);
    const scroll = this.scrollProgress();
    return { offset, percent: Math.max(scroll, Math.min(1, offset / total)) };
  }

  /** 横スクロール量から読み進み具合を出す（末尾で 1 になる）。 */
  scrollProgress() {
    const max = this.el.scrollWidth - this.el.clientWidth;
    if (max <= 0) return 1;
    const left = Math.abs(this.el.scrollLeft);
    // ブラウザによって scrollLeft の向きが違うので、絶対値で見る
    const forward = this.el.scrollLeft <= 0 ? left : max - left;
    return Math.min(1, Math.max(0, forward / max));
  }

  page(direction) {
    // 縦書きは右から左へ進む。進む＝ scrollLeft を減らす
    const step = Math.max(120, this.el.clientWidth - Math.round(this.el.clientWidth * 0.08));
    this.el.scrollBy({ left: direction === 'next' ? -step : step, behavior: 'smooth' });
  }

  atEnd() {
    return this.scrollProgress() > 0.995;
  }

  atStart() {
    return this.scrollProgress() < 0.005;
  }
}
