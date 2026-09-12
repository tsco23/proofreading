import { loadNovels } from './config.js';
import * as git from './git.js';
import * as novelLib from './novel.js';

const SYNC_INTERVAL_MS = Number(process.env.PROOFREADING_SYNC_SEC || 120) * 1000;

const state = new Map(); // novelId -> { ready, lastSync, head, toc, error }

function slot(novel) {
  if (!state.has(novel.id)) {
    state.set(novel.id, { ready: false, lastSync: 0, head: null, toc: null, error: null });
  }
  return state.get(novel.id);
}

/**
 * クローンを用意し、必要なら origin に追いつき、目次を作り直す。
 * 既に git ロックを取っている中から呼ぶ用（ロックは取らない）。
 */
export async function prepare(novel, { force = false } = {}) {
  const s = slot(novel);
  try {
    await git.ensureClone(novel);
    const stale = Date.now() - s.lastSync > SYNC_INTERVAL_MS;
    if (force || stale || !s.ready) {
      await git.sync(novel);
      s.lastSync = Date.now();
    }
    const head = await git.headSha(novel);
    if (!s.toc || head !== s.head) {
      s.toc = await novelLib.buildToc(novel);
      s.head = head;
    }
    s.ready = true;
    s.error = null;
  } catch (err) {
    s.error = err.message;
    if (!s.ready) throw err;
  }
  return s;
}

/** ロックを取ってから prepare する。外から呼ぶのはこちら。 */
export function ensureReady(novel, opts) {
  return git.withRepoLock(novel.id, () => prepare(novel, opts));
}

/** 書き込んだ直後に目次と HEAD を取り直す（ロックの中から呼ぶ）。 */
export async function refresh(novel) {
  const s = slot(novel);
  s.head = await git.headSha(novel);
  s.toc = await novelLib.buildToc(novel);
  s.lastSync = Date.now();
  s.ready = true;
  return s;
}

export function status(novel) {
  return slot(novel);
}

export function novels() {
  return loadNovels();
}
