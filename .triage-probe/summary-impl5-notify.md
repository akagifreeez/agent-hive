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
