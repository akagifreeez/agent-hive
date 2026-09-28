# 決定事項とその理由

- finish_taskのマージは withMergeLock(src/engine/worktree.js)で全域直列化。index.lock競合とmain破壊を防ぐ。tools.js(finish_task)とchat.js(ラウンド末自動マージ)の両呼び出し元が同一ロックを共有。
- マージ競合時はワーカーworktree内で `git merge main` を1回だけ自動実行し、クリーンなら再マージ(autoMerged:true)。競合マーカーが残る形ならconflictエラー+「mainは取り込み済み、競合ファイルを解消して再finish」の案内で戻す(worktreeはマージ前状態へabort)。
- devserverは単一プロセス管理(二重起動はalreadyRunning)。close時は子プロセスツリーごとkill。
- ブラウザオープンはopen:true明示時のみ(openInBrowser差し替えでテスト容易)。
- 発見器タスク(fix-/review-/distill-)は先着1名しかclaimできないため全員一斉起床は空転を生む(監査指摘。起床対象の絞り込みが将来課題)。
- claim応答の診断(claim-miss-diagnosis): claim_next_taskが空のとき、project無し指定なら全openの id/role/project 一覧を、project指定なら一致タスクのrole不一致を実文面で返す。role不一致による空待ち退場を防ぐ(2026-09 search-alert-r7の実害=ガンマ(lead)がrole:implタスクを請求できず請求ループ→ミラータスク起票で回避、を根本対応)。
- 競合解消の既定方針: 機能が同一なら main側(先行マージ済み・レビュー済み)を採る。main側を残すのが審査・型契約(JSDoc/typecheck)と整合しやすい。自分の作業が優位な場合はボードで理由を示してから採用する(2026-09 mcp統合競合)。
- タスク解放時の起床(task.released): 解放を新規扱いにせず同スレッドのワーカー(とfix/review/distill系共通仕事)を起こす。解放されたタスクが誰にも起されず凍結する問題の対策。
- idle退場の入力保護: 請求ミス3回でも未応答のsteering入力があれば退場を1回だけ回避して応答を促す(入力1件につき1回。無限ループにはしない)。
- compact要約プロンプトは英語化(要約精度とトークン効率)。出力言語だけ日本語を明示指定(エージェント作業言語が日本語のため挙動維持)。microcompactプレースホルダ・圧縮後注入文も英語に統一(2026-09)。
- usage-budget-alert の告知文としきい値監視はUIサーバー(server.js)側に置く(live.budgetでstate配布。チャットエンジンとUI表示の責務分離)。UI表示は「超過時のみステータスラインへ出す」で常時表示しない(2026-09 search-alert-r7)。
- デスクトップ通知はdesktop/main.jsのnotify()経由で統一。merge.completed(「マージ: <taskId> <要約>」)/thread.opened(「スレッド開始: <名前>」)を追加済み。既存承認要求通知の文面は変更しない(2026-09 search-alert-r7)。
- ワークフロー: 発見器のfix-test-failuresは散発failで空振りが多い。ワーカー側は「再現しなければ修正コミットを作らない」(空コミット回避)で応答し、証跡(連続実行のpass数)を添える。2026-09 search-alert-r7で「全緑なのにタスクだけ残る」状態が繰り返された。
- 散発failの実例: 1件は発見器出力の✖断片だけでは原因不明だったが、別件はワーカーworktreeのmain未追従(マーカー文字列変更へのテスト追従コミット未マージ)による恒常的不整合だった。教訓: テスト失敗の調査はまず git merge main してから(着手前mergeの徹底)。発見器出力には失敗テスト名とassert差分を残すべき(将来改善)。
- マージの競合マーカーガード(main側+ブランチ側の二段階)を導入: main破損の連鎖(r7でmcp.jsにマーカーが入ったまま複数マージが重なり全テスト構文エラー)を受け、マージ直前に両側を検査してmarker:true拒否→作業者へ返送する方式に決定(2026-09 merge-queue-r6)。回避策ではなく仕組みでの解決。
- compact英語化やテスト期待値の日本語文字列に依存するテストは、プロンプト文言変更と同時に直す。マージ直後の「暫定状態」で発見器が失敗を拾うことがあるため、fix着手時はまず現mainでの再現確認(連続2回実行してpass数を揃える)を証跡にする(2026-09 merge-queue-r6)。
- weather-ai改善調査(2026-09)の結論: 改善ルートの推奨順は [1]GSI標高タイル地形特徴量(TPI等・無償・PoC 2〜3日・盆地バイアスに直撃)が最優先、次いで [4]GEFS spread(可・ただしgespread配信なし=メンバー31自前計算・268MB/サイクル)。[3]ECMWF AIFSも実現可(.idx+Range取得を検証済み・遡及2023-01〜)。[2]WIS2はデータ実体なしで不採用推奨。検証はbetaの再現確認(3点完全一致)を経て確定。外部データソースの技術詳細は constraints.md「気象データソース実テスト結果」へ。
