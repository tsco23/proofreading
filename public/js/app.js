import { $, $$, el, toast, busy, debounce, formatDate, counts, local } from './util.js';
import { api } from './api.js';
import { Tategaki } from './tategaki.js';
import { openCompare, initCompare, closeCompare } from './compare.js';

const state = {
  user: null,
  novels: [],
  novel: null,
  toc: null,
  section: null,
  annotations: [],
  bookmarks: [],
  selection: null,
  compose: null,
  noteFilter: 'section',
};

const settings = Object.assign(
  { fs: 20, lh: 19, theme: 'paper', font: 'mincho', numbers: false },
  local.get('settings', {}),
);

let view = null;

/* ---------- 画面の出し入れ ---------- */

function showScreen(name) {
  for (const id of ['login', 'library', 'reader']) {
    $(`#screen-${id}`).hidden = id !== name;
  }
  if (name !== 'reader') closeDrawer();
}

function applySettings() {
  document.documentElement.style.setProperty('--fs', `${settings.fs}px`);
  document.documentElement.style.setProperty('--lh', String(settings.lh / 10));
  document.body.dataset.theme = settings.theme;
  document.body.dataset.font = settings.font;
  $('#out-fs').textContent = `${settings.fs}px`;
  $('#out-lh').textContent = (settings.lh / 10).toFixed(1);
  $('#set-fs').value = settings.fs;
  $('#set-lh').value = settings.lh;
  $('#set-theme').value = settings.theme;
  $('#set-font').value = settings.font;
  $('#set-ruby').checked = settings.numbers;
  local.set('settings', settings);
}

/* ---------- 認証 ---------- */

async function boot() {
  applySettings();
  bindEvents();
  initCompare();
  view = new Tategaki($('#reader-body'));
  bindReader();

  try {
    const me = await api.me();
    state.user = me.user;
    setupSignup(me.signup);
    if (state.user) await showLibrary();
    else showScreen('login');
  } catch (err) {
    showScreen('login');
    loginError(err.message);
  }
  registerServiceWorker();
}

function setupSignup(signup) {
  const block = $('#signup-block');
  block.hidden = !signup.enabled;
  $('#invite-field').hidden = !signup.needsInvite;
  if (signup.bootstrap) {
    block.open = true;
    block.querySelector('summary').textContent = 'まだ誰も登録されていません。最初の校正者を作る';
  }
}

function loginError(message) {
  const node = $('#login-error');
  node.textContent = message || '';
  node.hidden = !message;
}

/* ---------- 作品一覧 ---------- */

async function showLibrary() {
  showScreen('library');
  $('#library-user').textContent = `${state.user.name} さん`;
  busy(true);
  try {
    const { novels } = await api.novels();
    state.novels = novels;
    const list = $('#library-list');
    list.replaceChildren(...novels.map(novelCard));
    if (!novels.length) list.append(el('p', { class: 'muted', text: '作品が登録されていません。config/novels.json を確かめてください。' }));
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    busy(false);
  }
}

function novelCard(novel) {
  const pos = novel.position;
  const actions = [
    el('button', {
      class: 'btn btn--primary',
      type: 'button',
      onclick: () => openNovel(novel.id, pos ? { sectionId: pos.sectionId, offset: pos.offset } : {}),
      text: pos ? '続きから読む' : '読みはじめる',
    }),
    el('button', {
      class: 'btn',
      type: 'button',
      onclick: () => openNovel(novel.id, { sectionId: null, offset: 0, fromStart: true }),
      text: '最初から',
    }),
  ];
  return el('article', { class: 'novel' }, [
    el('h2', { text: novel.title }),
    el('dl', {}, [
      el('dt', { text: '原稿' }), el('dd', { text: `${novel.repo || ''}` }),
      el('dt', { text: '枝' }), el('dd', { text: novel.branch }),
      el('dt', { text: '分量' }), el('dd', { text: novel.chars != null ? `${counts(novel.chars)} 字 ／ ${novel.sections} 節` : '読み込み中…' }),
      el('dt', { text: 'しおり' }), el('dd', { text: `${novel.bookmarks} 本` }),
      pos ? el('dt', { text: '前回' }) : null,
      pos ? el('dd', { text: `${pos.sectionId} の ${Math.round((pos.percent || 0) * 100)}%（${formatDate(pos.updatedAt)}）` }) : null,
    ]),
    novel.error ? el('p', { class: 'error small', text: novel.error }) : null,
    el('div', { class: 'novel__actions' }, actions),
  ]);
}

