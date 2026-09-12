/**
 * 同じ隔離環境が生きているあいだだけの覚え書き。
 * GitHub への問い合わせを減らすためのもので、無くても動く。
 */
const store = new Map();
const MAX = 200;

export function remember(key, ttlMs, produce) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = Promise.resolve(produce()).catch((err) => {
    store.delete(key);
    throw err;
  });
  if (store.size >= MAX) store.delete(store.keys().next().value);
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

export function forget(prefix) {
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
