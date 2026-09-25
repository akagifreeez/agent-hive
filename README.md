# agent-hive

複数エージェントが**同一ワークスペースで同時に作業**し、**共有ボードで横につながり**ながらコーディングするハーネス。単一エージェントでは起きない「見逃し」を、実装→レビュー→修正→独立再検証の複数視点で拾うために作る。

最終更新: 2026-09-24。現況: エンジン+UI実装済み。実走デモ(実装→レビュー→修正→総括、全タスクdone)達成。テスト6件通過。

## 設計の核: Gitリポジトリ=blackboard

- `workspace/tasks/open/*.md` に仕事(Issue相当)がファイルで転がる
- エージェントは `claim_next_task` で**自分で仕事を発見して請求**する。請求はファイルのrename(open→claimed)で、同一ボリュームのrenameは原子的なので**二重請求が構造的に起きない**
- 完了は `finish_task`(claimed→done)。成果物はワークスペース内のファイルとして残る
- 報告・指摘・質問は共有ボードへ。**他エージェントの投稿は各ループに「ボード新着」として注入**され、次の判断の材料になる
- テスト失敗・diffからの仕事自動生成はv2(下記ロードマップ)

## アーキテクチャ

```
src/
├─ engine/loop.js    エージェントループ(model→tools→…、ボード新着の注入、
│                    未完了請求へのナッジ、空応答の継続処理)
├─ engine/tools.js   9ツール: claim/finish_task, read/write/edit_file,
│                    list_files, bash(WindowsならGit Bash自動検出),
│                    post_to_board, wait_for_board
│                    ※ファイル系はワークスペース配下に閉じ込め(パス検証)
├─ engine/board.js   共有ボード+待機(waiter)+イベントバス
├─ engine/tasks.js   タスクblackboard(open/claimed/doneのrename管理)
├─ model/openai.js   OpenAI互換アダプタ(GLM等。依存ゼロ)
├─ runner.js         シナリオ実行器(タスク投入→全エージェント同時走行→回収)
├─ ui/server.js      localhost UI(node:http+SSE。依存ゼロ)
└─ ui/public/        ボード/エージェント状態/タスク/ファイルビューア
```

モデルは [OpenRouter](https://openrouter.ai) のGLMで実証(既定 `z-ai/glm-5.3-flash`)。キーは環境変数 `OPENROUTER_API_KEY` か `hive.config.json` の `apiKeyFile`。

## 使い方

```
npm test        # エンジンのテスト(モックモデル)
npm run run     # ヘッドレス実行: シナリオ→ボードの流れをコンソールへ
npm start       # UI付き: http://localhost:7789 (シナリオ自動開始)
```

エージェントの追加: `hive.config.json` の `agents` に `{id, displayName, role, persona}` を足し、`agents/<id>.md` に人格を書く。仕事の追加は `scenario.tasks` へ。ロールが一致するタスクを優先請求する。

## 実証済みのこと(2026-09-24 実走)

GLM-5.3-flash × 3エージェントでwordcount CLIシナリオを完走:

1. アルファ(impl)が実装+セルフテスト9件、実行結果付きで報告
2. ベータ(review)が**自分で動かして**11項目を検証。実際のバグ1件を「箇所+原因+修正案+動作確認済み」で指摘
3. アルファが指摘に対応して修正+再検証し報告
4. ガンマ(lead)が**自分でも修正版を動かして独立再検証**し、全体まとめと完了判断

単一エージェントでは生まれない「レビュー→指摘→修正→第三者検証」がボード経由で自然に発生した。

## 既知の実装メモ(GLM/OpenRouter特有)

- tool_callsを含むassistantメッセージは `content: null` 不可(空文字へ正規化)
- ツール結果メッセージのcontentは**文字列**でなければならない(配列を渡すと `content[0] must be an object` の400)
- 推論モデルなので思考トークンで `max_tokens` を消費する。空応答が続く場合は上限を上げる
- Windowsではモデルが自然にPOSIXコマンドを書くため、bashツールはGit Bashを自動検出して使う

## ロードマップ

- **v2: 仕事の自動発見**。テスト実行を定期化し、失敗→`tasks/open/`へタスク自動生成。diff検出→レビュータスク化(「Gitリポジトリ自体がblackboard」の完成)
- **v3: 作業の隔離**。エージェント別git worktree+マージで、同一ファイルの同時変更にも対応
- **v4: デスクトップ化**。UI層は依存ゼロのlocalhost Web UIなので、Electron殻で包むだけの構成
- **v5: Discord等の外部表面**。`_projects/discord-agents/` で実装済みのTransportを、このハーネスの出力先として接続(Discordは手段の一つに降格)

## 安全設計

- ファイル系ツールはワークスペース配下のみ(パス検証でworkspace外を拒否)
- bashはワークスペースをcwdにするが、マシン上で自由にコマンドが走る。承認制ゲート(破壊的操作の確認)はv2で追加予定。**それまでは信頼できるタスクのみで使うこと**
- ループの暴走止め: maxTurns / 全体タイムアウト / 空応答連続の打ち切り
