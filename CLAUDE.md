# このリポジトリで作業するときの前提

執筆中の小説を**縦書きで読み**、選んだ箇所への**指摘を原稿リポジトリの `review/inbox.md` へ
書き込んでコミットする**、校正者向けのウェブアプリ。作者は inbox を見て直し、
校正者は「指摘した時点の本文」と「いまの本文」を並べて確かめる。

## 置き方が二つある

同じ画面・同じ API を、二つの土台に載せてある。**片方を直したら、もう片方も直す。**

| 置き場 | 役目 |
|---|---|
| `shared/` | 原稿の解析・目次組み・差分・パスワード。両方から使う。fs も git も触らない |
| `server/` | 自前サーバ版。`git` コマンドと `data/*.json` |
| `worker/` | Cloudflare Workers 版。GitHub API と D1 |
| `public/` | 画面。両方で同じものを配る。素の JS・素の CSS、外部依存なし |
| `test/` | `*.test.js` を `node --test` で。偽 GitHub と D1 の代役は `test/helpers/` |

## 動かす

**Node 22 以上が要る**（`wrangler` が要求する。`node:sqlite` を使う試験も同じ）。

```bash
npm test            # 52 件。git が要る。本物の原稿には触らない
npm start           # 自前サーバ版 http://localhost:8787
npm run cf:dev      # Workers 版を手元の workerd で http://localhost:8788
```

## いまの配備（2026-09-12 時点）

- **https://proofreading.ts-co23.workers.dev** — Cloudflare Workers（**無料枠**）
- D1 `proofreading`（APAC）。`database_id` は `wrangler.toml` にある
- Cloudflare 側に登録済みの秘密（**値はリポジトリのどこにも無い**）
  - `GITHUB_TOKEN` … `tsco23/novel1` の Contents: Read and write
  - `INVITE_CODE` … 校正者の自己登録に要る合言葉
- `PBKDF2_ITERATIONS = 10000` … 無料枠は 1 リクエスト CPU 10ms までで、
  既定の 100000 だと**ログインだけが落ちる**。上げるなら Workers Paid にしてから
- 読んでいる原稿は `tsco23/novel1`（private）の `claude/novel-writing-constraints-wuury5`

## クラウドセッションで続きをやるとき

1. `CLOUDFLARE_API_TOKEN` を環境変数で渡す。権限は
   **Workers Scripts: Edit ／ D1: Edit ／ Account Settings: Read**、対象アカウントは一つに絞る
2. `wrangler login` は使えない（資格情報はその PC の `~/.wrangler` にしか残らない）
3. `GITHUB_TOKEN` はセッションに要らない。Cloudflare 側に入っている

```bash
npm install
CLOUDFLARE_API_TOKEN=... npx wrangler deploy          # 出し直す
CLOUDFLARE_API_TOKEN=... npx wrangler tail            # 動きを見る
CLOUDFLARE_API_TOKEN=... npx wrangler d1 execute proofreading --remote \
  --command "SELECT login_id, name, role FROM users"  # 校正者を数える
```

作品を足すときは `wrangler.toml` の `NOVELS` に一つ足して `wrangler deploy`。
手順の全体は [`docs/cloudflare.md`](docs/cloudflare.md)。

## 書くときの作法

- **実行時の npm 依存を増やさない。** Node の標準ライブラリと git だけで動かす
  （`wrangler` はデプロイの道具であって、動作には要らない）
- コメントと画面の文言は日本語。説明は地の文で短く。**何をしたかではなく、なぜそうしたかを書く**
- 指摘の位置は「**本文の何文字目か**」で持つ。段落や行番号ではない
- `review/inbox.md` の `<!-- pr:id=… -->` が指摘の身元。
  **指摘が未対応か済かは inbox.md が正**で、D1／JSON にあるのは控え。
  作者が「## 済」へ動かせば、アプリの表示も変わる
- 機能を足したら、`test/integration.test.js`（自前版）と `test/worker.test.js`（Workers 版）の両方に足す

## つまずきやすいところ

- **Windows の改行**。`core.autocrlf=true` のままだと作業コピーが CRLF になり、
  git の中身（LF）とずれて文字位置が 1 行ごとに狂う。作業コピーは
  `core.autocrlf=false` を焼き付けてクローンしている（`server/git.js`）
- **Workers には `fs` も `child_process` も無い。** `shared/` に fs 依存を持ち込まないこと
- **目次は本文を全部読まないと作れない。** blob の sha を鍵に D1 へ控えてあり、
  変わった節だけ読み直す。無料枠の「1 リクエストあたり外部呼び出し 50 回」に収めるため
- **選択したときの操作メニューは、選択の「横」に出す。** 上や下に出すと、続きを選ぼうと
  する指の行き先を塞ぐ（Chrome が選択のそばに出すネイティブの操作バーも上下に来る）。
  釦を縦に積み、**右を選んだら左、左を選んだら右**へ置く。位置は
  `selectionSidePlacement()`（`public/js/tategaki.js`）。上下の帯の内側にも収める
- **出し直したのに古い画面のまま**、という取り違えが起きやすい。`/api/me` が返す `version`
  （Workers なら版 ID）を画面が見張り、変わっていたら読み込み直しを促す。
  表示設定に出ている「版」を聞けば、相手がどの版を見ているか分かる
- 縦書きの箱は `width: 100%` を明示しないと、行が横に伸びて箱ごと広がる（`public/css/style.css`）
- `[hidden]` は `.modal { display: … }` に負ける。`[hidden] { display: none !important }` で抑えてある

## 出し方

`tsco23/proofreading` の `claude/proofreading-web-app-ax72xf` を Cloudflare の
**Workers Builds** に繋いである。**押せば出る。**手元で `wrangler deploy` する必要も、
セッションに `CLOUDFLARE_API_TOKEN` を渡す必要もない。
`GITHUB_TOKEN` と `INVITE_CODE` は Worker 側に残り続け、Git 経由の deploy では消えない。

押したあとは、配信中のファイルを見れば反映が分かる。

```bash
curl -s https://proofreading.ts-co23.workers.dev/js/app.js | grep -c selectionSidePlacement
```

## まだ確かめていないこと

- **本番で指摘を実際にコミットする経路。** 試すと `tsco23/novel1` に本物のコミットが入るので
  保留にしてある。最初の指摘を送ったときに分かる
- 読み取りのほう（目次・本文・履歴・inbox）は、本物の GitHub API に対して確認済み。
  private リポジトリを読めること、二度目の目次が控えで済むことも見てある
