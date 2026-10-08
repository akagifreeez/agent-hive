# agent-hive

マルチエージェント常駐ハーネス — Electronの殻 + 依存ゼロのNodeコア。
Multiple resident agents (a leader, per-thread workers, and autoscaled extras) that share one blackboard board, work in isolated git worktrees, and merge their own work back — with a discovery loop that turns test failures, unreviewed diffs, and finished tasks into the next work items automatically.

## これは何

1体のリーダーと、スレッドごとのワーカー群が**同じワークスペースで同時にコーディングする**ハーネスです。単一エージェントでは起きない見逃しを、実装→レビュー→修正→独立再検証の複数視点で拾うことを目的にします。

- 指示はチャットUIから送る。リーダーが計画に分解し、スレッド(取り組み)ごとにワーカーを編成する
- エージェント間の連携は**共有ボード(blackboard)とタスクキューのみ**。秘密チャネルは物理的に存在しない
- 各エージェントは**専用git worktree**で作業し、完了時にmainへ自動マージ(直列化+競合時の自動再試行付き)
- **発見器**が常時3つのプローブを回す: テスト失敗→修正タスク / 未レビューdiff→レビュータスク / 完了タスク→知見の蒸留(永続記憶への抽出)

コアは**ランタイム依存ゼロ**(node:http + SSEのみ)。テストも`node --test`で直接走ります。これはLLMエージェントが自分自身のコードを編集して改良していく「自己改善ループ」を回すために、編集→実行→検証の摩擦を最小にする設計判断です。

<!-- auto:cli-commands start -->
```
node bin/hive.js status            稼働状態(モデル/タスク/スレッド/エージェント)を一覧
node bin/hive.js threads           スレッド一覧(フォルダ・停止中表示つき)
node bin/hive.js say <テキスト>        メインチャットへ発言(--thread でスレッド指定)
node bin/hive.js board [-n 件数]     最近のボード投稿を見る(既定30件)
node bin/hive.js watch             ボードの新着をリアルタイムで流し見(Ctrl+Cで終了)
node bin/hive.js chat [--thread 名前]  対話モード。入力した行がそのまま発言になる
node bin/hive.js feedback <taskId> <コメント>  マージ済み差分への修正依頼を送る
node bin/hive.js pause <スレッド> / resume <スレッド>  スレッドの一時停止/再開
node bin/hive.js audit             監査台帳(state/audit.jsonl)の直近記録を見る(-n 件数、既定30)
node bin/hive.js notify            通知(承認待ち/マージ/長時間タスク完了)の最新を監視から見る
node bin/hive.js usage             トークン消費の直近サマリ
```
<!-- auto:cli-commands end -->

## アーキテクチャ

```
ユーザー(チャットUI/CLI)
  │
リーダー(常駐) ── スレッド = 取り組みごとの部屋(ボード+ワーカー3体)
  │                                    ├─ 追加ワーカー(未着手タスク数から自動増員、早期退場)
  ├─ タスクblackboard(tasks/{open,claimed,done}のMarkdown。claimは原子的rename)
  ├─ 発見器(テストプローブ / diffプローブ / 記憶プローブ)
  └─ 共有ボード(JSONL永続化・ディスク索引型の頁送り)
```

- **1ラン = 有限ターンの応答**。ターン上限でも仕事が残っていれば自動継続し、請求ミスが続けばidle退場する(トークンの無駄を構造で止める)
- **コンテキスト管理**: microcompact(古いツール結果の置換、LLM不要)+ autocompact(構造化要約)+ rapid-refillブレーカー。永続記憶(workspace/memory/)は権威ファイルとして毎ラウンド注入され、要約には複製されない(権威分離)
- **ツール失敗の連続は打ち切り**: 失敗文面は次の一手を教える教師として設計。同じ入力の連続呼び出しは暴走検知が割り込む

## セーフティ

