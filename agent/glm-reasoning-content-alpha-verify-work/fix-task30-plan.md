# 修正方針: #30系テスト3件の旧契約期待値を新契約へ追従

## 現状(2026-10-07 npm test フル実行で26fail、うち#30系3件)

src/engine/tasks.js の create() は現契約(#30後):
- open/claimed中のID → false(一意性)
- done済みID → **false(スキップ)** — blog lab実害: seed再実行でdone/タスクがopenへ再起票され、dependsOn依存解決が永久ブロック
- claimされていない(openに残る)IDの再create → false(既存の後方互換)

問題: テスト3件が旧契約「done済みIDの再createはtrue」を期待したまま。

## 対象

1. test/task-id-uniqueness.test.js L39「#30: done済みIDの再createは通る」
2. test/task-unique.test.js L51「done済みIDの再createは通る」
3. test/task-uniqueness.test.js L52「create: done済みIDの再createは通る」

## 修正方針(src/は触らない)

各テストを新契約へ追従:
- done済みIDの再create → falseを期待に変更
- 追加検証: open/に再起票されない(snapshot().open に含まれない)、done/の実体が1件のまま
- テスト名も「done済みIDの再createはスキップされる」等へ変更
- 自動再投入運用の維持は「起動時回収で解放されたタスクの再請求」で担保される旨をコメント明記

## 検証手順

1. node --check 3ファイル
2. node --test で3ファイル単体実行 → fail 0
3. test/fixes.test.js(releaseOneの#30新契約対応済み)も併せて単体実行
4. npm test フルは heavy 分離(isolate-heavy-tests)と合わせ最終確認

## 注意

- edit_fileでの複数行置換はCRLF環境でリテラル破損リスク → 修正後は node --check 必須
