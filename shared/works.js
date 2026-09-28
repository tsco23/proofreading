/**
 * 原稿リポジトリの works/ の下から、作品を自動で拾う。
 *
 * 作品を増やすたびにアプリの設定を書き換えなくて済むように、設定には
 * 「どのリポジトリの、どの枝の、どの置き場を見るか」だけを書く（`worksDir`）。
 * その下で原稿（manuscript/）か設計（outline/）を持つ場所を、すべて作品とみなす。
 *
 * fs も git も触らない。ファイルの一覧と中身は呼ぶ側が渡す。
 */

/**
 * 作品の設定に使う、ごく小さな TOML 読み。
 * `"キー" = "文字列"` と `[表]` だけを読む。配列や数は読み飛ばす（使わないので）。
 * 結果は { '': {…直下…}, '表の名前': {…} }。
 */
export function parseSimpleToml(text) {
  const out = { '': {} };
  let table = out[''];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const head = line.match(/^\[\s*"?([^"\]]+)"?\s*\]$/);
    if (head) {
      table = out[head[1]] ||= {};
      continue;
    }
    const pair = line.match(/^(?:"([^"]+)"|([^\s=]+))\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (pair) {
      table[pair[1] ?? pair[2]] = pair[3].replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n');
    }
  }
  return out;
}

const WORK_NAME = /^[\p{L}\p{N}._-]+$/u;

/**
 * リポジトリの中のファイルの一覧（相対パス）から、作品の名前を拾う。
 * 原稿か設計を持たない場所（資料置き場など）は作品とみなさない。
 */
export function discoverWorks(paths, worksDir = 'works') {
  const root = String(worksDir).replace(/^\/+|\/+$/g, '');
  const prefix = `${root}/`;
  const names = new Set();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const [name, second] = p.slice(prefix.length).split('/');
    if (!name || !second || name.startsWith('.') || name.startsWith('_')) continue;
    if (!WORK_NAME.test(name)) continue;
    if (second === 'manuscript' || second === 'outline') names.add(name);
  }
  return [...names];
}

function shorten(text, max = 30) {
  const t = String(text).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 作品の題を決める。原稿側に題の欄は無いので、ある物から順に使う。
 *   1. works/<作品>/input.toml の "題"      … 作者が付けた題。いちばん強い
 *   2. work.toml の題（いま書いている作品のとき）
 *   3. input.toml の "題材" に（未定）を付けたもの
 *   4. フォルダの名前
 */
export function workTitle({ name, workDir, input, current }) {
  const own = input?.['']?.['題'];
  if (own) return own;
  if (current?.path && current.path.replace(/\/+$/, '') === workDir && current.title) return current.title;
  const subject = input?.['']?.['題材'];
  if (subject) return `（未定）${shorten(subject)}`;
  return name;
}

/** work.toml から「いま書いている作品」を読む。 */
export function currentWork(workTomlText) {
  const t = parseSimpleToml(workTomlText);
  const w = t['作品'] || {};
  return w.path ? { path: w.path.replace(/^\/+|\/+$/g, ''), title: w.title || '' } : null;
}

/**
 * 置き場の設定（library）と拾った作品から、作品の設定を並べる。
 * いま書いている作品を先頭に、残りは名前の順。id はフォルダの名前。
 */
export function expandLibrary(library, { names, inputs = {}, current = null }) {
  const root = String(library.worksDir).replace(/^\/+|\/+$/g, '');
  const shared = { ...library };
  delete shared.worksDir; // 拾った作品は一作品ずつの設定になる
  const list = names.map((name) => {
    const workDir = `${root}/${name}`;
    return {
      ...shared,
      id: name,
      workDir,
      title: workTitle({ name, workDir, input: inputs[name], current }),
      discovered: true,
    };
  });
  const isCurrent = (n) => current?.path === n.workDir;
  return list.sort((a, b) => (isCurrent(b) - isCurrent(a)) || a.id.localeCompare(b.id));
}
