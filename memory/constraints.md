# 制約(環境・依存・方式)

- Windows環境(Git Bash自動検出)。リポジトリ内のテキストはCRLF混在。edit_fileのold_text一致はCRLFファイルで失敗するため、perl等でLFへ正規化してから編集する(2026-09 merge-queue-r6で確認)。
- gccは無い環境。Cコードの検証はpython3等の代替実行で行う(harness-demoで実績)。
- テストは `npm test`(node --test test/*.test.js)。worktree運用時は自分のブランチでコミットしfinish_taskでmainへマージ。
- 型検査は `npm run typecheck`(tsc --checkJs)。コア契約(Post/TaskInfo/HiveConfig/ToolResult等)のtypedef逸脱を検出する。JSDoc注釈ズレはここで捕捉(2026-09 JSDoc契約の導入)。
- UIサーバーのPOSTはCSRFトークン必須。テストからは test/helpers/hf-token.js の tokenedFetchOn() を使う。
- state/ 配下は読み書き禁止(監査台帳含む)。横連携はボード投稿・タスク・gather_context 経由のみ。
- ポート/トークンは環境変数上書きが可能: HIVE_UI_PORT(ui.port)/HIVE_MONITOR_PORT(monitorPort)/HIVE_UI_TOKEN(CLI用CSRF)。開発サーバー起動中のSMOKEや梱包アプリ検証では衝突を避けるのに使う(2026-09 search-alert-r7)。
- SMOKE疎通はElectron内fetchを使わない(システムプロキシでlocalhostでも滞留する)。node http + 5秒タイムアウトで実施(2026-09 search-alert-r7)。
- マージは競合マーカーガード付き(src/engine/worktree.js mergeWithAgentBranch): (0)main側にマーカー残存ならマージ中止(marker:true) (1.5)ブランチ側の差分ファイルにマーカーがあれば拒否して作業者へ返送(「worktree内で削除してコミットしてから再finish」)。マーカー入りの確定がmainへ入る経路を構造的に遮断(2026-09 merge-queue-r6)。

# 失敗と教訓

- マージ過程でdetectNpmScriptsが落ち・文字列リテラル破壊が発生した実績あり。競合解消は「固定リテラル保持」で復元済み(overlap-guard)。マージ競合時はテスト全実行を習慣に。
- **テンプレートリテラル内生改行の破壊が再発**(2026-09 overlap-guard-r6): edit_fileで複数行の文字列を書き換えると、意図した
がリテラル内の生改行(CRLF)として書き込まれ構文エラー→全テストが落ちる。tools.jsで2回発生。対策: 
を含む置換はedit_fileで生改行を書かず、nodeスクリプト(s.replace(bad,good))で置換するのが安全。修復後は必ず構文確認(import実行)してからnpm test。edit_fileとperlが連続失敗する際はgit改行正規化(CRLF/LF)との干渉を疑うこと(2026-09 fix-test-failuresで確認)。
- **nodeパッチスクリプト自体が破壊源になる**(2026-09 search-alert-r7で実害): 対象ファイルへ埋め込むコードをパッチスクリプトのテンプレートリテラルで書くと、実行時にその中の ドル波括弧 が展開され壊れた文字列が書き込まれる。対策: パッチスクリプト内ではバッククォートとドル波括弧を一切書かず、行配列+文字列連結(断片はJSON.stringifyで安全化)で組み立てる。破損したら手修復で二重化させず git checkout main -- <file> で原本へ戻してやり直すのが最短。
- **stash popの競合解消はCRLFに注意**(2026-09 search-alert-r7): git stash push → merge main → stash pop で競合ブロックが残る。マーカー行(<<<<<<< Updated upstream 等)は行末にCRが付くため等値比較はCRをstripしてから。解消は main側/自分側のどちらを採るか明示して1ブロックずつ。
- **競合解消は「採用側を明示」してから検証。未解決マーカーをレビュー/マージに流さない**(2026-09 search-alert-r7-late): 競合ブロックの解消は (1)nodeスクリプトでマーカー行を行頭完全一致(CR strip)で検出 (2)HEAD/mainどちらを採るか明示して splice (3)node --check 全改変ファイル+grep でマーカー残存0を確認、が定型。採用側を決めずに「空行差分だから」と安易に削ると残骸マーカー(>>>>>>> main 等)が構文エラーとして後で発覚する。競合が複数ファイルに及ぶ場合は発見器(fix-merge-markers-*)が起票するので、先行者はボードで「実質作業完了」を宣言して重複を防ぐ。
- **競合を含むままコミットすると構文が壊れた状態がgit履歴に残る**(実害): wipコミットで競合ファイルを置いたままpushしない。解消済み版だけをコミットする。なお作業中の段階コミット(wip: chat-round)自体は有効—ラウンド中断・モデルエラーでworktreeが失われてもmainへ自動マージされるセーフネットになる(本ラウンドで二重化修復がwipコミット経由で救われた)。
- **マージ過程で関数/typedefが二重化することがある**(2026-09 search-alert-r7-late): mcp.jsで mcpServersInfo が2個・typedefが2個になり SyntaxError 25ファイル連鎖(全テストが構文エラーで落ちる)。二重化は grep -c "export function <名前>" で検出。解消は1個目を残して2個目のコメントブロック(/**)から関数終了までを削除し、typecheckで確認。ネストしたマーカー(<<<<<<<の中に<<<<<<<)ができることもある — 検出は grep -c '<<<<<<<' で数を確認し、解消後に0であることを必ず検証(2026-09 merge-queue-r6 で mcp.js に再混入を複数回確認)。
- **競合修復用の一時スクリプト(tmp-fix-*.mjs)は目的達成後に必ず削除**(2026-09 cleanup-tmp-fix-scriptsで実績)。マーカー解消の自動化に使ったスクリプトがリポジトリに残ると次の発見器・レビューのノイズになる。
- 実験・デバッグ用スクリプト(tmp-*.mjs、exp-*、t_main等)をリポジトリ直下に置かない。特に鍵ファイルへのハードコード参照は機微情報の漏出リスク。作業終了時に削除する習慣(2026-09 cleanup-exp-files、search-alert-r7で残骸多数を確認)。旧記載の「t_main残存(未対応)」はcleanup-exp-filesで解決済み。

- MCP設定ウィンドウ(/api/mcp・mcpAdd)のテスト(test/mcp-settings.test.js)は実物のstdioサーバーを起動するため遅い(私の環境で約100秒タイムアウトを確認、2026-09 merge-queue-r6-beta)。bashコマンドのタイムアウト上限(120秒)に達するため、テスト単体実行はtimeout併用か、対象を絞って実行すること。
- npm test 全体(220件超)はマシン負荷次第で120秒を超えることがある。フルテストはタイムアウト上限300000msを指定して実行するか、着手前は関連テストだけ先に回す(2026-09 search-alert-r7で確認)。

# 将来への引き継ぎ

- 監査docs(docs/audit-*.md)に実効性指摘S1〜S8あり。読み取り系state/ガード・bash迂回・web_fetchのURL未記録などは未対応。
- worktree内に未コミット変更があるとsetupWorktreesはそれを保持(onKept告知)。引き継ぎはボード告知経由。
- タスク重複検知(detectTaskOverlap): create_task時に未着手/作業中タスクと本文のpath風トークンを比較し共有ファイルがあれば警告を返値へ添える(ブロックしない)。実装は src/engine/tasks.js+tools.js、テスト test/overlap-guard.test.js(2026-09 overlap-guard-r6)。
- ボード全文検索(/api/board?q=): BoardStore経由でJSONLを線形走査し、thread=/limit=対応・新しい順・RAM分とディスク分は thread#id で重複排除。UIはヘッダ検索ボックス+オーバーレイ結果(クリックでスレッド切替)(2026-09 search-alert-r7)。
- 予算アラート(config.chat.budgetAlertUsd): usage.round購読で初回超過時のみメインボードへ告知(以後フラグ抑止)。UIはlive.budget参照。パッチ適用でlive配下からtop-levelへstateが逸出した事故あり — UIが参照するliveの構造を崩さないこと(2026-09 search-alert-r7)。
- claimMiss診断(project無し時のopen一覧提示): claim_next_taskが空のとき、project指定なしでも全openのid/role/project一覧を応答へ含める。role不一致のタスクを実在のまま見失って空待ち・早期退場する事故(2026-09 r7で実害)の再発防止。テスト test/claim-miss-diagnosis.test.js(2026-09 overlap-guard-r6)。
- タスク解放時の起床(task.released)とidle退場の入力保護(steering入力があれば請求ミス3回でも1回だけ退場回避)は engine標準挙動(chat.js)。解放タスクが凍結する問題への対策済み。
- モデル/思考レベルの実行中切替UIは入力欄上の操作部(composer-model/composer-effort)。設定ウィンドウは権限モードとAPIキーに専念(2026-09 設定ウィンドウからの移設)。
- レビュー済み地点はgitタグ reviewed(discover.jsのdiffプローブが git diff reviewed main でreview-changes起票、レビュー完了時にadvanceReviewedTagが前進)。distillの処理済みマーカーはエンジン管理でAIは触らない(2026-09)。
- MCPサーバーは設定ウィンドウから実行中に追加/削除できる(/api/mcp -> mcpAdd/mcpRemove)。実物のstdioサーバーを即起動し、ツール一覧は各ラウンドのcreateToolsで動的反映。永続化先は hive.local.json(userData基準=梱包時も有効)。一覧応答は mcpServersInfo() に統一され、envの値は返さない(envKeysのみ=機微情報の漏出防止契約)。mcpServersInfo/McpHostInstance は src/engine/mcp.js で1組のみ(重複定義は過去に実害)。テストは test/mcp-settings.test.js(遅いため単独実行推奨)(2026-09)。
- safePath/safeWritePath は symlink実体(realpath)の脱出も拒否する。存在しないパスは最も近い存在する親を辿って検証。テスト test/safepath-symlink.test.js(2026-09)。
- bashのstate/保護は2段階: (1)事前拒否 -- state/参照+書き込み指示子(> / tee / rm 等)の組合せを検出して拒否(変数展開やbase64は迂回可能) (2)事後検知 -- 実行前後の state/ スナップショット比較で変更を検出し、結果を警告付きの失敗に変換+permission.denied発火(実行取消はできないため可視化が目的)。テスト test/audit-guard.test.js・test/state-guard.test.js(2026-09)。
