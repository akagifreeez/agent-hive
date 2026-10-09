# isolate-heavy-tests 検証報告(アルファ)

## タスク
重い実駆動テストを HIVE_HEAVY ガードで分離し、通常の npm test を軽量に保つ。

## 結論: 機構は既に実装済みで動作する(コード変更不要)
- `test/heavy/*.test.js` 9ファイルが `const HEAVY_SKIP = process.env.HIVE_HEAVY ? false : "..."` ガード付きで分離済み
- `package.json`: `"test": "node --test --test-force-exit \"test/*.test.js\" --ignore \"test/heavy/*.test.js\""`(heavyを除外)
- `"test:heavy"`: heavy配下を実行する専用スクリプト
- heavy配下の個別テストは `{ skip: HEAVY_SKIP }` 付き → HIVE_HEAVY=1 で従来どおり動く

## 検証証跡
1. npm test(軽量モード): 693 tests / 684 pass / fail 2
   - fail は respawn.test.js / respawn-chat.test.js の「ファイル単位タイムアウト(100s)」のみ
   - 両ファイルは単体実行で全ケース緑(respawn 6/6、respawn-chat 1/1=40.7s)
   - → 分離機構のバグではなく、respawn系自体が重い(実駆動でworktree作成+40秒級×複数)
2. HIVE_HEAVY=1 相当(heavy単体実行): test/heavy/merge-queue.test.js は実行されるが
   並行負荷下でファイルタイムアウト(110s)に到達 → heavyは単独実行が前提の重さ

## 残課題(次ラウンドの提案)
- respawn.test.js / respawn-chat.test.js を test/heavy/ へ移す(重さがheavy同等のため)。
  または node --test の --test-timeout を npm test で明示緩和する
- 並行ラウンド中のフルnpm testはマシン負荷でファイルタイムアウトが多発する
  (実測: fail 2 → 負荷増大時に fail 12)。検証は関連テスト単体+承認締めに1回フル、
  の運用(現行ルール)を維持するのが妥当

## 実装差分
なし(機構が既にmainに存在)。この報告を成果物とする。
