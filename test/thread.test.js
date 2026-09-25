// v6: リーダー(壁打ち/計画)→open_thread→サブスレッドで3ワーカー並行、の検証
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { ChatHost } from "../src/engine/chat.js";
import { runChat } from "../src/runner.js";

function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-th-"));
}

async function waitUntil(fn, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

function scriptedModel(script) {
  let i = 0;
  return {
    maxTokens: 4000,
    async chat() {
      const step = script[Math.min(i++, script.length - 1)];
      return {
        content: step.text ?? null,
        reasoning: step.reasoning ?? null,
        toolCalls: (step.toolCalls ?? []).map((tc, j) => ({ id: `c${i}-${j}`, name: tc.name, arguments: tc.args ?? {} })),
        raw: { role: "assistant", content: step.text ?? null, tool_calls: [] },
        usage: step.usage ?? { promptTokens: 10, completionTokens: 1 },
      };
    },
  };
}

test("Board: スレッド名を持ち、投稿にthreadタグが付く", () => {
  const bus = new Bus();
  const b = new Board(bus, "cuda");
  const p = b.post("alpha", "こんにちは");
  assert.equal(p.thread, "cuda");
  const main = new Board(bus);
  assert.equal(main.post("x", "y").thread, "__main__");
});

test("ChatHost: 他スレッドのボード投稿では起こされない", async () => {
  const bus = new Bus();
  const boardA = new Board(bus, "a");
  const boardB = new Board(bus, "b");
  let wokeA = 0;
  const modelA = { maxTokens: 100, async chat() { wokeA++; return { content: "ok", toolCalls: [], raw: { content: "ok" } }; } };
  const agent = { id: "a-alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const hostA = new ChatHost({
    mains: [agent],
    modelFactory: () => modelA,
    toolsFactory: () => ({ specs: [] }),
    board: boardA, bus, maxTurnsPerRound: 2, staggerMs: 0,
  });
  void hostA;
  boardB.post("x", "@アルファ きて"); // 他スレッド → 起こされない
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(wokeA, 0);
  boardA.post("x", "@アルファ きて"); // 自スレッド → 起きる
  await waitUntil(() => wokeA >= 1, 3000);
  assert.ok(wokeA >= 1);
});

test("v6統合: リーダーがopen_threadすると3ワーカーがprojectタスクを並行請求する", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const opened = [];
  bus.on("thread.opened", (p) => opened.push(p));
  const claimEvents = [];
  bus.on("task.claimed", (p) => claimEvents.push(p));

  const config = {
    workspace: ws,
    worktrees: { dir: `${ws}-wt` },
    model: { contextWindow: 200000, maxTokens: 4000 },
    loop: { maxTurns: 10 },
    budget: null,
    compact: { thresholdPercent: 90 },
    discovery: {},
    permissions: {},
    scenario: { name: "test" },
    chat: { lead: "lead", workers: ["alpha", "beta", "gamma"], maxTurnsPerRound: 8, staggerMs: 5 },
    agents: [
      { id: "alpha", displayName: "アルファ", role: "impl" },
      { id: "beta", displayName: "ベータ", role: "review" },
      { id: "gamma", displayName: "ガンマ", role: "impl" },
    ],
  };
  const modelFactory = (agent) => {
    if (agent.id === "lead") {
      return scriptedModel([
        { toolCalls: [{ name: "create_task", args: { task_id: "t1", project: "demo", body: "demoの仕事" } }] },
        { toolCalls: [{ name: "open_thread", args: { project: "demo", goal: "demoを完成させる" } }] },
        { text: "スレッドを開きました" },
      ]);
    }
    return scriptedModel([{ toolCalls: [{ name: "claim_next_task", args: { project: "demo" } }] }]);
  };

  const ctl = await runChat({ config, bus, modelFactory });
  ctl.say("demoというのを作りたい"); // リーダーへの壁打ち→計画実行

  await waitUntil(() => opened.some((t) => t.name === "demo"));
  const demo = opened.find((t) => t.name === "demo");
  assert.ok(demo, "demoスレッドが開かれている");
  assert.equal(demo.agents.length, 3);
  assert.deepEqual(demo.agents.map((a) => a.id).sort(), ["demo-alpha", "demo-beta", "demo-gamma"]);
  assert.ok(ctl.listThreads().includes("demo"));

  // ワーカーがproject絞込でdemoのタスクを請求する(モックは高速なのでイベントで判定)
  const claimed = await waitUntil(
    () => claimEvents.some((p) => p.agent.startsWith("demo-") && p.taskId === "t1"),
    15000
  );
  assert.ok(claimed, "demo-alpha/beta/gammaの誰かがt1を請求している");
  rmTree(ws);
  rmTree(`${ws}-wt`);
});
