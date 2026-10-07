// v6: リーダー(壁打ち/計画)→open_thread→サブスレッドで3ワーカー並行、の検証
import { test } from "node:test";

// 重い実駆動テストの分離ガード: 通常はskip、HIVE_HEAVY=1で従来どおり実行(2026-10-06 ガンマ調査#26)
const HEAVY_SKIP = process.env.HIVE_HEAVY ? false : "HIVE_HEAVY未設定のためスキップ(重い実駆動テスト。実行は HIVE_HEAVY=1)";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../../src/engine/board.js";
import { TaskBlackboard } from "../../src/engine/tasks.js";
import { ChatHost } from "../../src/engine/chat.js";
import { createTools } from "../../src/engine/tools.js";
import { runChat } from "../../src/runner.js";

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

test("v6統合: リーダーがopen_threadすると3ワーカーがprojectタスクを並行請求する", { skip: HEAVY_SKIP }, async () => {
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
        { toolCalls: [{ name: "open_thread", args: { project: "demo", goal: "demoを完成させる", folder: "AI開発" } }] },
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
  assert.equal(demo.folder, "AI開発"); // folderはスレッド登録とイベントに載る
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

test("ChatHost自動継続: ターン上限でも仕事が残っていれば次ラウンドで完走する", { skip: HEAVY_SKIP }, async () => {
  const ws = mktmp();
  const ws2 = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "p");
  const tasks = new TaskBlackboard(ws2, bus);
  tasks.seed([{ id: "t1", role: null, project: "p", body: "自動継続の仕事" }]);
  const agent = { id: "p-alpha", displayName: "アルファ", role: "impl", personaText: "# A" };
  const tools = createTools({ agent, workspace: ws2, board, tasks, bus });
  const model = scriptedModel([
    { toolCalls: [{ name: "claim_next_task", args: { project: "p" } }] },
    { toolCalls: [{ name: "write_file", args: { path: "out.txt", content: "wip" } }] },
    { toolCalls: [{ name: "finish_task", args: { task_id: "t1" } }] },
    { text: "完了しました" },
  ]);
  const host = new ChatHost({
    mains: [agent], project: "p", autoContinueRounds: 3, maxTurnsPerRound: 4, staggerMs: 0, // 1モデル呼出=1ターンの現行実装で完走に4ターン要る
    modelFactory: () => model, toolsFactory: () => tools,
    board, tasks, bus,
  });
  host.say("始めて");
  const done = await waitUntil(() => tasks.snapshot().done.includes("p-alpha--t1.md"), 15000);
  assert.ok(done, "自動継続でタスクが完了している");
  assert.ok(!board.posts.some((p) => p.text.includes("[自動継続停止]")));
  rmTree(ws);
  rmTree(ws2);
});

test("ChatHost自動継続: 上限回数に達したら告知して停止する", { skip: HEAVY_SKIP }, async () => {
  const ws = mktmp();
  const ws2 = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "q");
  const tasks = new TaskBlackboard(ws2, bus);
  tasks.seed([{ id: "t1", role: null, project: "q", body: "仕事1" }, { id: "t2", role: null, project: "q", body: "仕事2" }]);
  const agent = { id: "q-beta", displayName: "ベータ", role: "impl", personaText: "# B" };
  const tools = createTools({ agent, workspace: ws2, board, tasks, bus });
  // 決して finish しないスクリプト(各ラウンドでclaimとwriteを繰り返す)
  const model = scriptedModel([
    { toolCalls: [{ name: "claim_next_task", args: { project: "q" } }] },
    { toolCalls: [{ name: "write_file", args: { path: "wip.txt", content: "作業中" } }] },
  ]);
  const host = new ChatHost({
    mains: [agent], project: "q", autoContinueRounds: 1, maxTurnsPerRound: 3, staggerMs: 0, // 上限到達までに3ターン要る(現行loop実装)
    modelFactory: () => model, toolsFactory: () => tools,
    board, tasks, bus,
  });
  host.say("始めて");
  const stopped = await waitUntil(() => board.posts.some((p) => p.from === "q-beta" && p.text.includes("[自動継続停止]")), 15000);
  assert.ok(stopped, "上限到達で停止告知が出る");
  assert.ok(tasks.snapshot().claimed.length >= 1, "請求中タスクは解放されず保持される");
  rmTree(ws);
  rmTree(ws2);
});

test("claim フォールバック: 文脈外でも発見器起票の共通仕事だけは請求する", () => {
  const ws = mktmp();
  const tasks = new TaskBlackboard(ws);
  tasks.create({ id: "review-changes", role: "review", body: "査読" });
  tasks.create({ id: "other-project-task", project: "other", body: "よそ者" });
  const got = tasks.claim({ id: "beta", role: "review" }, { project: "x" });
  assert.equal(got.id, "review-changes");
  assert.equal(tasks.snapshot().open.some((f) => f.includes("other-project-task")), true);
  assert.equal(tasks.claim({ id: "gamma", role: "impl" }, { project: "x" }), null);
  rmTree(ws);
});

test("task.createdで該当スレッドのメンバーが起こされる", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "p");
  const tasks = new TaskBlackboard(ws, bus);
  const tools = createTools({ agent: { id: "p-alpha", displayName: "アルファ", role: "impl", personaText: "# A" }, workspace: ws, board, tasks, bus });
  let calls = 0;
  const model = {
    maxTokens: 4000,
    async chat({ messages }) {
      calls++;
      return { content: null, toolCalls: [{ id: "c" + calls, name: "claim_next_task", arguments: { project: "p" } }], raw: { content: null }, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  };
  const host = new ChatHost({
    mains: [{ id: "p-alpha", displayName: "アルファ", role: "impl", personaText: "# A" }],
    project: "p", autoContinueRounds: 0, maxTurnsPerRound: 4, staggerMs: 0,
    modelFactory: () => model, toolsFactory: () => tools,
    board, tasks, bus,
  });
  host.say("待機開始");
  await waitUntil(() => calls >= 1, 5000);
  tasks.create({ id: "p-new", project: "p", body: "新仕事" });
  const ok = await waitUntil(() => tasks.snapshot().claimed.some((f) => f.includes("p-new")), 8000);
  assert.ok(ok, "project一致のタスクで起床し請求する");
  rmTree(ws);
});
