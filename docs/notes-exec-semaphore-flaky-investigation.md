# 調査メモ: exec-semaphore.test.js がフル実行時のみ5件落ちる(2026-10-08 ガンマ)

## 現象
- 単独実行(`node --test test/exec-semaphore.test.js`)は9/9緑。
- 複数ファイル同時実行(`node --test test/exec-semaphore.test.js test/test-semaphore-leak.test.js ...`)だと
  exec-semaphore.test.js のセマフォ系5テスト(T2上限1直列化/T4上限2並走/T5 FIFO/T6リーク/T7ガード解除リーク)が落ちる。

## 落ち方のパターン(2種)
1. **子テストの完了痕跡が無い**(T2/T4/T5): `done-1`等のechoがログに現れない。
2. **exit=127 / "This: command not found"**(T6/T7): npxのシム経由で壊れたコマンドラインが実行されている。

## 再現実験(2026-10-08 ガンマ)
- `NODE_TEST_CONTEXT=child-v8 node --test test/fixtures/empty.test.js` →
  **「run() is being called recursively within a test file. skipping running files.」警告と共に
  テスト0件で即終了(exit=0・約数十ms)**。環境変数なしでは通常実行(1件実行)。
- つまり `env: { NODE_TEST_CONTEXT: undefined }` による上書きが効いていない子プロセスがあると、
  フィクスチャが即帰りしてしまい、T2/T4/T5は「スロット保持期間が無い」ため崩れる。

## 疑わしい点
- cafb9de(T4/T7修正)は `env: { NODE_TEST_CONTEXT: undefined }` を runTestCommand の **o.env** に入れた。
  しかし exec.js:159-160 の spawn は `childEnv = scrubEnv(process.env, env)` を使い、
  scrubEnv の実装は `{ ...out, ...extra }` の **スプレッド**。JSのスプレッドは
  `undefined` 値のキーを**上書きせず保持する**(正確には value が undefined のプロパティは
  スプレッド結果に存在するが `process.env` への適用時に undefined は「削除」ではなく「無視」されない…
  環境によっては "undefined" 文字列化の恐れ)。→ **渡し方が causes 幾つかのnodeバージョンで無効**。
- **nodeの挙動**: `process.env` に `undefined` を代入すると Windows では "undefined" という**文字列**が
  設定される実績がある(envがstring化される)。spawn の env に undefined 値キーがあると
  libuv は `"undefined"` 文字列にする場合がある → 子は `NODE_TEST_CONTEXT=undefined` を継承し、
  `typeof NODE_TEST_CONTEXT !== "undefined"` が真のまま → 再帰スキップのまま。
- T6/T7の exit=127 "This: command not found" は npxシム(cmd/shim経由)が env を破壊した痕跡。
  `node --test ...` を bash -c 経由ではなく shell:true(npxシム)で流すとPATHのnode解決が壊れる。

## 次の一手(修正案)
- **案A(推奨)**: scrubEnv/runCommandInner で `extra` の値が `undefined` のキーを result から
  **明示削除**する(`delete out[k]` 相当)。nodeのenvは削除が正しい意味になる。
  テスト側は既に `env: { NODE_TEST_CONTEXT: undefined }` を渡しているので、
  ランタイム1箇所の修正で T4/T7は直る見込み。T2/T4/T5はempty.test.js実行に
  `env: { NODE_TEST_CONTEXT: undefined }` を足せば同じく解消。
- **案B**: テスト側で空のenv上書きヘルパーを作る(ランタイムに触らない)。ただし
  scrubEnvのundefined扱いは本番でも潜在的バグ(HIVE_ENV_ALLOW等と組合せで奇妙な挙動)なので
  案Aのランタイム修正+テスト側フィクスチャ対応が正道。
- 検証: 修正後に (1) exec-semaphore.test.js 単独 (2) 5ファイル同時実行、の両方で緑を確認する。

## 関係コミット
- cafb9de「fix(test): slowフィクスチャにNODE_TEST_CONTEXT上書きを明示しフレーキー解消」(既存の対策は半端)
- test-semaphore-leak.test.js / exec-semaphore.test.js は2026-10-08の実障害(slowリーク)の回帰テスト群
