# 作品の登録

`novels.default.json` がリポジトリに入っている既定の設定。
運用側で変える場合は同じ形式の `novels.json` を置く（gitignore 済み）。
`PROOFREADING_NOVELS=/path/to/novels.json` でも指定できる。

| キー | 必須 | 内容 |
|---|---|---|
| `id` | ○ | URL とデータ保存に使う識別子。英数字・ハイフン |
| `title` | ○ | 一覧に出る作品名 |
| `repo` | ○ | クローン元。`localPath` を使う場合は省略可 |
| `branch` | | 読み書きするブランチ。既定 `main` |
| `workDir` | | リポジトリの中の作品の根（例 `works/tozan`）。下の置き場はどれもここからの相対になる |
| `localPath` | | クローンせず既存の作業コピーを使う（開発・試験用） |
| `manuscriptDir` | | 本文の置き場。既定 `manuscript` |
| `inboxPath` | | 指摘の書き込み先。既定 `review/inbox.md` |
| `structurePath` | | 章題の取得元。既定 `outline/structure.md` |
| `sectionsPath` | | 節の設計（視点・時・場所）の取得元。既定 `outline/sections.md` |
| `push` | | `false` にすると commit まででリモートへ送らない。既定 `true` |

作品を足すときは配列に 1 つ足すだけでよい。再起動すれば一覧に出る。
一つのリポジトリに作品が複数ある（`works/<作品>/`）なら、作品ごとに `workDir` を変えて一件ずつ足す。
**id も作品ごとに変える。**同じ id だと、別の作品の指摘やしおりが同じ節番号に付いてしまう。
