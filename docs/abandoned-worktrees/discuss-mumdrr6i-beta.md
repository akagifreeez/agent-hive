# worktrees/discuss-mumdrr6i-beta 放棄判断(2026-10-09)

## 結論: 放棄(mainマージ不採用)

## ブランチ残差の精査結果(9ファイル差分)
1. **src/engine/loop.js**: sessionLogKeep/sessionLogMaxBytes の typedef @property が重複挿入された
   もの(main側には既に存在・重複は型検査ノイズ)。採用価値なし。
2. **src/engine/tools.js**: インデントのみの差分(閉じカッコの字下げ)。構文・挙動に影響なし。
3. **src/engine/watchdog.js**: stdio: "ignore" → stdio: [3x "ignore"] の等価書き換え。
   挙動同一(node仕様上どちらも全ストリーム無視)。watchdogテスト5/5緑のまま。採用価値なし。
4. **test/chat-input-priority.test.js**: split("\n")検索へ "最優先" 条件追加。これは破損修復時の
   補強ではあるが、main現行でも find は最初の "[チャット]" 行=通常文(警告文は変数brokenとして
   後置のため同一行に載らない)を正しく拾い、テスト2/2緑。mainの脆は現時点で脆弱性なし。
5. **test/mojibake.test.js 削除**: 旧テストの削除だが、mainでは mojibake-detection.test.js が
   後継として存在し5/5緑。旧テスト削除は不要(共存で問題なし)。
6. **tmp-*.mjs / tmp-notes の削除**: 用後cleanup。mainでは既に無い(クリーンアップ済み)。

## 判断
- 残差は「typedef重複・インデント・等価書き換え・cleanup」のみで、mainへ入れる価値がゼロ。
- 逆にマージすると mojibake.test.js 削除とloop.js重複typedefが持ち込まれる(デメリットのみ)。
- コミット履歴に含まれる構文破損修復(9fdd20e)・merge採用判断(8239203)はmain側で別経路解決済み。

## 記録
- ブランチ: agent/discuss-mumdrr6i-beta(12コミット、main起点で分岐)
- 判断者: クラッシュ復旧担当(このセッション)
- 影響: なし。全関連テスト(mojibake-detection 5/5・chat-input-priority 2/2・watchdog 5/5)はmain HEADで緑。