/* ---------- 読む ---------- */

async function openNovel(novelId, { sectionId = null, offset = 0, fromStart = false } = {}) {
  busy(true);
  try {
    const [tocRes, stateRes] = await Promise.all([api.toc(novelId), api.state(novelId)]);
    state.novel = tocRes.novel;
    state.toc = tocRes.toc;
    state.bookmarks = stateRes.bookmarks || [];
    const saved = stateRes.position;
    let target = sectionId;
    let at = offset;
    if (!target && !fromStart && saved && state.toc.sections.includes(saved.sectionId)) {
      target = saved.sectionId;
      at = saved.offset || 0;
    }
    if (!target) {
      target = state.toc.sections[0];
      at = 0;
    }
    if (!target) {
      toast('本文がまだ 1 節もありません', { error: true });
      return;
    }
    showScreen('reader');
    await loadSection(target, { offset: at });
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    busy(false);
  }
}

async function loadSection(sectionId, { offset = 0, flash = false } = {}) {
  busy(true);
  try {
    const res = await api.section(state.novel.id, sectionId);
    state.section = res.section;
    state.annotations = res.annotations;
    $('#reader-novel').textContent = state.novel.title;
    const s = res.section;
    $('#reader-section').textContent = [s.label, s.viewpoint ? `視点 ${s.viewpoint}` : '', `${counts(s.chars)} 字`]
      .filter(Boolean).join('　');
    view.render(s.text, { showNumbers: settings.numbers });
    applyHighlights();
    if (offset > 0) view.scrollToOffset(offset, { flash });
    $('#btn-prev-section').disabled = !s.prev;
    $('#btn-next-section').disabled = !s.next;
    updateProgress();
    savePosition();
    if (!$('#drawer').hidden) renderDrawer();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    busy(false);
  }
}

function applyHighlights() {
  if (!state.section) return;
  const ranges = [];
  for (const a of state.annotations) {
    if (!Number.isInteger(a.start) || !Number.isInteger(a.end)) continue;
    ranges.push({
      start: a.start,
      end: a.end,
      id: a.id,
      className: a.status === 'resolved' ? 'mark--done' : 'mark--open',
      title: `${a.userName}：${a.body.slice(0, 60)}`,
    });
  }
  for (const b of state.bookmarks.filter((b) => b.sectionId === state.section.id)) {
    ranges.push({
      start: b.offset,
      end: b.offset + Math.max(1, (b.quote || '').length),
      id: b.id,
      className: 'mark--bookmark',
      title: `しおり：${b.note || b.quote || ''}`,
    });
  }
  view.highlight(ranges);
}

function updateProgress() {
  const pos = view.position();
  $('#progress-bar').style.width = `${Math.round(pos.percent * 100)}%`;
  $('#progress-label').textContent = `${Math.round(pos.percent * 100)}%`;
}

const savePosition = debounce(async () => {
  if (!state.novel || !state.section) return;
  const pos = view.position();
  local.set(`pos.${state.novel.id}`, { sectionId: state.section.id, ...pos });
  try {
    await api.savePosition(state.novel.id, { sectionId: state.section.id, offset: pos.offset, percent: pos.percent });
  } catch { /* 通信が切れていても読書は続けられる */ }
}, 1200);