- 権限モード(normal=要承認 / auto)+ 破壊的コマンドのパターン拒否 + 承認要求のデスクトップ通知
- 停止系通知: 自動継続停止・ツール失敗停止・予算停止と全エージェント無音の「ラウンド静止」(既定10分、1回だけ)をCLI通知へ配信。`hive.config.json` の `notify.stop: false` で止める(`notify.stallSec` で静止閾値秒を変更)
- **PC操作制限8か条**を全エージェントのシステムプロンプトへ常時注入(最小権限/state/への接触禁止/外部送信禁止など)
- state/へのエージェント書き込みは`safeWritePath`で構造的に拒否(シンボリックリンクや大小文字の回避も含め`test/state-guard.test.js`で検証)
- 監査台帳(`state/audit.jsonl`): 全ツール実行をagent/tool/所要ms/応答brief付きで記録(5MBローテート)
- UI/CLIのPOSTはCSRFトークン必須+ローカルオリジン制限。APIキーは画面に出さず末尾4桁のみ表示

## はじめ方

### ビルド済みexe(Windows)

[Releases](../../releases) から`agent-hive Setup *.exe`(インストーラ)または`agent-hive *.exe`(ポータブル)を入手。初回起動後に設定ウィンドウからモデルAPIキーを保存してください(OpenAI互換エンドポイント。GLM / OpenRouter / OpenAIなど)。

### ソースから

```bash
git clone https://github.com/akagifreeez/agent-hive.git
cd agent-hive
npm install
npm run desktop        # デスクトップアプリ(トレイ常駐)
# または
npm start              # ブラウザUIのみ(http://localhost:7789)
```

要件: Node 24+。デスクトップUIには同梱のElectronを使用。

### 設定

- `hive.config.json` の `models` セクション: モデル接続をプロバイダ単位で定義する(複数契約に対応。`api` はワイヤ形式= `openai-completions`(OpenAI互換・GLM/OpenRouter等)/ `anthropic-messages`(Claude。API key と setup-token sk-ant-oat01- の両方を鍵値のプレフィックスで自動判別)/ `openai-chatgpt-responses`(ChatGPT Plus/Pro。Codex OAuth で認証))。`default` は `provider/model` 形の既定モデル、`fallbacks` は終端エラー時の代替列。auth は `env`(環境変数)/`file`(鍵ファイル)/`value`(直値)のいずれか。設定UIの「モデルと接続」から鍵保存・OAuth認証・疎通テストができる:

  ```json
  "models": {
    "default": "zai/glm-5.3-flash",
    "fallbacks": [],
    "providers": {
      "zai": {
        "baseUrl": "https://api.z.ai/api/coding/paas/v4",
        "api": "openai-completions",
        "auth": { "env": "ZAI_API_KEY", "file": "../../zai.key" },
        "params": { "temperature": 0.7, "maxTokens": 4000, "timeoutMs": 180000, "reasoningEffort": "low", "webSearch": true },
        "models": [
          { "id": "glm-5.3-flash", "name": "GLM-5.3-Flash", "reasoning": true, "contextWindow": 200000, "maxTokens": 4000 }
        ]
      }
    }
  }
  ```

  旧来の `model` セクション(baseUrl/apiKeyEnv/apiKeyFile)も引き続き有効で、自動で `default` プロバイダに読み替えられる。`params.webSearch: true` でZ.AIのサーバー側web検索を有効化(GLM Coding Planで使える内蔵ツール。検索結果の注入ぶんpromptトークンが増えるため、`agents[].webSearch` でエージェント別に上書き可)
- `hive.local.json`: ワークスペース位置などのローカル上書き(git除外対象)
- ポート: UI=7789 / モニタ=7791。`HIVE_UI_PORT` / `HIVE_MONITOR_PORT` 環境変数で変更
- ワークスペース: 既定はリポジトリ直下。梱包実行時はuserData配下(`HIVE_DATA`で上書き)

### CLI(稼働中のhiveを端末から操作・依存ゼロ)

```
node bin/hive.js status            # 稼働状態(モデル/タスク/スレッド/直近マージ)
node bin/hive.js say "指示"        # メインチャットへ発言(--thread で宛先指定)
node bin/hive.js watch | chat      # ボードの流し見 / 対話モード
node bin/hive.js tasks | threads | usage | audit
node bin/hive.js pause <スレッド> / resume <スレッド>   # トークン消費ゼロで休む
node bin/hive.js feedback <taskId> <コメント>          # マージ済み差分への修正依頼
```

