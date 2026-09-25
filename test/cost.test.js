// v4.5: コンテキスト管理(ZCode移植)とコスト計測の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessagesTokens,
  microcompact,
  shouldAutocompact,
  applyCompaction,
  MICROCOMPACT_PLACEHOLDER,
} from "../src/engine/compact.js";
import { UsageLedger } from "../src/engine/usage.js";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { runAgentLoop } from "../src/engine/loop.js";

function toolMsg(id, text) {
  return { role: "tool", tool_call_id: id, content: text };
}

test("microcompact: 閾値未満では何もしない", () => {
  const msgs = [{ role: "user", content: "hi" }];
  const r = microcompact(msgs, { contextWindow: 200000 });
  assert.equal(r.changed, false);
});

test("microcompact: 直近5件のツール結果を残し古いものをプレースホルダ化", () => {
  const msgs = [{ role: "system", content: "s" }];
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: "assistant", content: "x" });
    msgs.push(toolMsg(`c${i}`, "あ".repeat(3000))); // 1件1000トークン相当
  }
  const r = microcompact(msgs, { contextWindow: 200000 / 1000 * 10 }); // 推定を確実に閾値超えさせる小さめ窓
  assert.equal(r.changed, true);
  const placeholders = msgs.filter((m) => m.role === "tool" && m.content === MICROCOMPACT_PLACEHOLDER);
  const verbatim = msgs.filter((m) => m.role === "tool" && m.content !== MICROCOMPACT_PLACEHOLDER);
  assert.equal(placeholders.length, 5);
  assert.equal(verbatim.length, 5);
});

test("microcompact: 削減が256トークン未満なら変更しない", () => {
  const msgs = [{ role: "user", content: "hi" }];
  for (let i = 0; i < 7; i++) {
    msgs.push({ role: "assistant", content: "x" });
    msgs.push(toolMsg(`c${i}`, "短い"));
  }
  const r = microcompact(msgs, { contextWindow: 1 }); // 閾値0で強制発火
  assert.equal(r.changed, false);
  assert.ok(r.savingsTokens < 256);
});

test("shouldAutocompact: provider usageを優先し、窓から出力予約を引いた閾値で判定", () => {
  // 予約=出力上限を21Kでキャップ → (200000-4000)*0.9 = 176400が閾値
  const r = shouldAutocompact({ providerPromptTokens: 180000, contextWindow: 200000, maxOutputTokens: 4000 });
  assert.equal(r.source, "provider_usage");
  assert.equal(r.should, true);
  const r2 = shouldAutocompact({ providerPromptTokens: 100000, contextWindow: 200000, maxOutputTokens: 4000 });
  assert.equal(r2.should, false);
  const r3 = shouldAutocompact({ estimatedTokens: 180000, contextWindow: 200000, maxOutputTokens: 4000 });
  assert.equal(r3.source, "estimate");
  assert.equal(r3.should, true);
});

test("applyCompaction: system+要約+直近4件を残す", () => {
  const msgs = [
    { role: "system", content: "SYS" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
  ];
  const out = applyCompaction(msgs, "要約文", 4);
  assert.equal(out[0].content, "SYS");
  assert.match(out[1].content, /要約文/);
  assert.equal(out.length, 2 + 4);
  assert.equal(out[out.length - 1].content, "u3");
});

test("UsageLedger: エージェント別と合計を集計", () => {
  const l = new UsageLedger();
  l.add("alpha", { promptTokens: 100, completionTokens: 50, reasoningTokens: 20, costUsd: 0.01 });
  l.add("alpha", { promptTokens: 200, completionTokens: 30, reasoningTokens: 10, costUsd: 0.02 });
  l.add("beta", { promptTokens: 10, completionTokens: 5, reasoningTokens: 1, costUsd: 0.001 });
  const t = l.totals();
  assert.equal(t.calls, 3);
  assert.equal(t.promptTokens, 310);
  assert.equal(t.completionTokens, 85);
  assert.equal(t.reasoningTokens, 31);
  assert.ok(Math.abs(t.costUsd - 0.031) < 1e-9);
});

// ループ統合: 連続3回の請求失敗でエンジンがidle終了する
test("idle強制終了: claim失敗×3でendedBy=idle", async () => {
  const ws = mktmp();
  const { board, tasks, bus } = makeEnv(ws);
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });
  const model = scriptedModel([
    { toolCalls: [{ name: "claim_next_task" }] },
    { toolCalls: [{ name: "claim_next_task" }] },
    { toolCalls: [{ name: "claim_next_task" }] },
  ]);
  const r = await runAgentLoop({ agent, model, tools, board, tasks, bus, maxTurns: 10 });
  assert.equal(r.endedBy, "idle");
  assert.ok(board.posts.some((p) => p.text.includes("待機終了")));
  cleanup(ws);
});

// 予算ブレーキ: ラン合計が上限超で即終了
test("予算ブレーキ: maxTokensPerRun超過でendedBy=budget", async () => {
  const ws = mktmp();
  const { board, tasks, bus } = makeEnv(ws);
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });
  const ledger = new UsageLedger();
  ledger.add("other", { promptTokens: 5000, completionTokens: 100 });
  const model = scriptedModel([{ toolCalls: [{ name: "claim_next_task" }] }]);
  const r = await runAgentLoop({ agent, model, tools, board, tasks, bus, ledger, budget: { maxTokensPerRun: 1000 }, maxTurns: 10 });
  assert.equal(r.endedBy, "budget");
  cleanup(ws);
});

// usageが台帳に積まれる
test("usage計測: モデル応答のusageが台帳へ累積される", async () => {
  const ws = mktmp();
  const { board, tasks, bus } = makeEnv(ws);
  const agent = { id: "alpha", displayName: "アルファ", role: "impl", personaPath: PERSONA };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });
  const ledger = new UsageLedger();
  const model = scriptedModel([
    { toolCalls: [{ name: "claim_next_task" }], usage: { promptTokens: 500, completionTokens: 100, reasoningTokens: 30, costUsd: 0.001 } },
    { text: "完了", usage: { promptTokens: 600, completionTokens: 50, reasoningTokens: 10, costUsd: 0.002 } },
  ]);
  await runAgentLoop({ agent, model, tools, board, tasks, bus, ledger, maxTurns: 10 });
  const e = ledger.agent("alpha");
  assert.equal(e.calls, 2);
  assert.equal(e.promptTokens, 1100);
  assert.equal(e.completionTokens, 150);
  assert.equal(e.reasoningTokens, 40);
  cleanup(ws);
});

// --- 以下テスト用ヘルパ ---
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTools } from "../src/engine/tools.js";

const PERSONA = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "alpha.md");
function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-cost-"));
}
function makeEnv(ws) {
  const bus = new Bus();
  const board = new Board(bus);
  const tasks = new TaskBlackboard(ws, bus);
  return { bus, board, tasks };
}
function cleanup(ws) {
  rmSync(ws, { recursive: true, force: true });
}
function scriptedModel(script) {
  let i = 0;
  return {
    maxTokens: 4000,
    async chat() {
      const step = script[Math.min(i++, script.length - 1)];
      return {
        content: step.text ?? null,
        toolCalls: (step.toolCalls ?? []).map((tc, j) => ({ id: `c${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
        raw: { role: "assistant", content: step.text ?? null, tool_calls: [] },
        usage: step.usage,
      };
    },
  };
}
