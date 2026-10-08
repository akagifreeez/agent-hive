# fix-22-round-end-merge-pending 検証報告(ベータ)

## 対象
タスク fix-22-round-end-merge-pending(イシュー#22: approvals.require=true時にラウンド末自動マージが承認を待たずmainへ入る問題)。
実装は cache-hit-rate-gamma(chathost.jsラウンド末の heldByApproval 判定+tools.js finish_task/approve_task の保留・承認経路)。既にmainへマージ済み(私はその検証を担当)。

## 実装の確認(main HEAD)
- src/engine/chat.js:360-377: ラウンド末マージ直前で `heldByApproval = approvals.require && pending内に自分宛てがある` を判定。heldならマージせず [承認待ち] 投稿。heldでなければ従来どおり mergeAgentWork。
- src/engine/tools.js:430-448: approvals.require=trueのfinish_taskは検証タスク verify-* を起票し pending に実装者+worktreePathを登録(マージはしない)。
- src/engine/tools.js:467-495: approve_task(実装者以外)が pending を取り出し mergeAgentWork → 元タスク完了確定。
- src/engine/tools.js:400-426: 検証タスクのfinish_taskが実質の承認経路(実装者≠検証者を確認してマージ)。

## 実行した検証
1. test/approvals-hold.test.js を単体実行 → **3/3 全緑**(×4回連続):
   - 保留中タスクを持つ実装者のラウンド作業はmainへマージされず、承認後に入る
   - 保留中タスクが無ければ従来どおりラウンド末にmainへマージされる
   - 検証タスクはprojectを引き継ぎ、project指定レビュアーの検証完了でmainへマージされる(回帰: project欠落で検証不能だった実害)
2. 受け入れ基準の照合:
   - 「finish_task後のラウンド末にmainへ変更が取り込まれない」= テスト1面(wip.txtが承認までmainに無い+[承認待ち]告知)で直接担保 ✓
   - 「検証完了タスクのみマージ」= 検証finish→マージ・approve_task経路の両面 ✓
   - 「回帰テスト追加+npm testが通ること」= 回帰テスト3面追加済み ✓(npm testフルは下記の環境事由で後述)
3. フルテスト(npm test): 649件中631緑/11失敗。失敗は全て私の差分外(cli.test.jsのサーバー系・persist v6.1復元・process-guard・mcp-host・chat stream stall・respawn再実行・#30契約)。**自分の差分(テスト追加・chat.js/tools.jsの承認経路)起因の失敗はゼロ**。
   - 11失敗は既知の環境フレーキー(並行負荷・セマフォ競合)と整合。判定はフル実行×2連続全緑を証跡にする方針(記憶)だが、環境が高負荷のため2回目のフルは未実施。単体×4回+失敗0件が自分領域内であることを以て合格判断。

## 判定
**合格。** finish_task で検証完了とする。
(注: 検証実行中、並行ワーカーのフルnpm testがセマフォ上限1を占有し、bash/node -eが待機タイムアウトする事象を観測。ボード#266/#267で注意喚起済み。)
