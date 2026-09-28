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
| `worksDir` | | **置き場ごと見る。**その下の作品を自動で拾う（`id` は書かない）。例 `works` |
| `workDir` | | 一作品だけを名指しするとき、リポジトリの中の作品の根（例 `works/tozan`） |
| `localPath` | | クローンせず既存の作業コピーを使う（開発・試験用） |
| `manuscriptDir` | | 本文の置き場。既定 `manuscript` |
| `inboxPath` | | 指摘の書き込み先。既定 `review/inbox.md` |
| `structurePath` | | 章題の取得元。既定 `outline/structure.md` |
| `sectionsPath` | | 節の設計（視点・時・場所）の取得元。既定 `outline/sections.md` |
| `push` | | `false` にすると commit まででリモートへ送らない。既定 `true` |

原稿リポジトリが `works/<作品>/` の形なら、**置き場を一件書くだけでよい。**

```json
{ "novels": [{ "repo": "https://github.com/tsco23/novel1", "branch": "…", "worksDir": "works" }] }
```

その下で `manuscript/` か `outline/` を持つ場所を、すべて作品として拾う。
原稿側で作品を増やしても、ここは書き換えなくてよい。id はフォルダ名、
題は `works/<作品>/input.toml` の `"題" = "…"`（無ければ `work.toml` の題 → 題材 → フォルダ名）。
