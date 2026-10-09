# turn-limit到達時の宙吊り防止導線 — 進捗メモ(ガンマ impl-35)

タスク: turn-limit-task-boundary(project: self-improve-lab-lessons)

## 調査で分かったこと(実装方針の根拠)

現状のturn-limit到達時の流れ:
1. `src/engine/loop.js` の `runAgentLoop` — for文が maxTurns を使い切ると
   `bus.emit("agent.status", {...status: "turn-limit"})` して
   `{ ok:false, endedBy:"turn-limit" }` を返すだけ。
   **この時点では請求中タスクの解放も報告も無い**(宙吊りの本質)。
2. その後の面倒はホスト側に分散:
   - `src/engine/spawn.js` L170-181: turn-limitなら継続プロンプトを注入して1回だけ
     runAgentLoopを再実行。それでも turn-limit/budget/error なら `tasks.release()`。
     → サブエージェント(spawn)経路は **既にrelease救済がある**。
   - `src/engine/chat.js` L407付近: 常駐chat(main/リーダー)は turn-limit でも
     進捗ゲート(着地あり)を満たせば自動継続ラウンドを起こす。
     **リリースはしない**(=継続前提なのでむしろ解放しないのが正しい)。
3. `loop.js` 内の他の終了経路は全て `releaseClaims(reason)` を呼んでから抜ける
   (予算停止/モデルエラー/ツール失敗連続/idle/コンテキスト圧縮限界)。
   **turn-limitだけreleaseClaimsしていない** — ここが非対称で、これが実装修正点。

## 実装方針(決定)

選択肢: (a)タスク単位ターン予算リセット (b)turn-limit到達時の導線。
→ **(b) を loop.js 側に入れる**(最小差分・影響範囲が明確)。

- loop.jsのforを抜けた直後(turn-limitリターンの直前)に:
  - `tasks.claimedBy(agent.id)` が空なら何もしない(現行どおり)。
  - あれば:
    1. ボードへ `[ターン上限]` 報告(どのタスクが宙吊りになりかけたか明記)
    2. `releaseClaims("ターン上限")` で open へ戻す(次ラウンド/他ワーカーが請求可能に)
- spawn.jsの継続1回の仕組みと整合: spawnは「継続プロンプトを注入して再実行」するが、
  1回目のturn-limitでloop.js側がreleaseすると、継続2回目はタスク無しで走る。
  最終状態は現行と同じ(継続不能ならspawn側がrelease)。差分:
    - 現行: 継続2回目でモデルが finish_task できる(タスクはclaimedのまま)
    - 改変後: 継続2回目の開始時点でタスクはopenへ戻っている。モデルが再度claim
      するか、他ワーカーが拾う。
  → spawn側の継続プロンプト(spawn.js L172)に「タスクがopenへ戻っていたら
  再請求してください」を追記して再claimを促す。
- chat.js(常駐リーダー)側: 自動継続が進捗ゲート付きで回る。リーダーの
  キックオフ文言は「請求中タスクが残っていれば finish_task…無ければ claim_next_task」
  で再claim導線は既にある。問題なし。

## テスト計画(受け入れ基準を満たす)

新規 `test/turn-limit-boundary.test.js`:
1. **blog lab実例の再現**: モデルスタブが「タスクA請求中にmaxTurns消費」
   (toolCalls連打→contentで終了)し、タスクAがclaimedのままturn-limit到達。
   検証: (i)終了後にタスクAがopenへ戻っている(他者が請求可能)
   (ii)`[ターン上限]` 報告がボードへ出ている。
2. **請求中タスクが無いturn-limitは従来どおり**: releaseも報告も無い(ノイズ防止)。
3. ついでに、release後のタスクが他エージェントからclaimできること
   (宙吊り解消の実効確認)。

## 完了条件
- 上記テストが緑
- npm test 全緑
- 依存ゼロ(新規テストファイル+loop.js/spawn.jsの小修正のみ)
