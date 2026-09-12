import { DatabaseSync } from 'node:sqlite';

/**
 * D1 の代役。node:sqlite の上に prepare/bind/first/all/run だけ被せたもの。
 * Workers 本番では Cloudflare の D1 が同じ形で応える。
 */
export function createD1(schemaSql) {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);

  const normalize = (args) => args.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });

  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) {
          params = args;
          return stmt;
        },
        async first() {
          return db.prepare(sql).get(...normalize(params)) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...normalize(params)), success: true };
        },
        async run() {
          db.prepare(sql).run(...normalize(params));
          return { success: true };
        },
      };
      return stmt;
    },
    close() {
      db.close();
    },
  };
}
