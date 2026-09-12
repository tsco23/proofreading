# Cloudflare Workers に載せる

自分でサーバを持たずに動かす手順。Workers が画面と API を出し、
校正者のデータは D1（Cloudflare の SQLite）に入り、原稿は GitHub の API で読み書きする。

```
ブラウザ ──> Workers ──┬── D1        校正者・しおり・読みかけ・指摘の控え
                       └── GitHub API  本文の取得と review/inbox.md へのコミット
```

Node 版（`npm start`）と同じ画面・同じ API のまま、`git` コマンドとディスクへの書き込みを
GitHub API と D1 に置き換えたものが `worker/` にある。原稿の解析と差分は `shared/` を共用している。

**いま実際に出してあるもの**（URL・D1・登録済みの秘密）は [`../CLAUDE.md`](../CLAUDE.md) に書いてある。

## 要るもの

| もの | 用途 | 備考 |
|---|---|---|
| Cloudflare アカウント | Workers と D1 | 無料でも作れる。後述の CPU 制限に注意 |
| GitHub の細かい権限のトークン | 原稿の読み取りと `inbox.md` へのコミット | fine-grained PAT。**Contents: Read and write** のみ |
| Node.js 20 以上 | `wrangler` を動かす手元の道具 | デプロイのときだけ |

**トークンは誰にも見せない。**リポジトリにも、チャットにも貼らない。
下の `wrangler secret put` で登録すれば、Cloudflare の中だけに入る。

## 手順

```bash
npm install                 # wrangler を入れる（本番の動作に npm 依存は無い）
npx wrangler login          # ブラウザが開く
```

### 1. D1 を作る

```bash
npx wrangler d1 create proofreading
```

出てきた `database_id` を `wrangler.toml` の `[[d1_databases]]` に貼る。続けて表を作る。

```bash
npm run cf:db:init          # wrangler d1 execute proofreading --remote --file=worker/schema.sql
```

### 2. GitHub のトークンを登録する

GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token

- Repository access … `tsco23/novel1`（今後増える作品も足す）
- Permissions → Repository permissions → **Contents: Read and write**（これだけでよい）
- Expiration … 期限を切ったら、切れる前に入れ直す

```bash
npm run cf:secret           # wrangler secret put GITHUB_TOKEN
```

### 3. 作品を登録する

`wrangler.toml` の `vars.NOVELS` に JSON で書く。増やすときはここに足して deploy し直す。

```toml
NOVELS = '{"novels":[{"id":"novel1","title":"烏川高校山岳部（仮題）","repo":"https://github.com/tsco23/novel1","branch":"claude/novel-writing-constraints-wuury5"}]}'
```

`manuscriptDir` `inboxPath` `structurePath` `sectionsPath` も作品ごとに変えられる（既定は
`manuscript` / `review/inbox.md` / `outline/structure.md` / `outline/sections.md`）。

### 4. 出す

```bash
npm run cf:deploy           # wrangler deploy
```

`https://proofreading.<あなた>.workers.dev` が出てくる。開くと「最初の校正者を作る」画面になり、
そこで作った人が管理者になる。二人目からは招待コードを入れておく。

```bash
npx wrangler secret put INVITE_CODE     # 合言葉を知っている人が自分で登録できるようになる
```

独自ドメインを使うなら、Cloudflare のダッシュボードで Workers Routes か Custom Domain を当てる。

## 無料枠で使うときの注意

Workers の無料枠は **1 リクエストあたり CPU 10ms** まで。
パスワードの鍛え直し（PBKDF2）は既定の 10 万回で 40〜50ms 使うので、**ログインだけが失敗する**。
どちらかを選ぶ。

- `wrangler.toml` の `PBKDF2_ITERATIONS` を `10000` 前後まで下げる（守りは弱くなる）
- Workers Paid（月 5 ドル）にして既定のまま使う ← おすすめ

読み書きそのものは無料枠で足りる。もう一つの制限「1 リクエストあたりの外部呼び出し 50 回」は、
目次を組み直すときだけ効く。節ごとの字数は blob の sha を鍵に D1 へ控えてあるので、
**読み直すのは増えた節・直された節だけ**で済む（全 28 節でも、普段は 2〜3 回）。

## 手元で試す

本物の Cloudflare に出す前に、workerd（本番と同じ実行環境）で動かせる。

```bash
npm run cf:db:init:local
npm run cf:dev              # http://localhost:8788
```

`GITHUB_TOKEN` は `.dev.vars`（gitignore 済み）に置くか、`--var GITHUB_TOKEN:...` で渡す。
http で試すときは `--var SECURE_COOKIE:0` を足す（Cookie の Secure が外れる）。

## 運用

| したいこと | やり方 |
|---|---|
| 作品を足す | `wrangler.toml` の `NOVELS` に足して `npm run cf:deploy` |
| 校正者を数える | `npx wrangler d1 execute proofreading --remote --command "SELECT login_id, name, role FROM users"` |
| 校正者を消す | 同上で `DELETE FROM users WHERE login_id='…'`（`sessions` の行も消す） |
| 動きを見る | `npx wrangler tail` |
| トークンを入れ替える | `npm run cf:secret` で上書き |
| 指摘の控えを見る | `… --command "SELECT section_id, user_name, body FROM annotations ORDER BY created_at DESC LIMIT 20"` |

指摘そのものは原稿リポジトリの `review/inbox.md` が正本で、D1 にあるのは控え。
D1 が消えても、作者の手元の指摘は失われない（失うのは、しおりと読みかけの位置）。

## GitHub の API をどれくらい叩くか

トークン 1 本あたり毎時 5,000 回まで。実際の使われ方はこのくらい。

| 操作 | 呼び出し |
|---|---|
| 節を 1 つ開く | 3〜4 回（先端の取得・木・本文・その節の履歴） |
| 目次を開く | 2 回（控えが効いているとき） |
| 指摘を 1 件送る | 4〜5 回（本文・履歴・inbox の読み・書き） |
| 前後を比べる | 3 回 |

校正者が数人で一日中読んでも、上限には遠い。

## Node 版との違い

| | Node 版（`npm start`） | Workers 版 |
|---|---|---|
| 置き場 | 常時動く機械が要る | Cloudflare に出すだけ |
| 原稿 | `git clone` した作業コピー | GitHub API |
| 校正者・しおり | `data/*.json` | D1 |
| 指摘のコミット | `git commit && git push` | Contents API（1 コミットになる） |
| コミットの著者 | 校正者本人 | 校正者本人（`committer` はトークンの持ち主） |
| 画面 | 同じ `public/` | 同じ `public/` |

**データは行き来しない。**両方を同時に動かすと、校正者の登録もしおりも別々になる。
パスワードの形式（PBKDF2）は揃えてあるので、移すときは `users` の行を写せばそのまま使える。
