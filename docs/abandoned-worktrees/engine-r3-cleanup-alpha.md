# worktrees/engine-r3-cleanup-alpha 放棄判断(2026-10-09)

## 結論: 放棄(mainマージ不採用)

## ブランチ残差の精査結果(2ファイル、wip 4件)
1. **src/ui/server.js**: handleDevserver を async 化し、devserver起動時に
   **既定でブラウザを開く**(open:false で抑止)実装 + POST経路の待ち合わせ改善
   (started.ok かつ !alreadyRunning 条件の緩和、waitForPort後のurl反映)。
2. **test/browser-open.test.js**: 既定オープンを検証するテスト追記。

## main側の現行仕様(採用済みの別解)
- main は既に `/api/devserver` POST で await handleDevserver + ブラウザオープン対応済み
  (server.js 879-883行)。ただし設計は逆で、**open:true 明示時だけ**開く
  (テストやAPI呼び出しのたびに標準ブラウザのタブが量産されるのを防ぐ意図のコメント付き)。
- ブランチ側は既定オープンのため、マージするとタブ量産の設計判断を覆す。
- さらに waitForPort 前提の URL 確定ロジックは main の現行経路(handleDevserver 内で
  url を即返す)と干渉し、devserver.test.js / browser-open.test.js の
  現行6テストが緑で稼働している実績を壊すリスクがある。

## 判断
- 目的(起動時のブラウザオープン)は main 側に別設計で着地済み。
- ブランチ側は「既定で開く」仕様で main と真逆。タブ量産を防ぐ main の判断を優先し、
  マージせず放棄する。

## 検証
- main HEAD: test/devserver.test.js + test/browser-open.test.js → 6/6 緑。

## 記録
- ブランチ: agent/engine-r3-cleanup-alpha(worktree worktrees/engine-r3-cleanup-alpha)
- 判断者: クラッシュ復旧担当(リーダー)
- 影響: なし。