### 自動再起動ウォッチドッグ(Windows・任意)

hiveプロセスが死んだときに自動で再起動する監視スクリプト(`scripts/watchdog.mjs`)を同梱しています。
再起動は**ユーザーがONにしているときだけ**動きます(marker: `state/watchdog-on`。UIからは `watchdog_toggle` ツール、CLIからは `node scripts/watchdog.mjs on|off|status` で切替)。

Windowsタスクスケジューラへの**ユーザーレベル登録**手順(管理者権限不要):

```bat
rem 登録
schtasks /create /tn "agent-hive-watchdog" /tr "node C:\path\to\agent-hive\scripts\watchdog.mjs" /sc minute /mo 1 /f
rem 解除
schtasks /delete /tn "agent-hive-watchdog" /f
```

- 疎通先はUIポート(`HIVE_UI_PORT`環境変数、既定7789)の `/api/state`。稼働中なら何もしない
- ダウン + marker有り のときだけ `node src/index.js --chat` をデタッチ起動し、`state/watchdog.log` へ1行JSONで記録
- タスクスケジューラが使えない環境は `node scripts/watchdog.mjs --loop`(常駐・60秒間隔)で代替可
- 実登録はシステム設定変更に当たるため**自動では行いません**。上記コマンドをユーザー自身が実行してください



## 開発

```bash
npm test             # 全テスト(node --test。ランタイム依存ゼロなので直接実行できる)
npm run typecheck    # JSDoc契約の静的検査(tsc --checkJs。noEmit)
npm run desktop:dist # インストーラ+ポータブルexeのビルド
npm run desktop:smoke # 梱包・起動の疎通確認
```

型はランタイムのためではなく**契約の検査**のために使っています。ボード投稿(Post)/タスク(TaskInfo)/設定(HiveConfig)/ツール結果(ToolResult)/ループオプション(RunAgentLoopOptions)のコア契約にJSDoc typedefを置き、`tsc --checkJs`で逸脱を検出します(実行はJSのまま)。

### リポジトリ構成

```
src/engine/   コア(ボード/タスク/worktree/ループ/発見器/記憶/権限/MCP/監査)
src/ui/       HTTPサーバー+ブラウザUI(依存ゼロ)
src/desktop/  Electron殻(トレイ常駐・通知・梱包時のデータ分離)
bin/hive.js   CLI
agents/       エージェントのペルソナ
docs/         設計ノート・監査レポート(redteam結果含む)
```

<!-- auto:repo-layout start -->
```
src/engine/ コア(ボード/タスク/worktree/ループ/発見器/記憶/権限/MCP/監査)
src/ui/ HTTPサーバー+ブラウザUI(依存ゼロ)
src/desktop/ Electron殻(トレイ常駐・通知・梱包時のデータ分離)
bin/ CLI
agents/ エージェントのペルソナ
docs/ 設計ノート・監査レポート(redteam結果含む)
scripts/ 補助スクリプト(doctor/e2e等)
test/ テスト(node --test)
```
<!-- auto:repo-layout end -->

## 設計ノート

- **なぜ依存ゼロJSか**: エージェントが自分のコードを編集→即実行→即検証するループでは、ビルド工程は摩擦そのもの。ランタイムの単純さを優先し、契約検査は開発時のtypecheckに分離しています
- **なぜblackboardか**: 親子の秘密チャネルを作らない。報告は全員に見えるので、レビューと横の助け合いが構造として発生する
- **なぜworktreeか**: 並行作業の分離をgitに任せる。取り込みは直列化し、競合は1回だけ自動再試行、それでも競合すれば作業者に返す

## ドキュメント

- [docs/feature-reference.md](docs/feature-reference.md) — 他プロジェクトから採用した機能の対応表
- [docs/ui-plan.md](docs/ui-plan.md) — UIの設計言語(絵文字なし・黒灰+オレンジ・面の3層)と実装計画
- [docs/audit-security-2026-09-27.md](docs/audit-security-2026-09-27.md) ほか — 敵対レビュー(redteam)の結果記録
