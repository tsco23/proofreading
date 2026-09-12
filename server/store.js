import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';

/**
 * 小さな JSON ファイル置き場。
 * 校正者・付箋・指摘の索引くらいの量しか入らないので、これで足りる。
 * 書き込みは一時ファイル + rename で原子的に行い、同じファイルへの更新は直列化する。
 */
class JsonFile {
  constructor(name, initial) {
    this.file = path.join(DATA_DIR, name);
    this.initial = initial;
    this.cache = null;
    this.queue = Promise.resolve();
  }

  async read() {
    if (this.cache) return this.cache;
    try {
      const text = await fs.readFile(this.file, 'utf8');
      this.cache = JSON.parse(text);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.cache = structuredClone(this.initial);
    }
    return this.cache;
  }

  /** fn(data) を直列に呼び、戻り値をそのまま返す。data を書き換えれば保存される。 */
  update(fn) {
    const run = async () => {
      const data = await this.read();
      const result = await fn(data);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, this.file);
      this.cache = data;
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

export const users = new JsonFile('users.json', { users: [] });
export const sessions = new JsonFile('sessions.json', { sessions: {} });
export const readerState = new JsonFile('reader-state.json', { byUser: {} });
export const annotations = new JsonFile('annotations.json', { annotations: [] });

export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** 校正者ごと・作品ごとの読書状態。無ければ作って返す。 */
export function userSlot(data, userId, novelId) {
  const byUser = (data.byUser ||= {});
  const forUser = (byUser[userId] ||= {});
  return (forUser[novelId] ||= { position: null, bookmarks: [] });
}
