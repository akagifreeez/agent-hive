# セキュリティ監査レポート — 2026-09-27

hiveコードベースへの敵対レビュー(redteam-r5)の結果記録。対象: safePath / gatedBash / UI API / CSRF / monitor / 監査回避経路。すべての指摘はコード根拠つき(再現不能な推測は含まない)。

## 指摘一覧(深刻度: H=高 / M=中 / L=低)

### safePath / パスエスケープ

1. **(H) シンボリックリンク脱出** — `safePath` (src/engine/tools.js:587) は resolve 後の文字列 prefix 比較のみで realpath/symlink チェックなし。ワークスペース内に symlink `link -> /etc` を作っておけば `read_file("link/passwd")` でワークスペース外を読める。write系(safeWritePath)も同様に state/ 以外への symlink 書き込み(例: `link -> ~/.ssh`)が通る。
   再現: `ln -s /tmp/out escape; write_file("escape/pwn","x")`

2. **(M) read_file は state/ を読める** — safeWritePath は state/ を拒否するが read_file/list_files は制限なし。監査台帳・ボードJSONL・usage をエージェントが自由に読める。「state/ を読まない」規律はプロンプト規律のみでコード強制がない。

### gatedBash / コマンドバイパス

3. **(H) deny/ask リストの自明な回避** — `permissions.js` の DEFAULT_DENY/DEFAULT_ASK は部分文字列一致。`rm -r -f /`、`rm --recursive --force /`、変数展開 `R="rm -rf"; $R /tmp`、base64デコード実行等は素通し。シェル構文を解釈していない。

4. **(M) auto モードが ask を全自動承認** — `permissions.js` setMode("auto")。UIから1クリックで実質ゲート無効化。

5. **(L) Windows shell:true** — `exec.js:24-25`。cmd.exe メタ文字は許可側で制限なし(deny回避と同根)。

### UI API / 認証・権限

6. **(H) /api/exec が認証なしで任意コマンド実行** — `ui/server.js` の /api/exec → runCommand (cwd=workspace, 120s)。UI は 127.0.0.1 バインドだが、悪意あるWebページからのCSRF(DNS rebinding含む)で localhost:7789 にPOSTできればユーザー権限でコマンド実行。全POST API(/api/say, /api/tasks, /api/permission, /api/thread, /api/attach, /api/model, /api/perm, /api/workflow)も同様。

7. **(M) /api/permission の id 未検証** — CSRF から pending 承認リクエストの id を /api/state で読み取り、approve=true を送れば「rm -rf」等の承認をユーザーに代わって出せる(6と組合せで高深刻度化)。

8. **(M) /api/attach の格納** — dataUrl 検証後 uploads/ に8MB上限で書き込み。/uploads/ 配信の Content-Type は拡張子ベース(octet-stream フォールバック)のため XSS 直結は低いが、格納先がワークスペース直下でエージェントの read_file に露出。

### CSRF / DNS rebinding

9. **(H) Origin/Host 検証なし** — 全エンドポイントで Origin 検証なし(grep "Origin" 0件時点)。DNS rebinding なら同一生成元となり /api/state(タスク・ボード内容)・/api/audit(監査台帳)を外部ページが取得できる=情報漏洩。

### monitor

10. **(M) 0.0.0.0 リッスン・認証なし** — `config.js:31` monitorHost 既定 0.0.0.0、`server.js:718`。LAN上の任意ホストがボード投稿・タスク・エージェント状態・コストを閲覧できる。読み取り専用ではあるが、ボード文面に機微情報が乗る運用では漏洩面。

### 監査回避経路

11. **(H) 監査台帳の完全性** — writeAudit (tools.js) は state/audit.jsonl への appendFileSync だが、
    - (a) bash で `echo -n "" > state/audit.jsonl` 等の書き込みが可能(safeWritePath の state 拒否は write_file/edit_file のみで、bash は禁止していなかった)
    - (b) 5MB ローテート時の renameSync 失敗は catch で握りつぶし
    - (c) bash 内で行われた個別のファイル改変・ネットワーク送信は記録されない
    → 「bash で監査ログを消してから任意の作業」で監査回避が成立していた。

12. **(L) writeAudit の静かな欠落** — try/catch で全失敗を無視。ディスクフル等で監査が欠落し得る(検知不可)。

## 修復状況

| タスク | 内容 | 状態 |
|---|---|---|
| fix-ui-origin-csrf | 全POSTに Origin/Host 検証(isLocalOrigin、外部オリジン403)+ /api/exec を PermissionGate 経由に | 完了(test/ui-csrf.test.js) |
| fix-audit-bash-write | gatedBash に監査領域保護(auditTampering): state/ 参照+書き込み指示子の組合せを拒否、cd state + 書き込みも捕捉。読み取り系は許可 | 完了(test/audit-guard.test.js) |
| fix-safepath-symlink | safePath/safeWritePath に realpath ベース検証を追加し symlink 脱出を拒否 | 起票済み |
| fix-deny-normalize | deny/ask 照合前のコマンド正規化(オプション結合の吸収)で自明な回避を塞ぐ | 起票済み |

## 残る推奨事項(未修復)

- 指摘2: read_file/list_files による state/ 読み取りのコード強制(中)
- 指摘4: auto モードの範囲限定またはUI確認強化(中)
- 指摘7: /api/permission の id 検証・pending 照合(中)
- 指摘8: uploads/ 格納先の隔離(中)
- 指摘10: monitor のバインド既定を 127.0.0.1 に変更 or トークン認証(中)
- 指摘11(b)(c): ローテート失敗の検知、bash 内操作の可視化(低〜中)
- 指摘12: 監査書き込み失敗の検知機構(低)
- 指摘5: Windows shell:true のメタ文字扱い(低)

## 実行ベース検証の追記(beta, redteam-r5)

上記レポートに加え、実際にツール/UIを動かして再現した結果:

- **(H) bash の state 改ざん検知の迂回を実証** — `d=state; echo x > $d/evil2.jsonl`(変数展開)および `echo c3RhdGU= | base64 -d | xargs -I{} sh -c "echo x > {}/evil3.jsonl"` は auditTampering を素通りし、state/ 配下にファイルが実際に作成された(指摘11(a)の補強)。→ fix-audit-postcheck(事後スナップショット検知)を起票済み。
- **(H) isLocalOrigin のヘッダ無しPOST許可を実証** — `isLocalOrigin({headers:{}}) === true`。Origin/Host を送らない文脈(file:// ページ等)からのPOSTが通る(指摘9の補強)。→ fix-csrf-token(X-Hive-Token 方式)を起票済み。
- **(L) symlink ガードのテストが Windows で常に skip を実証** — test/safepath-symlink.test.js は symlink 作成権限が無い環境で3件全て skip。junction ベースのテストへ書き換え推奨。
- 防御が効いていたもの(実証): read_file の `../../`・バックスラッシュ・`C:\` 絶対・UNC は全て拒否、write_file の state 書き込み・bash の直接 `> state/` も拒否。