/* ---------- 選択と指摘 ---------- */

function hideSelectionMenu() {
  $('#selection-menu').hidden = true;
}

const refreshSelection = debounce(() => {
  if (!$('#compose').hidden) return; // 指摘を書いている間は選択を捨てない
  const sel = view.selectionRange();
  const menu = $('#selection-menu');
  if (!sel) {
    state.selection = null;
    menu.hidden = true;
    return;
  }
  state.selection = sel;
  menu.hidden = false;
  const rect = sel.rect;
  const width = menu.offsetWidth || 220;
  const height = menu.offsetHeight || 44;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.min(window.innerWidth - width - 8, Math.max(8, left));
  let top = rect.top - height - 10;
  if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 10);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}, 80);

function openCompose({ whole = false } = {}) {
  if (!whole && !state.selection) return;
  // 本文から目が離れても引用を保てるよう、この時点で控えを取る
  state.compose = whole ? null : { ...state.selection };
  $('#compose-quote').textContent = state.compose ? state.compose.text : '（引用なし・節そのものへの指摘）';
  $('#compose-target').textContent = `${state.section.label}（${state.section.id}）`;
  $('#compose-path').textContent = 'review/inbox.md';
  $('#compose-body').value = '';
  $('#compose').hidden = false;
  $('#compose-body').focus();
  hideSelectionMenu();
}

async function submitAnnotation() {
  const body = $('#compose-body').value.trim();
  if (!body) {
    toast('指摘の中身を書いてください', { error: true });
    return;
  }
  const sel = state.compose;
  busy(true);
  try {
    const res = await api.addAnnotation(state.novel.id, {
      sectionId: state.section.id,
      quote: sel?.text || '',
      start: sel?.start ?? null,
      end: sel?.end ?? null,
      body,
    });
    $('#compose').hidden = true;
    state.compose = null;
    const sha = (res.commit?.sha || '').slice(0, 7);
    toast(res.commit?.pushed
      ? `inbox.md に書いて押しました（${sha}）`
      : `inbox.md に書きました（${sha}／push は止めてあります）`);
    await refreshAnnotations();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    busy(false);
  }
}

async function refreshAnnotations() {
  const res = await api.annotations(state.novel.id, { section: state.section.id });
  state.annotations = res.annotations;
  applyHighlights();
  if (!$('#drawer').hidden && $('#drawer').dataset.kind === 'notes') renderDrawer();
}

async function addBookmark() {
  const sel = state.selection;
  const offset = sel ? sel.start : view.position().offset;
  const quote = sel ? sel.text.slice(0, 60) : view.text?.slice(offset, offset + 30) || '';
  busy(true);
  try {
    const res = await api.addBookmark(state.novel.id, {
      sectionId: state.section.id,
      offset,
      quote,
    });
    state.bookmarks.push(res.bookmark);
    applyHighlights();
    hideSelectionMenu();
    toast('しおりを挟みました');
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    busy(false);
  }
}

/* ---------- 引き出し（目次・しおり・指摘） ---------- */

function openDrawer(kind) {
  const drawer = $('#drawer');
  drawer.hidden = false;
  drawer.dataset.kind = kind;
  for (const tab of $$('.drawer__tabs .btn')) {
    tab.setAttribute('aria-selected', String(tab.dataset.panel === kind));
  }
  renderDrawer();
}

function closeDrawer() {
  $('#drawer').hidden = true;
}

function renderDrawer() {
  const kind = $('#drawer').dataset.kind;
  const body = $('#drawer-body');
  if (kind === 'toc') body.replaceChildren(renderToc());
  else if (kind === 'marks') body.replaceChildren(renderBookmarks());
  else body.replaceChildren(renderNotes());
}

