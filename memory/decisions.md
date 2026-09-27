# 決定事項とその理由

- finish_taskのマージは withMergeLock(src/engine/worktree.js)で全域直列化。index.lock競合とmain破壊を防ぐ。tools.js(finish_task)とchat.js(ラウンド末自動マージ)の両呼び出し元が同一ロックを共有。
- マージ競合時はワーカーworktree内で `git merge main` を1回だけ自動実行し、クリーンなら再マージ(autoMerged:true)。競合マーカーが残る形ならconflictエラー+「mainは取り込み済み、競合ファイルを解消して再finish」の案内で戻す(worktreeはマージ前状態へabort)。
- devserverは単一プロセス管理(二重起動はalreadyRunning)。close時は子プロセスツリーごとkill。
- ブラウザオープンはopen:true明示時のみ(openInBrowser差し替えでテスト容易)。
- 発見器タスク(fix-/review-/distill-)は先着1名しかclaimできないため全員一斉起床は空転を生む(監査指摘。起床対象の絞り込みが将来課題)。