# 校正室

執筆中の小説を**縦書きで読み**、気になった箇所をその場で選んで**指摘**し、
それを**原稿リポジトリの `review/inbox.md` へ書き込んでコミット**するための、校正者向けのウェブアプリ。

作者は `review/inbox.md` を見て直す。校正者はあとから
**「指摘した時点の本文」と「いまの本文」を並べて**、どう直ったかを確かめられる。

- 縦書き（`writing-mode: vertical-rl`）で右から左へ読む。頁送り・ホイール・矢印キー対応
- 本文を選ぶ → 「指摘する」 → `review/inbox.md` の「未対応」に追記してコミット・push
- 章と節を**自動で目次にする**（`manuscript/` の走査と `outline/` の読み取り）
- 校正者は複数人。ログインが要る
- 作品はリポジトリごと。設定に足せば増える
- 閉じても**最後に読んだところから**開く。**しおり**も挟める
- 作者が済へ移した指摘は「対応済み」として色が変わる
- スマホの画面幅に合わせてあり、ホーム画面に入れて使える（PWA）。Android でもそのまま動く

素の Node.js だけで動く。npm の依存は無い。

## 動かす

```bash
npm start                      # 既定では http://localhost:8787
PORT=9000 npm start            # 待ち受けを変える
```

はじめて開くと「最初の校正者を作る」画面が出る。作った人が管理者になる。
二人目からは次のどちらかで足す。

```bash
npm run user:add -- --id chino --name 茅野 --password 'ひみつ'   # 手元で作る
PROOFREADING_INVITE_CODE=yamanoue npm start                      # 招待コードで自己登録させる
npm run user:add -- --list                                       # 一覧
npm run user:add -- --id chino --password '新しいひみつ' --reset  # パスワードを変える
```

### 環境変数

| 変数 | 既定 | 内容 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 待ち受け |
| `PROOFREADING_DATA_DIR` | `./data` | 校正者・しおり・指摘台帳・原稿の作業コピーの置き場 |
| `PROOFREADING_NOVELS` | `config/novels.json`（無ければ `config/novels.default.json`） | 作品の設定 |
| `PROOFREADING_INVITE_CODE` | （空） | 設定すると、この合言葉を知っている人が自分で登録できる |
| `PROOFREADING_SESSION_DAYS` | `30` | ログインの保持日数 |
| `PROOFREADING_SECURE_COOKIE` | （空） | `1` にすると Cookie に `Secure` が付く。https の後ろに置くとき |
| `PROOFREADING_SYNC_SEC` | `120` | 原稿を取り直す間隔（秒） |

## 作品を足す

`config/novels.json`（無ければ `config/novels.default.json` が使われる）に 1 つ足して、再起動するだけ。
書き方は [`config/README.md`](config/README.md)。

```json
{
  "novels": [
    { "id": "novel1", "title": "烏川高校山岳部（仮題）",
      "repo": "https://github.com/tsco23/novel1",
      "branch": "claude/novel-writing-constraints-wuury5" },
    { "id": "novel2", "title": "次の作品",
      "repo": "https://github.com/tsco23/novel2", "branch": "main" }
  ]
}
```

原稿リポジトリに期待する形（いずれも設定で変えられる）。

```
manuscript/chN/chN-MM.md   本文。これを走査して目次を組む
outline/structure.md       章題の表（| 一 | 出遅れ | … |）
outline/sections.md        節ごとの視点・時・場所・あらすじ（## ch1-01 …）
review/inbox.md            指摘の書き込み先（## 未対応 に足す）
```

`outline/` が無くても目次は作れる。その場合は章題と節のあらすじが空欄になるだけ。

### push できるようにする

指摘のコミットは、サーバが動いている環境の git 認証でそのまま push される。
どれか一つを用意する。

- HTTPS + トークン: `"repo": "https://x-access-token:<TOKEN>@github.com/tsco23/novel1"`
- 認証ヘルパー: `git config --global credential.helper store` などを済ませておく
- SSH: `"repo": "git@github.com:tsco23/novel1.git"` と鍵

**コミットの著者は指摘した校正者の名前**（`加藤 <kato@…>`）になる。push する資格だけがサーバのもの。
試すあいだは `"push": false` にしておけば、コミットは作るが送らない。

## 使う

| 操作 | やり方 |
|---|---|
| 頁を送る／戻す | `←` / `→`、画面端の `‹` `›`、ホイール、指で横に払う |
| 節を移る | 下の「前の節」「次の節」、`p` / `n` |
| 目次 | 上の「目次」、`t` |
| 指摘する | 本文を選ぶ → 「指摘する」 → 書いて「inbox.md へ送る」 |
| しおり | 本文を選ぶ → 「しおり」、または `b`（いま読んでいる位置に挟む） |
| 指摘の一覧 | 上の「指摘」。この節／作品ぜんぶ／自分の で絞れる |
| 前後を比べる | 指摘の一覧から「前後を比べる」 |
| 文字の大きさ・紙の色・書体 | 上の `Aa` |
| 閉じる | `Esc` |

読んだ位置は勝手に覚える（サーバに保存されるので、別の端末で開いても続きから読める）。

指摘を送ると、`review/inbox.md` にこう入る。

```markdown
## 未対応

- **ch1-02**（第一章 第二節）／加藤／2026-09-12
  > 扉がまた鳴った。
  同じ「鳴った」が前節の末尾にもある。どちらかを変えたい。
  <!-- pr:id=ann_1f2e… section=ch1-02 range=120-138 base=b9ca22b965 -->
```

最後の行は目印。作者がこの項目を「## 済」へ移すと、アプリ側の表示も「対応済み」に変わる。
**目印さえ残しておけば、本文の書き方は自由に直してよい。**

## 仕組み

```
ブラウザ ── HTTP ── server/  ── git clone / pull / commit / push ── 原稿リポジトリ
                      └ data/  校正者・しおり・読みかけ・指摘の台帳（JSON）
```

| 置き場 | 役目 |
|---|---|
| `server/index.js` | HTTP の入口。静的ファイルと `/api/*` の振り分け |
| `server/api.js` | API の中身 |
| `server/auth.js` | ログイン（scrypt でハッシュ、Cookie でセッション） |
| `server/git.js` | git の呼び出し。作品ごとに直列化して壊さない |
| `server/novel.js` | 原稿の読み取り。目次組み・`inbox.md` への差し込み |
| `server/diff.js` | 前後の比較（行の LCS ＋ 変わった行の文字単位） |
| `server/workspace.js` | 作業コピーの用意と、目次の作り直し |
| `public/js/tategaki.js` | 縦書きの表示。選択位置を本文の文字数で表す |
| `public/js/app.js` | 画面の進行 |
| `public/js/compare.js` | 前後の比較の描画 |

指摘の位置は**本文の何文字目か**で持つ。原稿が書き換わっても、
引用文をいまの本文から探し直すので、直された箇所を見失いにくい。

## 試験

```bash
npm test
```

`test/integration.test.js` は、その場で作った git リポジトリを相手に
**ログイン → 目次 → 本文 → 指摘の書き込みと push → 作者の修正 → 前後の比較 → 対応済みの判定**
までを通す。本物の原稿には触らない。
