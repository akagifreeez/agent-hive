# 直近マージの敵対コードレビュー(2026-09-27)

対象: boardstore.js / board.js / chat.js(pause) / runner.js(feedback) / tasks.js(meta) / bin/hive.js / ui/server.js(wtdiff) / spawn.js(cleanup)
方法: 各モジュールのコード精読+nodeによる動作再現。再現手順の書けない指摘は載せていない。

## 指摘一覧

### 1.【高】spawn.js: スレッド内スポーンの子ワーカーにスレッドボードの新着が注入されない
- 箇所: `src/engine/spawn.js` runAgent() — `loopOpts.board: this.board`(L124)に対し、toolsには `board: b`(L107、スレッドボード)を渡している
- 原因: SpawnManagerはコンストラクタでmainBoardを保持するため、スレッド内スポーンでもループの新着注入(`loop.js` L126 `board.since(seen)`)がメインボードを見る。子ワーカーのpost_to_boardはスレッドボードへ行くので、自分のスレッドの投稿が一切ループに届かない
- 再現: スレッド内でspawn_agent→子にpost_to_board→子の次ターンに[ボード新着]が付かない(コードパス確認済み。toolsのboardとloopのboardが別インスタンス)
- 最悪影響: 親や同僚の報告を子ワーカーが見落とし、二重作業・陳腐化した前提での作業が起きる
- 修正案: runAgentに渡されたboard引数(b)をloopOpts.boardにも使う(`board: b`)

### 2.【中】chat.js handleTaskCreated: 発見器タスクの全ワーカー一斉起床が空転を生む
- 箇所: `src/engine/chat.js` L58 — `/^(fix-|review-|distill-)/` に一致するタスクで全スレッド全メンバーを起床
- 原因: 発見器タスクは先着1名しかclaimできない。2番手以降は「通知あり→claimなし」を繰り返し、claimMissesLimit到達までトークンを消す(実走で3ワーカー全員が経験)
- 再現: 発見器がreview-changesを起票→複数スレッドのワーカーが起床→1名のみclaim成功、残りはclaim 3連続なしで退場
- 最悪影響: タスク1件あたりワーカー数×数ターンの無駄呼び出し。待機ワーカーの早期退場も誘発する
- 修正案: 起床メッセージに「既に他者が請求済みの可能性」を明記するか、task.created時にrole/project一致者だけに絞る。あるいはclaimMiss後の退場カウントを発見器タスク起床経由では1回目から始めない

### 3.【中】runner.js feedback: マージ記録のスレッドが閉じていると修正依頼がメインに流れる
- 箇所: `src/runner.js` L371-385 — `threads.has(thread)` が偽なら `th=null` でメイン宛てに起票
- 原因: close_thread済みスレッドへの修正依頼は、そのスレッドのprojectタグも付かずメイン起票になる。ワーカー(project絞り)は請求対象にできず、リーダーしか拾わない
- 再現: スレッドをclose→UIのマージ差分から修正依頼を送信→タスクがproject無しで起票される
- 最悪影響: 元スレッドの文脈(タスク履歴・worktree)を持つワーカーに届かず、修正がリーダー経由になり遅延
- 修正案: threadsに無い場合もマージ記録のthread名をprojectタグとして保持して起票し、再open時に拾えるようにする

### 4.【低】boardstore.js pageMixed: スレッド別採番のidを混在カーソルに使うと大きいid側が枯れる
- 箇所: `BoardStore.pageMixed` — beforeIdを全ファイル横断で比較
- 原因: 投稿idはスレッドごとに別採番。返した最古のidが小さいスレッド側だと、次回before=そのidで大きいidのスレッドの残りが取得できない
- 再現: threadA(id 1..10)/threadB(id 1000..1010)で pageMixed(null)→最古がAの1→pageMixed(1)でBの全件が取れない
- 最悪影響: 旧クライアント用APIのみ(UIはthread指定のpageThreadを使用)。影響範囲は限定的
- 修正案: カーソルを「スレッド名+id」の複合にするか、at(時刻)ベースのカーソルに変更

### 5.【低】bin/hive.js: グローバル引数パースが本文中の--port/--threadを誤飲する
- 箇所: `parseGlobalArgs` — 位置によらず全引数を走査
- 原因: `hive say "--port 9999 と表示して"` のような本文がオプションとして消費される
- 再現: 上記コマンドでportが9999に変わる(またはundefinedでNaN)
- 最悪影響: 誤接続先への送信/エラー。CLI利用の利便性のみ
- 修正案: `--` 以降を本文として扱う、または最初の非オプション引数以降は全て位置引数とする

### 確認して問題なかった点
- boardstore: マルチバイト行のバイト走査・部分行(trailing)・切詰め再生成・readRangeの動作を実機再現し正常
- board.js: RAM上限1000のsplice後もseq/lastIdは整合。waiterの自己投稿スキップ正常
- tasks.js metaLines: acceptance/projectの改行潰しによりメタ偽装(project:/role:注入)は不可
- wtdiff: agentIdの正規表現でパストラバーサル不可、worktree存在チェックあり、出力上限あり
- audit: bashコマンドは200字に切られ、append後ローテートで記録欠落なし
- CRLF環境: JSON.parseが\rを許容するためボードJSONLは正常
