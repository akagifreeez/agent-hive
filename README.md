# agent-hive

複数エージェントが**同一ワークスペースで同時に作業**し、**共有ボードで横につながり**ながらコーディングするハーネス。単一エージェントでは起きない「見逃し」を、実装→レビュー→修正→独立再検証の複数視点で拾うために作る。

最終更新: 2026-09-25。現況: v2実装済み(仕事の自動発見+承認制ゲート)。実走デモ2回達成(v1: 実装→レビュー→修正→総括 / v2: diff自動検出→レビュー→チェックポイントコミット→再レビューで差分ゼロ確認)。テスト11件通過。

## 設計の核: Gitリポジトリ=blackboard

- `workspace/tasks/open/*.md` に仕事(Issue相当)がファイルで転がる
- エージェントは `claim_next_task` で**自分で仕事を発見して請求**する。請求はファイルのrename(open→claimed)で、同一ボリュームのrenameは原子的なので**二重請求が構造的に起きない**
- 完了は `finish_task`(claimed→done)。成果物はワークスペース内のファイルとして残る
- 報告・指摘・質問は共有ボードへ。**他エージェントの投稿は各ループに「ボード新着」として注入**され、次の判断の材料になる
- **発見器(discovery)がblackboardに仕事を自動投入する(v2)**:
  - テストプローブ: `discovery.testCommand` を定期実行し、失敗→`fix-test-failures`タスク生成(失敗出力を本文に添付)/復旧→自動解決(doneへ移動して「自動解決」を記録)
  - diffプローブ: `git status`に変化→`review-changes`タスク生成(role: review)。レビュー完了(finish_task)で**チェックポイントコミット**が打たれ、次のdiffの起点がリセットされる
  - ラン終了時は「コミット→最終プローブ」の順で、テスト失敗だけはあえてopenタスクとして残す(次回ランへの仕事の受け渡し)

## アーキテクチャ

```
src/
├─ engine/loop.js    エージェントループ(model→tools→…、ボード新着の注入、
│                    未完了請求へのナッジ、空応答の継続処理)
├─ engine/tools.js   9ツール: claim/finish_task, read/write/edit_file,
│                    list_files, bash(ゲート通過後Git Bashで実行),
│                    post_to_board, wait_for_board
│                    ※ファイル系はワークスペース配下に閉じ込め(パス検証)
├─ engine/board.js   共有ボード+待機(waiter)+イベントバス
├─ engine/tasks.js   タスクblackboard(open/claimed/doneのrename管理+イベント発行)
├─ engine/discover.js 発見器: テスト失敗→タスク化/復旧→自動解決、
│                    diff→レビュータスク化、チェックポイントコミット
├─ engine/permissions.js 承認制ゲート(deny即拒否/askはUI承認・タイムアウト拒否)
├─ engine/exec.js    シェル実行の共用層(WindowsはGit Bash自動検出)
├─ model/openai.js   OpenAI互換アダプタ(GLM等。依存ゼロ)
├─ runner.js         シナリオ実行器(git blackboard化→同時走行→最終プローブ)
├─ ui/server.js      localhost UI(node:http+SSE。依存ゼロ。承認ボタン込み)
└─ ui/public/        ボード/エージェント状態/タスク/承認要求/ファイルビューア
```

モデルは [OpenRouter](https://openrouter.ai) のGLMで実証(既定 `z-ai/glm-5.3-flash`)。キーは環境変数 `OPENROUTER_API_KEY` か `hive.config.json` の `apiKeyFile`。

## 使い方

```
npm test        # エンジンのテスト(モックモデル)
npm run run     # ヘッドレス実行: シナリオ→ボードの流れをコンソールへ
npm start       # UI付き: http://localhost:7789 (シナリオ自動開始)
```

エージェントの追加: `hive.config.json` の `agents` に `{id, displayName, role, persona}` を足し、`agents/<id>.md` に人格を書く。仕事の追加は `scenario.tasks` へ。ロールが一致するタスクを優先請求する。

## 実証済みのこと(実走)

**v1(2026-09-24)**: wordcount CLIシナリオ。実装→レビュー(実バグ1件を「箇所+原因+修正案+検証済み」で指摘)→修正→独立再検証→総括、全タスクdone。

**v2(2026-09-25)**: counter CLIシナリオ(テストをシードとして先に置き、テストが仕様書)。ここに発見器の全ライフサイクルが実走で乗った:

1. アルファが実装+5/5テスト通過を報告
2. **diffプローブが自動で`review-changes`タスクを生成**→ベータが請求し、動かして検証(複数インスタンス独立性/100万回操作/カプセル化)して「問題なし」→ **finish_taskでチェックポイントコミット自動打ち**
3. ガンマが自分でもテスト再実行して総括。改善提案(戻り値契約のテスト追加等)はアルファが自主対応(6/6まで拡張)
4. 追加変更で再生成された2回目の`review-changes`で、ベータが**「差分ゼロ(チェックポイント済み)」を確認してクローズ**——diff→レビュー→コミット→次のdiffの循環が閉じた

なお初回v2ランでは`node --test tests/`(ディレクトリ指定)がこの環境で失敗するためプローブが偽失敗を出し、fixタスクが生成される事故が起きた。エージェント自身が原因を突き止めており、プローブコマンドをグロブ指定に修正済み。**「テストコマンドは環境依存で壊れる」の実例として、発見器のタスク本文には必ず失敗出力を添付している**(これによりエージェントが自律で切り分けられた)。

## 既知の実装メモ(GLM/OpenRouter特有)

- tool_callsを含むassistantメッセージは `content: null` 不可(空文字へ正規化)
- ツール結果メッセージのcontentは**文字列**でなければならない(配列を渡すと `content[0] must be an object` の400)
- 推論モデルなので思考トークンで `max_tokens` を消費する。空応答が続く場合は上限を上げる
- Windowsではモデルが自然にPOSIXコマンドを書くため、bashツールはGit Bashを自動検出して使う

## ロードマップ

- **v2(完了): 仕事の自動発見**。テスト失敗→タスク自動生成+自動解決、diff→レビュータスク化+チェックポイントコミット。承認制ゲート(deny/ask+UI承認フロー)
- **v3: 作業の隔離**。エージェント別git worktree+マージで、同一ファイルの同時変更にも対応
- **v4: デスクトップ化**。UI層は依存ゼロのlocalhost Web UIなので、Electron殻で包むだけの構成
- **v5: Discord等の外部表面**。`_projects/discord-agents/` で実装済みのTransportを、このハーネスの出力先として接続(Discordは手段の一つに降格)

## 安全設計

- ファイル系ツールはワークスペース配下のみ(パス検証でworkspace外を拒否)
- **bashは承認制ゲートを通る(v2)**: `permissions.deny`パターンは即拒否、`ask`パターンはUIの承認ボタン待ち(既定120秒でタイムアウト拒否)。`--run`無人実行では実質すべてのaskコマンドが拒否される(止まられない経路に承認能力を置かない)
- ループの暴走止め: maxTurns / 全体タイムアウト / 空応答連続の打ち切り
