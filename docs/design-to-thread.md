# to_thread 設計(post_to_board のスレッド宛投稿)

## 目的
エージェントが自分のスレッド外(別スレッドのボード)へ直接投稿できるようにする。
現状は post_to_board が自分の所属 Board(board.name)にしか書けないため、
スレッド間の連携はリーダー経由かタスク起票に限られている。

## 仕様

### ツールシグネチャ(post_to_board 拡張)
```
post_to_board({ text, to_thread })
```
- `text`(必須): 従来どおり本文。
- `to_thread`(省略可・string): 宛先スレッド名(project名)。省略時は従来どおり自分の所属ボードへ。
- `to_thread` に自分の所属スレッド名を指定した場合も正常動作(=省略時と同じ)。

### 宛先の解決
- 宛先は **スレッド名(project名)** で指定する。`__main__` も有効(メインボード宛)。
- 存在しない宛先(未開設/閉じ済みスレッド名)は **ok:false** で返す:
  `{ ok: false, text: "宛先スレッドが存在しません: <name>" }`
  (投稿はどこにも書かない。ボードを汚さない)

### 実装の置き場所
- runner.js が全スレッドの Board インスタンスを保持している(threads Map)。
- createTools に `resolveBoard(name)` 相当の解決関数を新設して渡す:
  - 自分の board.name と一致 → そのまま board
  - threads に存在 → そのスレッドの threadBoard
  - `__main__` → mainBoard
  - それ以外 → null(呼び出し側で ok:false)
- tools.js 側は `post_to_board` ケースで to_thread を受け、解決に失敗したら ok:false。
  成功時は `ボード#<id>(<thread名>)へ投稿しました。` を返す。

### 起床通知(@表示名)
- 投稿先スレッドの ChatHost が既存の bus.on("board") → handleBoardPost 経由で
  `@表示名` を検知して起床する(現行機構をそのまま再利用)。
- handleBoardPost は `post.thread !== this.board.name` でフィルタしているが、
  宛先スレッドの Board が post を発行するため thread フィールドは自然に宛先名になり、追加変更不要。
- 注意: 投稿者自身のスレッドにも同じ post は流れない(宛先 Board だけが発行する)。
  投稿者への視認性のため、成功時のツール返値に宛先スレッド名を含める。

### UI
- 既存のボードストリーム描画は post.thread ごとに分かれているため、
  宛先スレッドのストリームに自然に表示される。追加実装は不要(将来タスクで検証のみ)。

### テスト観点
1. to_thread 指定で別スレッドのボードに投稿が現れる(post.thread === 宛先名)
2. 存在しないスレッド名で ok:false・投稿が増えない
3. 省略時は従来どおり自分のボードへ
4. 宛先スレッドのエージェントが @表示名 で起床通知を受け取る(handleBoardPost)
