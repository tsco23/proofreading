import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_DIR } from './config.js';

const MAX_BUFFER = 32 * 1024 * 1024;

export class GitError extends Error {
  constructor(message, { args, stderr, code }) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.code = code;
  }
}

export function git(args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GitError(`git ${args.join(' ')} が失敗しました: ${stderr || err.message}`, {
            args,
            stderr,
            code: err.code,
          }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (input != null) {
      child.stdin.end(input);
    }
  });
}

/** 作品ごとに git 操作を直列化する。同時に 2 つコミットが走ると壊れるため。 */
const locks = new Map();

export function withRepoLock(novelId, fn) {
  const prev = locks.get(novelId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(novelId, next.then(() => undefined, () => undefined));
  return next;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** クローンが無ければ作る。既にあれば何もしない。 */
export async function ensureClone(novel) {
  if (novel.localPath) {
    if (!(await exists(path.join(novel.localPath, '.git')))) {
      throw new Error(`${novel.id}: localPath が git リポジトリではありません: ${novel.localPath}`);
    }
    return novel.workdir;
  }
  if (await exists(path.join(novel.workdir, '.git'))) return novel.workdir;

  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  // 作業コピーは機械が読むものなので、改行を勝手に変えさせない
  // （Windows の core.autocrlf=true のままだと、git の中身と作業コピーがずれて
  //   指摘の文字位置と前後の比較が壊れる）
  const args = ['clone', '--single-branch', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];
  if (novel.branch) args.push('--branch', novel.branch);
  args.push(novel.repo, novel.workdir);
  await git(args);
  return novel.workdir;
}

/** リモートの先端に追いつく。ローカルに未 push のコミットがあるときは rebase で載せ替える。 */
export async function sync(novel) {
  const cwd = await ensureClone(novel);
  if (novel.localPath) return { skipped: true };
  await git(['fetch', '--quiet', 'origin', novel.branch], { cwd });
  const { stdout: ahead } = await git(
    ['rev-list', '--count', `origin/${novel.branch}..HEAD`],
    { cwd },
  );
  if (Number(ahead.trim()) === 0) {
    await git(['reset', '--hard', `origin/${novel.branch}`], { cwd });
    return { rebased: false };
  }
  await git(['rebase', `origin/${novel.branch}`], { cwd });
  return { rebased: true };
}

export async function headSha(novel) {
  const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: novel.workdir });
  return stdout.trim();
}

/** そのファイルを最後に触ったコミット。無ければ null（未コミットの新規ファイル）。 */
export async function lastCommitOf(novel, relPath) {
  const { stdout } = await git(
    ['log', '-1', '--format=%H%x00%aI%x00%an%x00%s', '--', relPath],
    { cwd: novel.workdir },
  );
  const line = stdout.trim();
  if (!line) return null;
  const [sha, date, author, subject] = line.split('\0');
  return { sha, date, author, subject };
}

/** 指定コミット時点の中身。そのコミットに存在しなければ null。 */
export async function showFileAt(novel, sha, relPath) {
  try {
    const { stdout } = await git(['show', `${sha}:${relPath}`], { cwd: novel.workdir });
    return stdout;
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
}

/** そのファイルの履歴（新しい順）。 */
export async function fileHistory(novel, relPath, limit = 20) {
  const { stdout } = await git(
    ['log', `-${limit}`, '--format=%H%x00%aI%x00%an%x00%s', '--', relPath],
    { cwd: novel.workdir },
  );
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, author, subject] = line.split('\0');
      return { sha, date, author, subject };
    });
}

/**
 * files（相対パス）を stage してコミットし、設定が許せば push する。
 * push がリモートに拒まれたら一度だけ rebase して押し直す。
 */
export async function commitFiles(novel, { files, message, authorName, authorEmail }) {
  const cwd = novel.workdir;
  await git(['add', '--', ...files], { cwd });
  const { stdout: staged } = await git(['diff', '--cached', '--name-only'], { cwd });
  if (!staged.trim()) return { committed: false, pushed: false, sha: await headSha(novel) };

  const name = authorName || '校正者';
  const email = authorEmail || 'proofreader@example.invalid';
  await git(
    [
      '-c', `user.name=${name}`,
      '-c', `user.email=${email}`,
      'commit',
      '--author', `${name} <${email}>`,
      '-m', message,
    ],
    { cwd },
  );
  const sha = await headSha(novel);
  if (!novel.push || novel.localPath) return { committed: true, pushed: false, sha };

  try {
    await git(['push', 'origin', `HEAD:${novel.branch}`], { cwd });
    return { committed: true, pushed: true, sha };
  } catch {
    // 誰かが先に押していたら、載せ替えてもう一度だけ試す
    await git(['fetch', '--quiet', 'origin', novel.branch], { cwd });
    await git(['rebase', `origin/${novel.branch}`], { cwd });
    await git(['push', 'origin', `HEAD:${novel.branch}`], { cwd });
    return { committed: true, pushed: true, sha: await headSha(novel), retried: true };
  }
}
