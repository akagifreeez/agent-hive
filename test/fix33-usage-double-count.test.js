// タスク fix-33-usage-double-count: usage.roundの二重計上(イシュー#33)修正の受け入れ検証
// 実ChatHostで2ラウンド回し、usage.roundペイロード(delta/totals)とaggregateUsage結果を確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";
import { UsageLedger } from "../src/engine/usage.js";
import { aggregateUsage } from "../src/engine/usage.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-fix33-"));
}
function rmTree(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ }
}

// 即答する固定応答モデル(ツール呼出なし=ラウンドは1ターンで終わる)
function scriptedModel() {
  return {
    maxTokens: 100,
    async chat() {
      return { content: "ok", toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.25 } };
    },
  };
}

async function waitUntil(fn, ms = 60000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

test("fix-33: 実ChatHostの2ラウンド(各$0.25)がusage.jsonで2 calls/$0.5に集計される", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const rounds = [];
  bus.on("usage.round", (p) => rounds.push(p));
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  const ledger = new UsageLedger();
  const host = new ChatHost({
    mains: [{ id: "main", displayName: "メイン", role: "lead", personaText: "# M" }],
    project: "fix33",
    autoContinueRounds: 0,
    staggerMs: 0,
    modelFactory: () => scriptedModel(),
    toolsFactory: (agent) => createTools({ agent, workspace: ws, mainWorkspace: null, board, tasks, bus }),
    board, tasks, bus, ledger,
  });
  try {
    // ラウンド1
    host.say("[テスト] ラウンド1");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("main");
      return st && !st.running;
    }), "ラウンド1が完了");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rounds.length, 1, "usage.roundが1回発火");
    // ラウンド2(同じ台帳を続けて使う: 累積は2calls/$0.5になる)
    host.say("[テスト] ラウンド2");
    assert.ok(await waitUntil(() => {
      const st = host.roundState.get("main");
      return st && !st.running && rounds.length >= 2;
    }), "ラウンド2が完了");
    await new Promise((r) => setTimeout(r, 100));

    // ペイロード検証: totalsは累積(2/$0.5)、deltaはラウンド差分(1/$0.25)
    assert.equal(rounds[1].totals?.calls, 2, "totalsはセッション累積(2calls)");
    assert.ok(Math.abs((rounds[1].totals?.costUsd ?? 0) - 0.5) < 1e-9, "totals.costUsdは累積$0.5");
    assert.equal(rounds[1].delta?.calls, 1, "deltaはラウンド差分(1call)");
    assert.ok(Math.abs((rounds[1].delta?.costUsd ?? 0) - 0.25) < 1e-9, "delta.costUsdはラウンド差分$0.25");

    // aggregateUsageがdeltaを集計すれば 2 calls / $0.5 になる(旧コードではtotals加算で4/$1.0に二重計上)
    const r = aggregateUsage(rounds.map((p) => ({ at: new Date().toISOString(), agent: p.agent, thread: p.thread ?? "__main__", delta: p.delta, totals: p.totals })));
    assert.equal(r.byDate[0]?.calls, 2, "集計は2calls(deltaベース。totals加算の二重計上ではない)");
    assert.ok(Math.abs((r.byDate[0]?.costUsd ?? 0) - 0.5) < 1e-9, "集計は$0.5");

    // 永続化経路: server.jsのpersistUsageがdeltaをusage.jsonへ書く形式も集計できること
    // (UIサーバー実駆動はtest/usage-aggregate.test.js側で既有の方式を踏襲。ここでは集計+ペイロード契約を固定)
    const persisted = rounds.map((p) => ({ at: new Date().toISOString(), date: null, agent: p.agent, thread: p.thread ?? "__main__", endedBy: p.endedBy ?? "ok", totals: p.totals ?? null, delta: p.delta ?? null }));
    const r2 = aggregateUsage(persisted);
    assert.equal(r2.byDate[0]?.calls, 2, "永続化想定レコードでも2calls");
    console.log("rounds:", JSON.stringify(rounds, null, 0).slice(0, 400));
    console.log("aggregate byDate:", JSON.stringify(r.byDate));
    console.log("FIX33_OK");
  } finally {
    rmTree(ws);
  }
});

test("fix-33: UsageLedger.lastSnapshotDeltaの契約(初回=全量/以後=差分/リセットで全量)", () => {
  const led = new UsageLedger();
  led.add("a", { promptTokens: 10, completionTokens: 5, costUsd: 0.25 });
  led.add("a", { promptTokens: 10, completionTokens: 5, costUsd: 0.25 });
  const snap = led.lastSnapshotDelta("a");
  assert.deepEqual(snap.totals, { calls: 2, promptTokens: 20, completionTokens: 10, reasoningTokens: 0, costUsd: 0.5, msSum: 0, avgTokPerSec: null }, "totalsは現累積(呼2回分)");
  assert.deepEqual(snap.delta, { calls: 2, promptTokens: 20, completionTokens: 10, reasoningTokens: 0, costUsd: 0.5, msSum: 0, avgTokPerSec: null }, "初回のdeltaは全量");
  const snapAgain = led.lastSnapshotDelta("a");
  assert.equal(snapAgain.delta.calls, 0, "累積が動いていない再呼び出しのdeltaは全項目0");
  led.add("a", { promptTokens: 10, completionTokens: 5, costUsd: 0.25 });
  const snap2 = led.lastSnapshotDelta("a");
  assert.deepEqual(snap2.totals, { calls: 3, promptTokens: 30, completionTokens: 15, reasoningTokens: 0, costUsd: 0.75, msSum: 0, avgTokPerSec: null }, "累積は3calls");
  assert.deepEqual(snap2.delta, { calls: 1, promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.25, msSum: 0, avgTokPerSec: null }, "2回目のdeltaは差分1call");
  led.resetSnapshotDelta("a");
  const snap3 = led.lastSnapshotDelta("a");
  assert.deepEqual(snap3.delta, { calls: 3, promptTokens: 30, completionTokens: 15, reasoningTokens: 0, costUsd: 0.75, msSum: 0, avgTokPerSec: null }, "リセット後は全量");
  assert.equal(snap3.totals.calls, 3, "累積側は影響を受けない");
  console.log("DELTA_CONTRACT_OK");
});
