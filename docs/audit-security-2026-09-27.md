# セキュリティ敵対レビュー(2026-09-27, beta/redteam-r5)

実行ベースの検証のみ記載(再現不能な指摘は含まない)。検証スクリプト: redteam-probe.mjs(検証後削除可)。

## 指摘一覧

### H-1. gatedBash の state/ 改ざん検知は変数展開・エンコードで迂回できる(深刻度: 高)
- 再現手順: エージェントのbashツールで `d=state; echo x > $d/evil2.jsonl` を実行 → 監査検知を素通りして state/ 配下にファイルが作成される(T8実証: file exists: true)。`echo c3RhdGU= | base64 -d | xargs -I{} sh -c "echo x > {}/evil3.jsonl"` も同様(T9実証)。
- 最悪影響: 監査台帳(state/audit.jsonl)の改ざん・偽造が可能になり、「事後検証」の信頼性が失われる。
- 修正案: 完全防止は不可能なため、(a) state/ 配下の実書き込みを検知する事後フック(書き込み後のファイルサイズ/内容ハッシュ照合)、または (b) bash実行前に `runCommand` の cwd 配下で state/ への書き込みを OS レベルで読み取り専用化(ACL)する。小修復として (a) の検知+警告を推奨。

### H-2. /api/exec は Origin ヘッダ無しのPOSTを許可する(深刻度: 高)
- 再現手順: `isLocalOrigin({headers:{}})` が true を返す(実証済み)。同一マシン上の任意プロセス(または file:// ページ等 Origin を送らない文脈)から `POST /api/exec` にコマンドを送れる。
- 最悪影響: PermissionGate の ask パターンに一致しない任意コマンドが、ブラウザを経由せずに実行できる。UIサーバーは localhost 待ち受けとはいえ、他プロセスからの実行経路になる。
- 修正案: POST系APIにトークンを要求(起動時に生成したランダムトークンをUIのHTMLに埋め込み、`X-Hive-Token` ヘッダで検証)。ヘッダ無しPOSTは拒否に変更。

### M-1. read_file で state/ 配下が読める(深刻度: 中)
- 再現手順: `read_file {path:"state/audit.jsonl"}` が成功(T5実証: ALLOWED)。
- 最悪影響: 監査台帳・セッション・usage等の内部データをエージェントが自由に読める(機微情報の露出、かつ改ざん計画の下地になる)。
- 修正案: read系も state/ は拒否(または監査台帳のみ読み取り許可のホワイトリスト)。設計意図(監査は読める)なら docs に明記。

### M-2. monitor が既定 0.0.0.0 で公開され、モデル名等を返す(深刻度: 中)
- 再現手順: `config.ui.monitorHost ?? "0.0.0.0"`(server.js:753)。/api/monitor は model 名・監査件数・タスク一覧を返す。
- 最悪影響: LAN上の任意ホストから進捗・内部構成情報を閲覧できる。
- 修正案: 既定を 127.0.0.1 に変更し、外部公開は monitorHost の明示指定を要求。

### M-3. /api/merge-feedback の taskId に書式検証が無い(深刻度: 中)
- 再現手順: `POST /api/merge-feedback` に `{"taskId":"<任意の2000字文字列>","comment":"x"}` を送ると、そのまま onFeedback へ渡る(server.js:318-334、taskIdの正規表現検証なし)。
- 最悪影響: 不正な taskId が下流(feedback処理・スレッド復元)に流れ、ボード/スレッドの表示崩壊や意図しない宛先への投稿になる。
- 修正案: `/^[a-z0-9][a-z0-9-]*$/` 検証を追加(wtdiff と同じ基準)。

### L-1. 監査ローテートが1世代のみ(深刻度: 低)
- 再現手順: writeAudit は 5MB 超で audit.jsonl → audit-1.jsonl へ rename(上書き)。
- 最悪影響: 長時間稼働で旧世代監査が失われる。
- 修正案: タイムスタンプ付き世代名(audit-YYYYMMDD-HHMM.jsonl)へ。

### L-2. symlink ガードのテストが Windows で常に skip(深刻度: 低)
- 再現手順: test/safepath-symlink.test.js は symlink 作成権限が無い環境で全 skip(実証: "# skip: symlink作成権限なし" ×3)。
- 最悪影響: H-1 とは別に、symlink 脱出ガード(safePath の realpath チェック)がこの環境では一度も検証されていない。
- 修正案: junction を使った Windows でも実行できるテストに書き換える。

### L-3. deny パターンの正規化が `--` 形式のオプションを結合しない(深刻度: 低)
- 再現手順: `normalizeCommand("rm --recursive --force /")` は `rm --recursive --force /` のまま(DEFAULT_DENY の "rm -rf /" に一致しない)。ask の "rm -rf" も一致しない。
- 最悪影響: 破壊的コマンドの長いオプション表記が ask 承認を素通りする。
- 修正案: `--recursive`/`--force` 等の同義語マッピングを正規化に追加。

## 検証済みシナリオ(ボード記録用の10件)
1. read_file `../../package.json`(traversal)→ 拒否
2. read_file `..\..\package.json`(backslash)→ 拒否
3. read_file `C:\Windows\win.ini`(ドライブ絶対)→ 拒否
4. read_file `\\localhost\c$\x`(UNC)→ 拒否
5. read_file `state/audit.jsonl` → 許可(M-1)
6. write_file `state/x.json` → 拒否
7. bash `echo x > state/evil.jsonl` → 拒否(検知動作)
8. bash `d=state; echo x > $d/evil2.jsonl` → 素通り(H-1)
9. bash base64+sh 迂回 → 素通り(H-1)
10. isLocalOrigin: ヘッダ無し=true / Host偽装=false / Origin偽装=false(H-2)