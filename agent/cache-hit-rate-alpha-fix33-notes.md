# fix-33-usage-double-count 作業メモ(cache-hit-rate-alpha worktree)

## 現状把握(完了)
- 発生源: src/engine/chat.js:358付近 — usage.round に `totals: this.ledger.agent(main.id)`(セッション累積)を乗せている。
- 集計: src/engine/usage.js `aggregateUsage` は各レコードの totals を加算 → 2ラウンド各$0.1が 3 calls/$0.3 になる(正しくは 2 calls/$0.2)。
- 累積の消費者(壊してはいけない):
  1. src/ui/server.js:145-155 予算アラート — `p.totals.costUsd` を累積として比較・state配布(budgetState.costUsd)
  2. src/ui/server.js:329 persistUsage — usage.json へ {at, agent, thread, endedBy, totals} を蓄積(直近200件)
  3. test/budget-alert.test.js — totals.costUsd の累積契約を固定(0.4→1.4→2.9)

## 設計判断(決定)
- **usage.round のemit側で delta を付与する**。
  - runAgentLoop の戻り値 r に `r.usage`(このランの消費)を追加する(loop.js)。
  - chat.js は totals(累積・既存契約維持)と delta(ラウンド単位・新規)を両方乗せる。
  - aggregateUsage は `h.delta ?? h.totals` を加算対象にする(旧形式=delta無しは従来どおりtotals加算で互換維持)。
- 旧履歴(usage.jsonの既存レコード)はdelta無し → 現行どおりtotals加算。データ移行不要。
- 再起動: ledgerはメモリ内でセッション単位 → 再起動後の1ラウンド目のtotalsは小さくなるが、delta側は正しい。aggregateはdelta優先なので再起動でも二重計上しない。

## 実装手順
1. loop.js: 各returnポイントの戻り値に `usage: runUsage()` を足す(ラン内で収集したprompt/completion/reasoning/cost/calls)。runTokensを拡張するのではなくusageオブジェクトを別途積む。ledger.add済みのターンusageを順に足す(230行目付近と373行目付近=autocompactの2箇所)。
2. chat.js: usage.roundのpayloadに `delta: r.usage ?? null` を追加。
3. usage.js aggregateUsage: 加算元を `const t = h.delta ?? h.totals ?? {}` に変更。ただしdeltaフィールド名は採用時のschema-guard/JSDoc契約を確認。
4. テスト: test/usage-round-delta.test.js 新規
   - 実ChatHost+UsageLedgerで2ラウンド走らせ、usage.roundイベント2回のdelta合計=2 calls/$0.2、aggregateUsageがbyThread[main]=2 calls/$0.2。
   - 旧形式(delta無し・totalsのみ)の履歴は従来どおり集計される。
   - 予算アラート: totals契約は維持(budget-alert.test.jsがそのまま通ること)。

## 注意(記憶の教訓)
- CRLF注意: 編集は write_file/edit_file でLF化してから(本メモ作成済み、loop.js等はLFへ正規化を試みたがgitがCRLFで戻すため実質影響なし=diff 0)。
- 進捗はこのメモを随時更新してから終わること(ラウンド中断に備える)。

## 状態
- [x] 調査
- [ ] loop.js 実装
- [ ] chat.js 実装
- [ ] usage.js 実装
- [ ] テスト新規
- [ ] npm test 全緑
