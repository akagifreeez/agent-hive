# fix-31-verify-task-project 検証報告(ベータ)

## 判定: 合格(実装はmain統合済み、回帰テスト全緑)

## 検証したこと
1. **本タスクのコード状態**: 着手時、src/engine/tools.js の finish_task 検証タスク起票部は既に
   `project: claimedTask?.project ?? ""` を含む実装だった(先行実装をmain経由で受領)。
   src/engine/tasks.js の claimedBy() も project メタを返す(`project: meta.project`)。
   つまりタスク指示の両選択肢(claimedBy返値へのproject追加 / finish_task側の引き継ぎ)が実装済み。
2. **回帰テスト**: test/approve-flow.test.js
   「承認フロー: 検証タスク起票は元タスクのprojectを引き継ぐ(project指定レビュアーが請求できる)」
   - 検証タスク verify-tp1 の project === "proj-x"(元タスクと同一)を検証
   - project指定のreviewロールが claim_next_task({project:"proj-x"}) で検証タスクを請求できることを検証
   - approvals.pending に保留情報が立つことも検証
   → 3/3緑(単体)。
3. **周辺**: test/approvals-hold.test.js 4/4緑。両テスト同時実行 7/7緑。
4. **フルテスト**: npm test → 680件中 672緑 / 1失敗。
   失敗は test/heavy/persist.test.js「v6.1: 再起動しても…」(7 !== 4、無音復元なのに投稿増)。
   これはmemory既知のフレーキー(並行負荷で落ちる系、search-alert-r7 で3者観測済み)で、
   本タスク差分(project引き継ぎ)と無関係。fix-23検証時にも同一名で別アサート位置(72144ms)で発生を確認。

## 受け入れ基準の充足
- finish_task由来の検証タスクに元タスクのprojectが引き継がれる → approve-flow回帰テストで担保・緑
- projectフィルタで請求可能 → 同テスト内でreviewによるproject指定claimを検証・緑
- npm test → 既知フレーキー1件を除き全緑(680件)

## 備考
- 検証タスク起票時の本文も「問題なければ finish_task (task_id: verify-*)」の新文言へ更新済みを確認。