function renderToc() {
  const frag = document.createDocumentFragment();
  frag.append(el('div', { class: 'novel__actions' }, [
    el('button', {
      class: 'btn btn--ghost', type: 'button', text: '原稿を最新にする',
      onclick: async () => {
        busy(true);
        try {
          await api.sync(state.novel.id);
          const res = await api.toc(state.novel.id);
          state.toc = res.toc;
          toast('最新の原稿に追いつきました');
          await loadSection(state.section.id, { offset: view.position().offset });
          renderDrawer();
        } catch (err) {
          toast(err.message, { error: true });
        } finally {
          busy(false);
        }
      },
    }),
    el('span', { class: 'muted small', text: `全 ${counts(state.toc.chars)} 字` }),
  ]));

  for (const chapter of state.toc.chapters) {
    frag.append(el('h3', { class: 'toc-chapter' }, [
      chapter.label,
      el('span', { class: 'muted', text: `${chapter.sections.length} 節 ／ ${counts(chapter.chars)} 字` }),
    ]));
    for (const section of chapter.sections) {
      const open = section.annotations?.open || 0;
      const done = section.annotations?.resolved || 0;
      frag.append(el('button', {
        class: 'toc-item',
        type: 'button',
        'aria-current': state.section && section.id === state.section.id ? 'true' : 'false',
        onclick: () => {
          closeDrawer();
          loadSection(section.id, { offset: 0 });
        },
      }, [
        `${section.label}　`,
        open ? el('span', { class: 'badge badge--open', text: `指摘 ${open}` }) : null,
        done ? el('span', { class: 'badge badge--done', text: `済 ${done}` }) : null,
        el('small', { text: `${section.viewpoint ? `視点 ${section.viewpoint}／` : ''}${counts(section.chars)} 字　${section.summary || section.opening}`.slice(0, 90) }),
      ]));
    }
  }

  if (state.toc.planned.length) {
    frag.append(el('h3', { class: 'toc-chapter', text: 'これから書かれる節' }));
    for (const p of state.toc.planned) {
      frag.append(el('div', { class: 'toc-item toc-item--planned' }, [
        p.label,
        el('small', { text: (p.summary || '').slice(0, 80) }),
      ]));
    }
  }
  return frag;
}

function renderBookmarks() {
  const frag = document.createDocumentFragment();
  if (!state.bookmarks.length) {
    frag.append(el('p', { class: 'muted', text: 'まだしおりはありません。本文を選んで「しおり」を押すと挟めます。' }));
    return frag;
  }
  for (const b of state.bookmarks) {
    frag.append(el('div', { class: 'note' }, [
      el('div', { class: 'note__meta' }, [
        el('strong', { text: b.sectionId }),
        formatDate(b.createdAt),
      ]),
      b.quote ? el('div', { class: 'note__quote', text: b.quote }) : null,
      el('div', { class: 'note__actions' }, [
        el('button', {
          class: 'btn', type: 'button', text: 'ここへ飛ぶ',
          onclick: async () => {
            closeDrawer();
            if (state.section.id !== b.sectionId) await loadSection(b.sectionId, { offset: b.offset, flash: true });
            else view.scrollToOffset(b.offset, { smooth: true, flash: true });
          },
        }),
        el('button', {
          class: 'btn btn--ghost', type: 'button', text: '外す',
          onclick: async () => {
            await api.removeBookmark(state.novel.id, b.id);
            state.bookmarks = state.bookmarks.filter((x) => x.id !== b.id);
            applyHighlights();
            renderDrawer();
          },
        }),
      ]),
    ]));
  }
  return frag;
}

function renderNotes() {
  const frag = document.createDocumentFragment();
  frag.append(el('div', { class: 'novel__actions' }, [
    el('button', {
      class: 'btn', type: 'button', text: 'この節へ指摘を書く',
      onclick: () => {
        closeDrawer();
        openCompose({ whole: true });
      },
    }),
  ]));
  const filters = el('div', { class: 'novel__actions' }, [
    ['section', 'この節'], ['all', '作品ぜんぶ'], ['mine', '自分の'],
  ].map(([key, label]) => el('button', {
    class: state.noteFilter === key ? 'btn btn--primary' : 'btn',
    type: 'button',
    text: label,
    onclick: async () => {
      state.noteFilter = key;
      await loadNotes();
    },
  })));
  frag.append(filters);
  const list = el('div', { id: 'notes-list' });
  frag.append(list);
  renderNoteList(list);
  return frag;
}

