#!/usr/bin/env node
/**
 * 校正者を作る／一覧する／パスワードを変える。
 *
 *   npm run user:add -- --id kato --name 加藤 --password 'ひみつ'
 *   npm run user:add -- --list
 *   npm run user:add -- --id kato --password '新しいひみつ' --reset
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as auth from '../server/auth.js';
import { users } from '../server/store.js';

const CLEAR_LINE = '\u001b[2K\u001b[200D';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function ask(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  let onData = null;
  if (silent) {
    onData = () => {
      stdout.write(`${CLEAR_LINE}${question}${'*'.repeat(rl.line.length)}`);
    };
    stdin.on('data', onData);
  }
  const answer = await rl.question(question);
  if (onData) {
    stdin.off('data', onData);
    stdout.write('\n');
  }
  rl.close();
  return answer;
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  const data = await users.read();
  if (!data.users.length) {
    console.log('まだ誰も登録されていません');
  } else {
    for (const u of data.users) {
      console.log(`${u.loginId}\t${u.name}\t${u.role}\t${u.createdAt.slice(0, 10)}`);
    }
  }
  process.exit(0);
}

const loginId = args.id || (await ask('ログイン ID: '));
const password = args.password || (await ask('パスワード: ', { silent: true }));

if (args.reset) {
  const hash = await auth.hashPassword(password);
  const changed = await users.update((data) => {
    const user = data.users.find((u) => u.loginId === String(loginId).toLowerCase());
    if (!user) return false;
    user.passwordHash = hash;
    return true;
  });
  console.log(changed ? `${loginId} のパスワードを変えました` : `${loginId} が見つかりません`);
  process.exit(changed ? 0 : 1);
}

const name = args.name || (await ask('表示名（指摘に載ります）: '));
try {
  const user = await auth.createUser({
    loginId,
    name,
    password,
    email: args.email || '',
    role: args.admin ? 'admin' : 'proofreader',
  });
  console.log(`作成しました: ${user.loginId}（${user.name}／${user.role}）`);
} catch (err) {
  console.error(`作れませんでした: ${err.message}`);
  process.exit(1);
}
