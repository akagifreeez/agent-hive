// 「ガードONのままblockerを起動→待ちループ(空回り)→ガードOFF→blockerは素通し済みで実行中」説の検証:
// つまりテスト現行コードでは setSemaphoreSelfBlockGuard(false) が block取得の前にあるから順序は正しい。
// では再現Dとの差は? 現行テストは withSemaphore() を使う。withSemaphoreのfinallyは resetTestSemaphore()。
// 順序: resetTestSemaphore→setTestMaxConcurrent(1)→try{ setSelfBlockGuard(false) ... }
// 再現Dと同一のはず。唯一の差: ファイル先頭の setSemaphoreSelfBlockGuard(true) は同じ。
// 残る差: テストファイルは先行テスト(3つ)が走った後。先行テストが残した非同期の掃き溜め(spawn中のプロセス)がある?
// → 先行テストの「上限1で直列化」テストは2本のemptyを直列に走らせ完了待ちする。done-echo等の残骸プロセスは無いはず。
// 検証: 先行テスト無しで現行テスト関数だけを単体起動したら通るか(既にdiag12で top-level は通過済み、node:test内もCでok=true…)
// → では実物のテストファイルを、この1テストだけに絞って実行する
