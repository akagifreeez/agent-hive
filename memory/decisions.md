# 決定事項とその理由

- finish_taskのマージは withMergeLock(src/engine/worktree.js)で全域直列化。index.lock競合とmain破壊を防ぐ。tools.js(finish_task)とchat.js(ラウンド末自動マージ)の両呼び出し元が同一ロックを共有。
- マージ競合時はワーカーworktree内で `git merge main` を1回だけ自動実行し、クリーンなら再マージ(autoMerged:true)。競合マーカーが残る形ならconflictエラー+「mainは取り込み済み、競合ファイルを解消して再finish」の案内で戻す(worktreeはマージ前状態へabort)。
- devserverは単一プロセス管理(二重起動はalreadyRunning)。close時は子プロセスツリーごとkill。
- ブラウザオープンはopen:true明示時のみ(openInBrowser差し替えでテスト容易)。
- 発見器タスク(fix-/review-/distill-)は先着1名しかclaimできないため全員一斉起床は空転を生む(監査指摘。起床対象の絞り込みが将来課題)。
- claim応答の診断(claim-miss-diagnosis): claim_next_taskが空のとき、project無し指定なら全openの id/role/project 一覧を、project指定なら一致タスクのrole不一致を実文面で返す。role不一致による空待ち退場を防ぐ(2026-09 search-alert-r7の実害=ガンマ(lead)がrole:implタスクを請求できず請求ループ→ミラータスク起票で回避、を根本対応)。
- タスク解放時の起床(task.released): 解放を新規扱いにせず同スレッドのワーカー(とfix/review/distill系共通仕事)を起こす。解放されたタスクが誰にも起されず凍結する問題の対策。
- idle退場の入力保護: 請求ミス3回でも未応答のsteering入力があれば退場を1回だけ回避して応答を促す(入力1件につき1回。無限ループにはしない)。
- compact要約プロンプトは英語化(要約精度とトークン効率)。出力言語だけ日本語を明示指定(エージェント作業言語が日本語のため挙動維持)。microcompactプレースホルダ・圧縮後注入文も英語に統一(2026-09)。
