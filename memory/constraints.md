# 制約(環境・依存・方式)

- Windows環境(Git Bash自動検出)。リポジトリ内のテキストはCRLF混在。edit_fileのold_text一致はCRLFファイルで失敗するため、perl等でLFへ正規化してから編集する(2026-09 merge-queue-r6で確認)。
- gccは無い環境。Cコードの検証はpython3等の代替実行で行う(harness-demoで実績)。
- テストは `npm test`(node --test test/*.test.js)。worktree運用時は自分のブランチでコミットしfinish_taskでmainへマージ。
- UIサーバーのPOSTはCSRFトークン必須。テストからは test/helpers/hf-token.js の tokenedFetchOn() を使う。
- state/ 配下は読み書き禁止(監査台帳含む)。横連携はボード投稿・タスク・gather_context 経由のみ。

# 失敗と教訓

- マージ過程でdetectNpmScriptsが落ち・文字列リテラル破壊が発生した実績あり。競合解消は「固定リテラル保持」で復元済み(overlap-guard)。マージ競合時はテスト全実行を習慣に。
- **テンプレートリテラル内生改行の破壊が再発**(2026-09 overlap-guard-r6): edit_fileで複数行の文字列を書き換えると、意図した
がリテラル内の生改行(CRLF)として書き込まれ構文エラー→全テストが落ちる。tools.jsで2回発生。対策: 
を含む置換はedit_fileで生改行を書かず、nodeスクリプト(s.replace(bad,good))で置換するのが安全。修復後は必ず構文確認(import実行)してからnpm test。edit_fileとperlが連続失敗する際はgit改行正規化(CRLF/LF)との干渉を疑うこと(2026-09 fix-test-failuresで確認)。
- 実験・デバッグ用スクリプト(tmp-*.mjs、exp-*、t_main等)をリポジトリ直下に置かない。特に鍵ファイルへのハードコード参照は機微情報の漏出リスク。作業終了時に削除する習慣(2026-09 cleanup-exp-files、search-alert-r7で残骸多数を確認)。旧記載の「t_main残存(未対応)」はcleanup-exp-filesで解決済み。

# 将来への引き継ぎ

- 監査docs(docs/audit-*.md)に実効性指摘S1〜S8あり。読み取り系state/ガード・bash迂回・web_fetchのURL未記録などは未対応。
- worktree内に未コミット変更があるとsetupWorktreesはそれを保持(onKept告知)。引き継ぎはボード告知経由。