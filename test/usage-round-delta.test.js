// イシュー#33回帰テスト: usage.roundの二重計上を防ぐ。
// 実害: usage.roundのtotalsはUsageLedger.agentの「セッション累積」のため、
// aggregateUsageが各ラウンドのtotalsを毎回加算し、2ラウンド各$0.1が3 calls/$0.3になる。
// 修正後の契約: runAgentLoopがラウンド単位の消費をr.usage(delta)で返し、chat.jsが
// usage.roundにtotals(累積・予算アラート等の互換用)とdelta(ラウンド単位)を両方乗せる。
// aggregateUsageはdeltaを優先し、delta無しの旧形式のみtotalsで集計する(新旧混在でも二重計上しない)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { createTools } from "../src/engine/tools.js";
import { UsageLedger, aggregateUsage } from "../src/engine/usage.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-usagedelta-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ロックは無視 */ } }

async function waitUntil(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

test("イシュー#33: 実ChatHostの2ラウンド各$0.1がusage.roundのdeltaで2 calls/$0.2に集計される", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "u33");
  const tasks = new TaskBlackboard(mktmp(), bus);
  const ledger = new UsageLedger();
  const agent = { id: "u33-lead", displayName: "リーダー", role: "lead", personaText: "# L" };
  let chats = 0;
  // 1ターンで終わる応答。1呼出あたり1 call/$0.1
  const model = {
    maxTokens: 100,
    async chat() {
      chats++;
      return { content: "ok" + chats, toolCalls: [], raw: { content: "ok" }, usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.1 } };
    },
  };
  const host = new ChatHost({
    mains: [agent], project: "u33", autoContinueRounds: 0, staggerMs: 0,
    modelFactory: () => model,
    toolsFactory: () => createTools({ agent, workspace: ws, board, tasks, bus }),
    board, tasks, bus, ledger,
  });

  const rounds = [];
  bus.on("usage.round", (p) => rounds.push(p));

  host.say("1ラウンド目");
  assert.ok(await waitUntil(() => chats >= 1), "1ラウンド目が走る");
  assert.ok(await waitUntil(() => !host.roundState.get("u33-lead")?.running), "1ラウンド目完了");
  host.say("2ラウンド目");
  assert.ok(await waitUntil(() => chats >= 2), "2ラウンド目が走る");
  assert.ok(await waitUntil(() => !host.roundState.get("u33-lead")?.running), "2ラウンド目完了");
  assert.ok(rounds.length >= 2, "usage.roundが2回発火する");
  console.log("ROUNDS:", JSON.stringify(rounds.map(r => ({ d: r.delta?.calls, t: r.totals.calls }))));

  // delta(ラウンド単位): ラウンド完了ごとの発火は1 call/$0.1。
  // 余分な発火(wake経由の観測ノイズ)があっても壊れないよう、総加算で契約を見る。
  const deltaCalls = rounds.reduce((n, r) => n + (r.delta?.calls ?? 0), 0);
  const deltaCost = rounds.reduce((n, r) => n + (r.delta?.costUsd ?? 0), 0);
  assert.equal(deltaCalls, 2, "delta合計はラウンド単位の実消費(2 calls)");
  assert.ok(Math.abs(deltaCost - 0.2) < 1e-9, "delta合計=$0.2(ラウンド単位)");
  // totals(累積・予算アラート等の互換): 1回目1 call/$0.1、2回目2 calls/$0.2
  assert.equal(rounds[0].totals.calls, 1);
  assert.equal(rounds[1].totals.calls, 2, "totalsはセッション累積のまま(契約維持)");

  // aggregateUsage: delta優先で集計 → 2 calls/$0.2(旧実装だと3 calls/$0.3)
  const agg = aggregateUsage(rounds, { days: 0 });
  const th = agg.byThread.find((r) => r.thread === "u33");
  assert.ok(th, "スレッド行が作られる");
  assert.equal(th.calls, 2, "2ラウンド=2 calls(delta集計)");
  assert.ok(Math.abs(th.costUsd - 0.2) < 1e-9, "2ラウンド=$0.2(delta集計)");

  // 台帳累積も従来どおり維持(予算アラートの参照先)
  assert.equal(ledger.agent("u33-lead").calls, 2);
  rmTree(ws);
});

test("イシュー#33: 旧形式(delta無し・totalsのみ)の履歴は従来どおりtotalsで集計される", () => {
  const history = [
    { at: new Date().toISOString(), agent: "old-a", thread: "old", totals: { calls: 1, promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.1 } },
    { at: new Date().toISOString(), agent: "old-a", thread: "old", totals: { calls: 2, promptTokens: 20, completionTokens: 10, reasoningTokens: 0, costUsd: 0.2 } },
  ];
  const agg = aggregateUsage(history, { days: 0 });
  const th = agg.byThread.find((r) => r.thread === "old");
  // 旧形式は従来どおりtotals加算(3 calls/$0.3)。データ移行をさせないための互換契約
  assert.equal(th.calls, 3);
  assert.ok(Math.abs(th.costUsd - 0.3) < 1e-9);
});

test("イシュー#33: 新旧混在でもdeltaの行はtotalsと二重計上しない", () => {
  const history = [
    // 旧形式の行(totalsのみ)
    { at: new Date().toISOString(), agent: "mix-a", thread: "mix", totals: { calls: 1, promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.1 } },
    // 新形式の行(delta=ラウンド単位、totals=累積が乗っているがdelta優先で1回だけ数える)
    { at: new Date().toISOString(), agent: "mix-b", thread: "mix", totals: { calls: 3, promptTokens: 30, completionTokens: 15, reasoningTokens: 0, costUsd: 0.3 }, delta: { calls: 1, promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.1 } },
  ];
  const agg = aggregateUsage(history, { days: 0 });
  const th = agg.byThread.find((r) => r.thread === "mix");
  assert.equal(th.calls, 2, "旧1 + 新delta1 = 2(totalsの3は数えない)");
  assert.ok(Math.abs(th.costUsd - 0.2) < 1e-9);
});