async function loadNotes() {
  const params = {};
  if (state.noteFilter === 'section') params.section = state.section.id;
  if (state.noteFilter === 'mine') params.mine = '1';
  busy(true);
  try {
    const res = await api.annotations(state.novel.id, params);
    state.notes = res.annotations;
    renderDrawer();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    busy(false);
  }
}

function renderNoteList(list) {
  const notes = state.noteFilter === 'section' ? state.annotations : (state.notes || state.annotations);
  if (!notes.length) {
    list.replaceChildren(el('p', { class: 'muted', text: 'まだ指摘はありません。本文を選んで「指摘する」を押してください。' }));
    return;
  }
  list.replaceChildren(...notes.map((a) => el('div', { class: 'note' }, [
    el('div', { class: 'note__meta' }, [
      el('strong', { text: a.sectionLabel || a.sectionId }),
      a.userName,
      formatDate(a.createdAt),
      el('span', {
        class: `badge ${a.status === 'resolved' ? 'badge--done' : 'badge--open'}`,
        text: a.status === 'resolved' ? '対応済み' : '未対応',
      }),
    ]),
    a.quote ? el('div', { class: 'note__quote', text: a.quote }) : null,
    el('div', { class: 'note__body', text: a.body }),
    el('div', { class: 'note__actions' }, [
      el('button', {
        class: 'btn', type: 'button', text: '本文へ',
        onclick: async () => {
          closeDrawer();
          if (state.section.id !== a.sectionId) await loadSection(a.sectionId, { offset: a.start || 0, flash: true });
          else view.scrollToOffset(a.start || 0, { smooth: true, flash: true });
        },
      }),
      el('button', {
        class: 'btn', type: 'button', text: '前後を比べる',
        onclick: () => openCompare(state.novel.id, a.id),
      }),
    ]),
  ])));
}

/* ---------- 出来事の結び付け ---------- */

