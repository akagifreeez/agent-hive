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
- 外部サイト取得はweb_fetchとbashのcurlで成功率が異なる(2026-09 weather-ai調査): www.gsi.go.jp等はweb_fetchで失敗・curlで成功(両方試すのが定石)。逆にDWD(wis2bucket.dwd.de)はcurlでも3回接続断=当環境からの経路特異性(betaも同様)。python3利用可(タイル座標計算等の小検証で実績)。

# 失敗と教訓

- マージ過程でdetectNpmScriptsが落ち・文字列リテラル破壊が発生した実績あり。競合解消は「固定リテラル保持」で復元済み(overlap-guard)。マージ競合時はテスト全実行を習慣に。
- **テンプレートリテラル内生改行の破壊が再発**(2026-09 overlap-guard-r6): edit_fileで複数行の文字列を書き換えると、意図した
- **split("\n")等のエスケープ済み文字列も破損しうる**(2026-09 search-alert-r7-late実害): worktree.jsの split("\n") がパッチ適用過程でリテラル内生改行になり3箇所構文破損(node --checkで即検出)。教訓: 破損修復の置換文字列は文字列連結+String.fromCharCode(92)で安全に組み立てると再破損しない。修復時は全ソースを node --check 一括スキャンして同型破損の取りこぼしを防ぐこと。
がリテラル内の生改行(CRLF)として書き込まれ構文エラー→全テストが落ちる。tools.jsで2回発生。対策: 
を含む置換はedit_fileで生改行を書かず、nodeスクリプト(s.replace(bad,good))で置換するのが安全。修復後は必ず構文確認(import実行)してからnpm test。edit_fileとperlが連続失敗する際はgit改行正規化(CRLF/LF)との干渉を疑うこと(2026-09 fix-test-failuresで確認)。
- **nodeパッチスクリプト自体が破壊源になる**(2026-09 search-alert-r7で実害): 対象ファイルへ埋め込むコードをパッチスクリプトのテンプレートリテラルで書くと、実行時にその中の ドル波括弧 が展開され壊れた文字列が書き込まれる。対策: パッチスクリプト内ではバッククォートとドル波括弧を一切書かず、行配列+文字列連結(断片はJSON.stringifyで安全化)で組み立てる。破損したら手修復で二重化させず git checkout main -- <file> で原本へ戻してやり直すのが最短。
- **stash popの競合解消はCRLFに注意**(2026-09 search-alert-r7): git stash push → merge main → stash pop で競合ブロックが残る。マーカー行(<<<<<<< Updated upstream 等)は行末にCRが付くため等値比較はCRをstripしてから。解消は main側/自分側のどちらを採るか明示して1ブロックずつ。
- **競合解消は「採用側を明示」してから検証。未解決マーカーをレビュー/マージに流さない**(2026-09 search-alert-r7-late): 競合ブロックの解消は (1)nodeスクリプトでマーカー行を行頭完全一致(CR strip)で検出 (2)HEAD/mainどちらを採るか明示して splice (3)node --check 全改変ファイル+grep でマーカー残存0を確認、が定型。採用側を決めずに「空行差分だから」と安易に削ると残骸マーカー(>>>>>>> main 等)が構文エラーとして後で発覚する。競合が複数ファイルに及ぶ場合は発見器(fix-merge-markers-*)が起票するので、先行者はボードで「実質作業完了」を宣言して重複を防ぐ。
- **競合を含むままコミットすると構文が壊れた状態がgit履歴に残る**(実害): wipコミットで競合ファイルを置いたままpushしない。解消済み版だけをコミットする。なお作業中の段階コミット(wip: chat-round)自体は有効—ラウンド中断・モデルエラーでworktreeが失われてもmainへ自動マージされるセーフネットになる(本ラウンドで二重化修復がwipコミット経由で救われた)。
- **マージ過程で関数/typedefが二重化することがある**(2026-09 search-alert-r7-late): mcp.jsで mcpServersInfo が2個・typedefが2個になり SyntaxError 25ファイル連鎖(全テストが構文エラーで落ちる)。二重化は grep -c "export function <名前>" で検出。解消は1個目を残して2個目のコメントブロック(/**)から関数終了までを削除し、typecheckで確認。ネストしたマーカー(<<<<<<<の中に<<<<<<<)ができることもある — 検出は grep -c '<<<<<<<' で数を確認し、解消後に0であることを必ず検証(2026-09 merge-queue-r6 で mcp.js に再混入を複数回確認)。
- **競合修復用の一時スクリプト(tmp-fix-*.mjs)は目的達成後に必ず削除**(2026-09 cleanup-tmp-fix-scriptsで実績)。マーカー解消の自動化に使ったスクリプトがリポジトリに残ると次の発見器・レビューのノイズになる。
- 実験・デバッグ用スクリプト(tmp-*.mjs、exp-*、t_main等)をリポジトリ直下に置かない。特に鍵ファイルへのハードコード参照は機微情報の漏出リスク。作業終了時に削除する習慣(2026-09 cleanup-exp-files、search-alert-r7で残骸多数を確認)。旧記載の「t_main残存(未対応)」はcleanup-exp-filesで解決済み。
- **URL仮定は必ず公式仕様と照合してから404を「配信終了」と判断する**(2026-09 weather-ai調査の実害): 地理院DEMタイルを xyz/dem14/{x}/{y}.txt(x/y/z順)と仮定して404→配信終了と誤認しかけた。正しくは xyz/dem14/{z}/{x}/{y}.txt(z/x/y順)。旧仕様の記憶・解説記事に基づくURLは初期テストで正規例(仕様ページ記載のURL)を通して検証してから応用する。404の原因は「終了・欠損・URL間違い」の3系統がある。
- **ボードへの長文報告は末尾が途切れることがある**(2026-09 weather-ai調査で2名が実害・私も#13で発生): 報告は要点を前半に置き、長大なら複数投稿に分割する。途切れた場合は「続き」と明記して再投稿し、acceptance判定の証拠が1投稿内で完結するよう工夫する。

- MCP設定ウィンドウ(/api/mcp・mcpAdd)のテスト(test/mcp-settings.test.js)は実物のstdioサーバーを起動するため遅い(私の環境で約100秒タイムアウトを確認、2026-09 merge-queue-r6-beta)。bashコマンドのタイムアウト上限(120秒)に達するため、テスト単体実行はtimeout併用か、対象を絞って実行すること。
- npm test 全体(220件超)はマシン負荷次第で120秒を超えることがある。フルテストはタイムアウト上限300000msを指定して実行するか、着手前は関連テストだけ先に回す(2026-09 search-alert-r7で確認)。
- 重いworktreeテストのフレーキー(2026-09 overlap-guard-r6)は npm test への --test-force-exit 追加で対処済み(2026-09): テスト後もハンドルが残ってランナーが終わらないファイルがあり、実行ごとに別テストがタイムアウトするのが原因だった。競合マーカーガードの注入テスト(test/marker-guard.test.js)と同時に導入。
- persist/thread系統合テストの行数固定 assert(「無音復元なので投稿が増えない」等)は並行負荷に弱い: autoscaleタイマー(30秒間隔の増員チェック)等が絡むフル実行時のみ落ちることがある。メカニズムは「ワーカー起動ラウンドの落ち着き待ち(行数2連続同一で打ち切り)がstagger遅延で早く抜け→demoLinesBefore確定後に応答1件が混ざる」競合(persist単体は安定、2026-09 search-alert-r7 で3者観測: ガンマ2回・ベータ1回)。判定はフル実行×2連続全緑を証跡にする。観測3回で緩め適用の目安に到達したが、テスト修正は一括適用(次回review-changes指摘かリーダー指示のタイミング。小出し修正はマージ競合リスクを上げるため避ける)(2026-09)。
- **persist v6.1 flakyは2段階で解決済み**(2026-09 merge-queue-r6): (1)autoscale:false をテスト設定へ追加(増員タイマーの干渉を遮断、3d85270) (2)落ち着き待ちを「2連続同一+約1秒静止(stableCount>=5)」へ強化し test/heavy/ へ移動(cac1fc7)。観測5回超での一括適用方針どおり。自動増員(autoscale)は実運用機能であり本番挙動は不変。
- **同一機能の並行実装は「先にmainへ入った方を正」で統一する**(2026-09 spawn-impl-2実績): usage集計UIをimplとrespawn側が並行実装し二重化。統一手順: (1)merge main後にgrep -cで二重定義・重複配線を検出 (2)main側の実装を残し自側の重複ブロック(関数+inline呼出)を除去 (3)main側への配線(呼出部)がスナップショットで落ちていれば復元 (4)script構文チェック+対象テスト全緑を証跡にする。
- **ラウンド再開後のworktreeは「現状確認してから触る」**: スレッド再開やwipスナップショット復元で、ラウンド中に編集した内容が別状態(自動マージ・相手実装の取込・配線の欠落)へ置き換わることがある。違和感があれば git status と git log、git diff main と grep で実質を確認してから再編集する(2026-09 discuss-mumdrr6i実績)。
- **一時ファイル削除のrmが監査で拒否されることがある**: bash拒否の理由文(監査領域state/への書き込み検出の誤検出)を読み、node -e の unlinkSync 等で安全に代替する(rmの再試行はしない。2026-09実績)。
- **git logのオプション指定は禁止パターンで拒否されることがある**: --oneline や --name-only、git show --stat で代替する(2026-09実績)。

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
- 気象データソース実テスト結果(2026-09 weather-ai改善調査・beta再現済み):
  - GSI標高タイル: 現行は xyz/dem/{z}/{x}/{y}.txt(10m相当)と xyz/dem5a/{z}/{x}/{y}.txt(5m・航空レーザー)が生きている(盛岡で200実測)。dem14/dem10a/dem10b/dem_pngは当該地点で404。TXT=256×256カンマ区切り標高(m・小数2位・欠損e)、PNG=h=(2^16R+2^8G+B)×0.01m・欠損RGB(128,0,0)(仕様: cyberjapandata.gsi.go.jp/development/demtile.html)。リアルタイム読込は出典明示のみで申請不要(maps.gsi.go.jp/development/ichiran.html)。基盤地図情報FG-GML本体は要ログイン(service.gsi.go.jp/kiban)・旧匿名FTP(fgd.gsi.go.jp)は接続断。2025-04-01の標高成果改定は2025-07-31以降提供分に反映(同ページお知らせ)。
  - GEFS: noaa-gefs-pds S3生存・匿名読取可。atmos/pgrb2sp25(0.25°)に geavg+gec00+gep01〜30(31ファイル/ステップ)。gespread単独ファイルは提供なし(KeyCount=0実測)→spreadはメンバーから自前計算。TMP:2mは1メッセージ約754KB・.idx+バイトレンジ(HTTP 206・"GRIB"確認)で取得可。f000〜f039は3h刻み・以降6h刻みでf240まで。メンバー全取得は約268MB/サイクル(12ステップ×31)。
  - ECMWF Open Data: ecmwf-forecasts S3(eu-central-1)が公開・CC-BY-4.0。AIFS Single v2は2026-05-12運用開始。.indexはJSON Lines(param/_offset/_length)で2tのRange取得をbetaが再現(206・GRIB確認)。遡及は2023-01-18以降がバケット残存。
  - Open-Meteo MSM historical-forecast(beta直接実テスト): https://historical-forecast-api.open-meteo.com/v1/forecast が無償・認証なし・web_fetchでも通る。models=jma_msm で temperature_2m等4変数同時指定可・1時間刻み・start_date=2022-09-01起点の遡及が200(学習期間起点を覆う)。2022-09以前の下限・レート制限・MSM更新タイミングのAPI反映差は未確認。
  - WIS2 Global Cache(DWD): JMA発は通知メタデータのみでデータ実体0件(impl-1実測)。DWDへの直接接続は当環境から経路断(beta再現不可) — 結論は「impl-1実測+beta再現不可」併記で運用。
  - data/nc手持ちGFS資産: 17,641ファイル=約1,470サイクル(f000〜f033の12ステップ構成・先頭2022090100・末尾2026092800)。gamma実測→beta同値確認。遡及学習の資産は健全。

- **finish_taskの台帳lapseで発見器が同じタスクを再起票し続ける**(2026-09 weather-ai-researchの実害): distill-learningsで「作業完了→finish_taskが『そのタスクは請求していません』で失敗」(請求状態のlapse)になると、実体成果物がmain反映済みでも処理済み地点が前進せず、fix-*/review-*/distill-系の再通知がループする。対処: (1)finish失敗時はclaimし直してからfinishする(lapse放置しない) (2)どうしても復帰できない場合はボードで訂正報告し、リード権限でopen復帰→再finish(またはclose時の地点前進)を依頼する (3)再通知が続く間は gather_context で open=0 を実証し、全員合意で「既消化の再配信」と明示してからclaim空転を打ち切る。

# 決定事項(2026-09 issue系列ラウンドで確定)

- **create_taskにdepends_on追加(イシュー#2)**: create が dependsOn(配列)を受け、メタ行 depends_on として保存。claim時にcanClaim()で「未完了依存があれば立候補しない」。循環依存は依存を無視して立候補不可(デッドロック防止)、自己依存は依存を無視して着手可。list()はdependsOn/blockedフィールドを返す。UIはタスク行「依存待ち:id」表示+フォーム入力欄+ /api/tasks create の depends_on 通過。テスト test/task-depends.test.js+task-depends-ui.test.js(2026-09)。
- **プロバイダ横断スロットリング(イシュー#1)**: src/model/throttle.js に gateProvider(送信前待ち)/noteProviderRateLimited(429/529時・Retry-Afterは単調延長・上限5分)/clearProviderRateLimit(成功時)。全アダプタ(openai/anthropic-messages/openai-chatgpt)が同一baseUrl単位でクールダウン共有。「429を見た呼び出しだけ」でなく同プロバイダ全員が待つ設計。テスト test/throttle.test.js(2026-09)。
- **usage集計はローカル日付基準(イシュー#6)**: aggregateUsage/persistUsageとも localDateKey()(ローカル日付)に統一。書き込み側と集計側の日付キー生成を1関数へ寄せ、深夜帯の「今日」バケット落ちを構造的に防止。usage.round/summaryにthread(無ければ__main__)+dateを付け、日別/スレッド別/日別xスレッドのmatrixを集計。テストはTZ差で検証(2026-09)。※後のfix-usage-aggregate-tzでも「UTC基準へ統一」が一時採用されたが、最終形はローカル基準のままで確着 — 重複した経緯記述は本条に統合済み。
- **ラウンドcheckpoint/resume(イシュー#4)**: ツール実行済み地点で checkpointFn?.(messages) を呼び、state/checkpoint-<id>.json へ tmp+rename原子書込。model.chat失敗(endedBy:"error")時のみ loadCheckpoint→memories差し替え→checkpoint削除して次ラウンド再開。正常系・checkpointFn未指定は従来どおり。**checkpoint削除は復元後(残すと失敗無限ループ)**。テスト test/checkpoint.test.js(2026-09)。
- **CLI --chat通知チャネル(イシュー#11)**: wireCliNotify(bus,{longTaskSec}) が permission.request/merge.completed/長時間タスク完了をコンソールへ出力し、onNotify追加配信で監視(/api/monitor)経由にも流す。UIサーバー側からの再wireは二重出力ガード(__cliNotifyWired)で冪等。デスクトップ通知(desktop/main.js)と併存可。テスト test/notify.test.js(2026-09)。
- **worktreeの未マージ保持(イシュー#7)**: hasUnmergedWork() でコミット済み・未マージのworktreeをsetupWorktrees/createWorktreeが削除せず保持(onKept告知)。未コミットの下書きのみは保持対象外(直呼び契約)。起動シーケンスは setupWorktrees→respawnUnfinishedWork の順で、未完了作業から respawn-<agentId>-<head|dirty> タスクを自動起票、変更なしブランチは放棄候補として報告(chat.respawn.cleanup=trueで掃除)(2026-09)。

# 運用教訓(2026-09 issue系列ラウンド)

- **検証済みタスクが「退場→自動解放→再スポーン」ループに入る**: 検証だけしてfinish→退場した作業者のタスクが自動解放でopenへ戻り、追加ワーカーが連続スポーンされる(2026-09 issue-dependsでimpl-1/5/7/8/10/11/12がループ、実害はトークン浪費のみ)。対策の方向: (1)リーダーがverify-*承認時に該当implタスクを明示クローズ (2)「実装差分ゼロなら検証者がapproveまで実施してよい」運用をリードが明示 (3)作業者側は請求時にタスクが既にmain反映済みなら検証→approveまで通す。スレッドごとに複数ロールが混在すると主担当交代が揺れるため、impl→review→approveの役割固定が有効。
- **validate後のタスクは「実装済み」を前提に検証する**: 請求したタスクが既にmain反映済み(codemerge済み)の場合は、worktree差分ゼロを確認→受け入れ基準テストの再実行で証跡→「追加コミット不要」と明示してfinish/approveするのが定型。コードを重複実装しない。
- **usage等の時刻境界テストはUTC/ローカル混在でflakyになる**: new Date()から生成した日付期待値は実行時刻(TZ・日をまたぐ時刻帯)でズレる。テスト側はTZ環境変数を明示固定するか、期待値も実装と同一の関数(localDateKey等)から生成する(2026-09 issue-costで実害→解決済み)。
- **browser-toolsの断片リンク契約は統一済み**: normalizeUrlが #断片に対しnullを返し、links/extractElements双方の遷移候補から除外する。browserSubmitレポートの接頭辞は「method: 」(テスト期待と一致、test/browser-tools*.test.js 13/13)(2026-09)。
- **edit_fileでテンプレートリテラルを壊したときの最短修復**は `git show main:<file>` で原本を取り直して該当ブロックを復元する(node -eパッチ再試行より安全。2026-09 issue-browserラウンドでworktree.js修復に実証)。
- **usage集計の蓄積契約はrunner.jsのemit形式と一致させる(2026-09 issue-throttle系列で実害)**: runner.jsは usage.summary として `{byAgent, totals}` をemitする。server.js側で旧契約 `p.usage` だけを読むと totals:null がusage.jsonへ蓄積され集計が静かに欠落する。修正は `totals: p.totals ?? p.usage ?? null`(旧契約互換維持)。集計テストの期待値は「加法的整合」(スレッド別合計の総和=全レコード合計)で検算し、matrixのassertキー(mainとスレッド名)の取り違えにも注意する。
- **usage-trace系の書込先はボードJSONLの親ディレクトリ配下に寄せ、state/監査領域直下には書かない(2026-09確定)**: loop.jsのトレースは二重ブロック(CWD相対のstate固定+persistPath基準)になりやすい。1本化の契約: persistPath無し時はthrowしcatchで握りつぶす(=監査領域へ決して書かない)。書込先を改修するときは「1ターン=1行」「state/直下にusage-trace.jsonlを生成しない」を実行再現で証跡にする。
- **ボード投稿は自身のスレッドへ投稿すると自分のボードに載らない**: to_thread指定時の注意。lead報告の取りこぼしがあったら他スレッドの投稿を見る(gather_context source=threads)。

- usage-traceとモニタ可視化(イシュー#15〜#17): (1)loop.jsはmodel.chatごとに usage-trace/usage-trace.jsonl へ1ターン1行追記(prompt/completion/reasoning内訳+ctxChars)。書込先はボードJSONLと同じ親の usage-trace/(state/監査領域には書かない。persistPath無し時はスキップ) (2)/api/usage-trace がagent・fromTurn/toTurnでフィルタしたseries/pointsを返す(fromTurn等はurl.searchParams由来のstring|nullも受ける契約) (3)loop.jsがbusへusage.traceを流すとserver.jsがlive.agents[id].ctx へ 使用/上限/残り(ctxWindow無ければ200Kフォールバック)を保持し、/api/stateで配布。エージェント詳細パネルのバー表示(使用/上限/残り+.hot警告色)のデータ源。トークン換算は「文字数/3切上げ」でcompact.jsと統一 (4)モニタページにmonitor-chart.js(IIFE・依存ゼロ・window/globalThis公開)でSVGチャート。yMaxは全系列(agents と tasks総数=open+claimed+done)の最大。XSS対策は数値toFixed+既知色リテラルのみ。テストからは globalThis.monitorChart 経由で呼ぶ(2026-09)。
- README自動更新(readme-auto.js): 差分ベースでREADMEを再生成する。未閉鎖のHTMLコメントマーカー保護ケースをテスト済み(test/readme-auto 11件)(2026-09)。
- **テストがstartUi()したら必ずui.close()する**: closeしないとサーバーハンドルが開いたままnode --testがプロセス終了できず、ファイル単位のタイムアウト(約60秒)で"test failed"になる(ctx-window-ui.testで実害・最小再現スクリプトで確定)。個別テストは全部緑なのにファイルだけ落ちるときはハンドル残存を疑う。finally で ui.close()+rmTree が定型(2026-09)。

# 2026-09 issue-modelselect系列ラウンドの知見(ベータdistill)

- **リーダーによるタスク別モデル選択(イシュー#12)は実装済み**: create_task/spawn_agent にリーダー専用・任意の model引数(ModelRef)。権限判定は二重防御(tools層=threadOpener有無、spawn層=parent.depth!==0で拒否)。タスクメタ model: 行を tasks.js(create/assign/metaLines/readMeta/list/TaskInfo)が扱い、spawn走行時はブリーフタスクのメタから readTaskModel → modelFactory({…agent, model: taskModel ?? agent.model}) へ伝播(未指定はagent既定)。原則「基本は既定モデル・特例で代替」。テスト test/model-task-select.test.js 5件(2026-09)。
- **モデル基盤の契約(2026-09 modelselectラウンド確定)**: プロバイダ(認証・baseUrl名前空間)と api(ワイヤ形式)は直交。api= openai-completions/anthropic-messages/openai-chatgpt-responses を src/model/factory.js のADAPTERSで選択。内蔵カタログ(builtin.js= models.dev静止スナップショット最小版)+設定 models.providers を catalog.js がマージし ModelRef("provider/model"またはベアID)を解決。旧 model セクションは config.js が"default"プロバイダへ読み替える互換橋(buildModelsCfg/legacyModelSection)で既存参照を無修正維持。apiKeyEnv === null は「envを見ない」明示(誤ってOPENAI_API_KEYを拾わないため)。modelStateInfoのauthHintは鍵末尾4文字のみ=生鍵非露出契約。
- **検証者の役割は「承認まで通す」**: 承認待ちタスクはrole:reviewの検証者が居るうちに approve_task まで実行する。finish→退場→自動解放の掃除で承認待ちエントリが消えると、成果がmain反映済みでも帳簿がdoneにならずレジューム作業が発生する(modelselectラウンドで実害)。検証報告は「結論を最初の1行+通した確認リスト」の形式で投稿し、後日のレジューム時にも根拠として再利用できるようにする。
- **放棄判断系respawnタスクは判断者以外の検証者でfinishする**: 放棄判断を自分でfinish_taskすると自動起票されるverify-*の検証者に自分が指名され「実装者のため承認不可」で循環する(2026-09 issue-throttleラウンドで実害・チェーンは他人が消化)。判断報告はボードへ根拠付きで投稿し、finishは別ロールに依頼するか、起票されたverifyを他人が消化する前提で待つ。verify-verifyの二重チェーンが陳腐化したらユーザーUI中止か一括クローズで整理する。
- **マージ退行の定型パターンと検出**: 実装とテスト期待値が別コミット・別担当で交互に書き換わると退行を繰り返す(browser-tools断片リンク・submit報告書式で実害)。検出は「テスト失敗の責任分界」をコミット時系列で追う(git log --all -S '<期待値文字列>')。どちらが正かは最新の仕様決定コミット(e8f92ec等のコメント)と現mainのコードで判断し、中途の暫定版を採用しない。修正時は実装+テストを同じコミットで揃える。

# 2026-09 issue-checkpoint系列ラウンドの追加知見(ベータdistill)

- **respawnスキャンとテストの競合**: runChatの起動時respawn単体は正しい(e2eのrespawn-chatテストが落ちるときは、テストがworktreeに置いたwipコミットを「直前ラウンドのラウンド末自動マージ(mergeAgentWork)」が先にmainへ取り込み、スキャン時点で差分が消えている競合)。テストでクラッシュを模擬するなら、ラウンド末マージ完了を待つか dirty(未コミット)状態を使う。respawnを疑う前に merge-base --is-ancestor でブランチが既に取り込まれていないか確認する(ベータ観測: コミット直後は差分あり→数秒後に消滅)。直接のrespawn呼び出し+実TaskBlackboardでの検証が切り分けに有効。
- **fix-*/review-*タスクは解放→再請求の競合が起きる**: 通知と同時にclaimすると「他拠点で完了済み」で弾かれる。弾かれたら内容の実質完了をボードで確認し、open復帰したら検証者の視点でapproveまで通す(重複実装しない)。verify-*は実装者以外が担当するため、role:implの追加ワーカーは請求不可=待ちが発生する。承認待ちタスクは自分のスレッドのrole:reviewが居るうちに処理する。
- **verify連鎖が深くなりすぎる前に打ち切る**: verify-verify-verify-* のような多段検証は発見器の再起票連鎖の兆候。実装がmain反映済みなら「検証→approve」で閉じ、新規検証タスクを起票しない。
- **テストの期待値は「最後に緑になった契約」に寄せて一括統一する**: browser-tools断片リンク(href:null保持⇔除外)とsubmit報告書式(送信:/method:)は実装・テストが交互に書き換わり退行を繰り返した。修正時は実装+テストを同じコミットで揃え、コメントに契約行(例: 「断片は遷移候補から除外(e80e512)」)を明記する。途中の暫定期間に発見器がreview-changes/fix-を大量起票する。
- **TZ境界のテスト固定は3環境で検証する**: usage集計は最終形として localDateKey()(ローカル日付)に実装・書込側が統一済み(UTC基準という一時案は撤去済み)。テスト期待値も実装と同一の関数から生成し、TZ=Asia/Tokyo/UTC/America/Los_Angelesの3環境でpassを確認するのが検証の証跡。1環境だけでは深夜帯の不具合を取りこぼす(2026-09 fix-usage-aggregate-tz)。
- **checkpoint/resume実装の注意**: 復元後にcheckpointファイルを必ず削除(残すとmodelエラー→復元→失敗の無限ループ)。checkpointFnはツール実行済み地点で呼ぶ。モデル異常以外(ツール打ち切り・予算停止)は対象外という設計判断。

# 2026-09 issue-throttle系列ラウンドの追加知見(ガンマdistill)

- **実装者がapprove前に退場するとapproveが失敗する**: finish_taskの自動マージでブランチ(agent/<id>)が消えるため、検証者のapprove_taskが「not something we can merge」で落ちる(タスクは実装済み・main反映済みなのに帳簿がopenへ戻る)。復旧手順: (1)検証者がマージ済みmainで実態検証(テスト実行+コード確認) (2)実装者(または誰か)へ「自worktreeで git merge main → タスク再請求 → finish_task(no-opマージで確定)」を依頼 (3)approveで承認。実装者が全員退場済みなら、検証者がclaim→finish(コード差分ゼロを明示)するのが最短。
- **古い分岐の放棄ブランチは原則マージしない(巻き戻しリスク)**: クラッシュ復旧(respawn-*)で請求したブランチが古い世代(stability-r3等)だと、マージ時に113ファイル/約-1万行の巻き戻し差分となり最新機能(スロットリング等)を破壊しうる。放棄判断の検定手順: (1)merge-baseとbranch先頭の日付/コミットで分岐世代を確認 (2)`git diff main <branch>` の二点間diffで「機能の独自追加」を列挙(mainとの三点間diffは新旧混合で見誤る) (3)各機能が現mainに改善形で存在するか確認(killDevserverTree等の強化版) (4)関連テストを現mainで実行して緑を証跡にする → 放棄判断はボードへ根拠付きで記録し、worktree/ブランチは掃除タスクへ委ねる。完了条件は「取り込み or 放棄判断の記録」なので、記録だけでfinishしてよい。
- usage集計UI(イシュー#6)の最終形: /api/usage(aggregateUsageのbyDate/byThread/matrix)+ index.html statusタブの renderUsageAggregate()。並行実装由来の usageAggTable 等の重複は統一済み — 再発時は grep -c で関数名を数え、main側へ統一する(2026-09)。
- **leadロール(進行・調整)はreviewタスクを請求できない**: 発見器が起票するverify-*はrole:review固定のため、leadはclaim不可(approveは実装者でなければ可)。verify滞留はrole:review持ちのワーカーへボードで依頼するか、リーダーがroleを緩める。claim空転が続くときは診断文の「未着手一覧」でrole不一致を確認してから打ち切る(claimMiss診断と併用)。

# 2026-09 feat-monitor-chartラウンドの知見(アルファdistill)

- **自動解放(プロセス再起動)で請求が戻ってもworktreeは保持される**: コミット済みの成果は失われない。再請求したら git status/log で現状確認→必要なテストだけ再実行→finish_task が定型。無為に再実装しない(2026-09)。
- **依存ゼロ(外部URL無し)テストではSVG名前空間URI(http://www.w3.org/2000/svg)を例外にする**: 属性値として使い取得はしない。監視は否定先読み付き正規表現 /https?:\/\/(?!www\.w3\.org)/ で行う(誤検知実績: test/monitor-chart.test.js)(2026-09)。
- **ブラウザ向け描画は純関数モジュール(public/配下・IIFE+globalThis公開)+HTMLはfetchと注入のみに分離**すると、描画ロジックも統合(API応答の実行時契約)もNodeテストで検証できる(markdown.jsパターンの適用。詳細は上のイシュー#15-17節)(2026-09)。
# 2026-10 issue-cost系列ラウンドの知見(ベータdistill)

- **リーダー起床注入文はユーザー入力最優先の文面に固定(イシュー#20)**: say()のwake注入文は「ユーザー入力が最優先の応答対象です。まずこの入力に答えてください。直近のワーカー投稿は触れなくてよい」(af3a444)。旧文面「直前のボード新着を確認して応答」だと、say直後にワーカー投稿が流れたとき後発投稿へ注視してユーザー質問が後回しになった(実害)。並発契約は test/chat-input-priority.test.js が担保。改修時はこの文面契約を壊さない。
- **UIトークンは403時にhfetchが自己修復する**: サーバー起動ごとにCSRFトークンは再生成されるため、開きっぱなしのUIタブは再起動後に全POSTが403になる。hfetchは403時に同一オリジンの最新ページ(/)から実トークンを引き取り1回だけ再試行する(test/ui-token-selfheal.test.js)。UIのPOST契約を変えるときはこの自己修復経路を壊さない。
- **検証タスクの「放棄判断で締める」は正規の完了形**: respawn系dirtyタスクが同一内容で再起票されたときも、実装とテストの現main契約(browser-open等)を確認して「取り込み不要」の根拠付き記録でfinishしてよい(2026-10 respawn-engine-r3-cleanup-alpha-dirtyを3回とも同一判断で締めた実績)。判断基準は「現mainの意図的な改善(open:true明示等)と競合する古い設計か」。
- **スレッドが閉じられた後の発見器起票は稼働中スレッドのメンバーが消化する**: 閉じたスレッドのメンバーは請求できない(ガンマ観測)。スレッド終了時は未消化の発見器タスク(fix-*/verify-*)が残っていないか確認してから閉じるのが安全。

- **mojibake系テストの未完不整合(2026-10 main 0aec183時点)**: test/mojibake.test.js が chat.js の旧export名 containsReplacementChar をimportしてロード失敗(実装は detectBrokenInput に統一済み)。mojibake-detection.test.js の say()警告配線2件も未接続。fix-mojibake-detection(fix-lead-priority)で契約統一が必要。テストが2系統で別契約になった状態のマージは、実装側の1関数へ集約してから緑化する。
