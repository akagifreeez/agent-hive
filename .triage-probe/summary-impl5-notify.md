# impl-5検証まとめ(ベータ・2026-10-09)

## 1. notify.jsのunrefソース確認
- main(HEAD)とimpl-5のsrc/notify.jsは同一のunref実装(L88-89): `timer.unref()` が notify.js の setInte
rval 後に呼ばれる
- **ソースはmainに反映済み**。差分なし(diff空)。

## 2. テスト面
- mainの test/notify-stall.test.js に unref 固定テストは**未反映**(grep unref = 0件)
- impl-5には cf538bb「test(notify): 通知タイマーunref回帰固定…」があり、L80以降に子プロセスベースの
固定テスト(ref付きはSIGTERM/unref付きは自然終了)を含む
- 私が同テスト相当をmainワークスペースで実行 → PASS(ref付きはSIGTERM、unref付きはexit 0)。Node公式Ti
mer.unref仕様と一致
- **mainへのこのテストの取り込みは未実施**(impl-5ブランチはマージ作業が進んでおらず、グラフも不完全)

## 3. その他の確認
- test/discover-smoke-capability.test.js も同様にimpl-5側にあり、mainに同等物なし
- discover.jsスモーク既定の検出能力は私のプローブで main現行コード上 PASS(失敗→fix起票・復旧→自動解決)

## 結論
- impl-5の修正(src/notify.js unref)はmain反映済みだが、**回帰固定テスト(notify unref固定)がmainに
入っていない**ため、fix-22以降の「テスト込みで取り込む」見立てと合致
- 後続推奨: テスト移植タスク(notify-stall unref固定テストのmain取り込み)をrun-testsへ起票依頼

## 追記: test-semaphore検証(.triage-probe/impl5-tst.js)
- impl-5のセマフォテスト9件をmainワークスペースで実行 → 8/9 PASS
- 唯一のFAIL: 「isTestCommand: 文中のtest語に誤反応しない」の `npm run test:coverage` ケース
  - main実装は test[:接尾] を許容する設計(package.jsonに test:heavy が実在し、検出が正しい)
  - impl-5側テストは接尾つきを一律false期待=テスト側の期待が古い(mainの test:heavy 実在と矛盾)
  - 判定: main実装は正しく、impl-5テスト側の期待値を mainの実スクリプト構成(test:heavy)に合わせて修正すべき
- その他の実質検証(runTestCommand FIFO直列化・上限並列・待ちタイムアウト・config反映・実コマンド統合)は全PASS

