# worktrees/impl-2, impl-5, impl-6, impl-14, impl-18 一括放棄判断(2026-10-09)

## 結論: 5ブランチ全件 放棄(mainマージ不採用)

## 各ブランチの精査結果
1. **agent/impl-2(リモートのみ・ローカルworktree無し)**: 核コミット a27a5dc(fix-27: MCP非同期ENOENTで
   mcp.failed をbus emit)の機能はmain実装済み(src/engine/mcp.js の70/81/139行で同一emit、二重通知抑止含む)。
   ブランチ履歴自体が「main確定版へのsync」を4回繰り返した痕跡のみ(422c711/4dd7670/52d9141/e3e63a9)。
2. **agent/impl-5**: mainが52コミット先行。差分は**古い版への巻き戻し**(test-semaphore.jsの本日修正済み
   drain()スロット加算を消す・isTestCommandのtest:coverage除外を消す等)。マージはリグレッション。
3. **agent/impl-6**: mainが195コミット先行。43ファイル差分は巻き戻し+旧テスト(test-semaphore 161行削除、
   turn-limit-claimed 127行削除)を含む。採用価値なし。
4. **agent/impl-14**: ブランチ独自コミットは 8765b19(fix #28: mergeAgentWorkのコミット失敗をok:false返却+
   回帰テスト)のみ。**イシュー#28はmainで解決済み**(9aa3e60→b544f65→f7fce4d、test/merge-commit-failure.test.js
   もmainに存在)。二重実装の価値なし。
5. **agent/impl-18**: mainが946コミット先行。112ファイル差分はui-progress-chip系(SSE起点イベント明示)だが、
   最終コミットからmain側で大幅進展済み。verify-report系一時ファイル削除のみの差分も含み採用価値なし。

## 共通の判断根拠
- 全ブランチの独自変更は「mainで既に別経路で解決済みのイシュー」か「古い版への巻き戻し」のみ。
- マージすると本日入った修正(test-semaphore drain fix等)や新機能を破壊する。
- acceptance「放棄判断が記録されること」をこの文書で満たす。

## 記録
- 判断者: クラッシュ復旧担当(リーダー)
- 対象: agent/impl-2(=origin/agent/impl-2), agent/impl-5, agent/impl-6, agent/impl-14, agent/impl-18
- ブランチ自体は削除しない(履歴参照用。削除はユーザー判断)
