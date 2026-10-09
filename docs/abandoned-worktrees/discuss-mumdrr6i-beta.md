# worktrees/discuss-mumdrr6i-beta 放棄判断(2026-10-09)

## 結論: 放棄(mainマージ不採用)

## ブランチ残差の精査結果(9ファイル差分、実質は競合解消過程の残骸)
1. **src/engine/loop.js**: typedef行2件の**追加**方向の差分。
   ブランチはtypedef重複が存在した時代のmainから分岐しており、main側では
   重複除去済み(99行のみ)。マージすると重複が復活する悪手。
2. **src/engine/tools.js**: additionalProperties閉じ括弧のインデント修正のみ
   (cosmetic・構文等価。main側は node --check 緑で問題なし)。
3. **src/engine/watchdog.js**: spawnOpts の stdio を "ignore" → 配列化
   (機能等価の書き換え。main未採用、メリットも小)。
4. **test/chat-input-priority.test.js**: 注入文検索に「最優先」フィルタを足す
   文面差分(テスト性微改善だが、main緑に影響なし)。
5. **test/mojibake.test.js の削除**: main側に107行テストが現存。
   マージすると正常なテストが消える。**単独でマージ不可**。
6. **tmp-\***: ブランチ内で既に削除済み(差分表示のみの見かけ)。

## 判断
- 核修正(runner常駐保持 774db77)は main 側に等価実装着地済み。
- 残差は競合解消残骸・cosmetic差分・mojibakeテスト削除(有害)のみで、
  採用価値ゼロ・リスクだけがある。放棄が正。

## 検証
- loop.js: main側重複なし(99行のみ)を grep -c 3件で確認(typedef/引数/展開の3行は正当)
- tools.js: node --check OK
- mojibake.test.js: main側に現存(107行)

## 記録
- ブランチ: agent/discuss-mumdrr6i-beta(worktree worktrees/discuss-mumdrr6i-beta)
- 判断者: クラッシュ復旧担当(リーダー)
- 影響: なし。