function bindEvents() {
  $('#form-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    loginError('');
    const form = new FormData(ev.target);
    busy(true);
    try {
      const res = await api.login(form.get('loginId'), form.get('password'));
      state.user = res.user;
      await showLibrary();
    } catch (err) {
      loginError(err.message);
    } finally {
      busy(false);
    }
  });

  $('#form-signup').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    loginError('');
    const form = new FormData(ev.target);
    busy(true);
    try {
      const res = await api.signup(Object.fromEntries(form.entries()));
      state.user = res.user;
      await showLibrary();
    } catch (err) {
      loginError(err.message);
    } finally {
      busy(false);
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await api.logout();
    state.user = null;
    showScreen('login');
  });

  $('#btn-back').addEventListener('click', () => {
    savePosition.flush();
    showLibrary();
  });

  const showPanel = async (kind) => {
    openDrawer(kind);
    if (kind === 'notes' && state.noteFilter !== 'section') loadNotes();
    if (kind === 'toc') {
      // 指摘の数は動くので、開くたびに取り直す
      try {
        const res = await api.toc(state.novel.id);
        state.toc = res.toc;
        if (!$('#drawer').hidden && $('#drawer').dataset.kind === 'toc') renderDrawer();
      } catch { /* 取れなくても、手元の目次で読める */ }
    }
  };
  $('#btn-toc').addEventListener('click', () => showPanel('toc'));
  $('#btn-marks').addEventListener('click', () => showPanel('marks'));
  $('#btn-notes').addEventListener('click', () => showPanel('notes'));
  for (const tab of $$('.drawer__tabs .btn')) {
    tab.addEventListener('click', () => showPanel(tab.dataset.panel));
  }
  $('#btn-settings').addEventListener('click', () => { $('#settings').hidden = false; });

  for (const node of $$('[data-close]')) {
    node.addEventListener('click', () => {
      const target = node.dataset.close;
      if (target === 'compare') closeCompare();
      else $(`#${target}`).hidden = true;
      if (target === 'compose') state.compose = null;
    });
  }

  $('#compose-submit').addEventListener('click', submitAnnotation);

  $('#selection-menu').addEventListener('click', (ev) => {
    const act = ev.target.dataset.act;
    if (act === 'annotate') openCompose();
    else if (act === 'bookmark') addBookmark();
    else if (act === 'copy' && state.selection) {
      navigator.clipboard?.writeText(state.selection.text).then(
        () => toast('写しました'),
        () => toast('写せませんでした', { error: true }),
      );
      hideSelectionMenu();
    }
  });

  for (const [id, key] of [['set-fs', 'fs'], ['set-lh', 'lh']]) {
    $(`#${id}`).addEventListener('input', (ev) => {
      settings[key] = Number(ev.target.value);
      applySettings();
      updateProgress();
    });
  }
  $('#set-theme').addEventListener('change', (ev) => { settings.theme = ev.target.value; applySettings(); });
  $('#set-font').addEventListener('change', (ev) => { settings.font = ev.target.value; applySettings(); });
  $('#set-ruby').addEventListener('change', (ev) => {
    settings.numbers = ev.target.checked;
    applySettings();
    if (state.section) {
      const at = view.position().offset;
      view.render(state.section.text, { showNumbers: settings.numbers });
      applyHighlights();
      view.scrollToOffset(at);
    }
  });

  document.addEventListener('selectionchange', () => {
    if ($('#screen-reader').hidden) return;
    refreshSelection();
  });

  window.addEventListener('pagehide', () => savePosition.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePosition.flush();
  });

  document.addEventListener('keydown', (ev) => {
    if ($('#screen-reader').hidden) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (ev.key === 'Escape') {
      hideSelectionMenu();
      closeDrawer();
      closeCompare();
      $('#compose').hidden = true;
      $('#settings').hidden = true;
      return;
    }
    if (typing) return;
    if (ev.key === 'ArrowLeft' || ev.key === 'PageDown' || ev.key === ' ') {
      ev.preventDefault();
      view.page('next');
    } else if (ev.key === 'ArrowRight' || ev.key === 'PageUp') {
      ev.preventDefault();
      view.page('prev');
    } else if (ev.key === 'n' && state.section?.next) {
      loadSection(state.section.next, { offset: 0 });
    } else if (ev.key === 'p' && state.section?.prev) {
      loadSection(state.section.prev, { offset: 0 });
    } else if (ev.key === 'b') {
      addBookmark();
    } else if (ev.key === 't') {
      openDrawer('toc');
    }
  });
}

function bindReader() {
  view.el.addEventListener('scroll', () => {
    updateProgress();
    savePosition();
  }, { passive: true });

  view.el.addEventListener('click', (ev) => {
    const mark = ev.target.closest?.('mark[data-mark-id]');
    if (!mark) return;
    const id = mark.dataset.markId;
    const note = state.annotations.find((a) => a.id === id);
    if (note) {
      state.noteFilter = 'section';
      openDrawer('notes');
    }
  });

  $('#btn-page-next').addEventListener('click', () => view.page('next'));
  $('#btn-page-prev').addEventListener('click', () => view.page('prev'));
  $('#btn-next-section').addEventListener('click', () => {
    if (state.section?.next) loadSection(state.section.next, { offset: 0 });
  });
  $('#btn-prev-section').addEventListener('click', () => {
    if (state.section?.prev) loadSection(state.section.prev, { offset: 0 });
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* 使えなくても困らない */ });
}

boot();
