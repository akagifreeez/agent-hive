// 請求まわりの診断と保護:
// 1) claim_next_taskの請求ミス時にrole不一致の実在タスクを診断文面で教える(r7のガンマ事例)
// 2) idle退場(請求ミス3連続)が未処理のユーザー入力を捨てない(r7のリーダー事例)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "../src/engine/board.js";
import { TaskBlackboard } from "../src/engine/tasks.js";
import { createTools } from "../src/engine/tools.js";
import { runAgentLoop } from "../src/engine/loop.js";

function mktmp() {
  return mkdtempSync(join(tmpdir(), "hive-idleclaim-"));
}
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch { /* Windowsのファイルロックは無視 */ } }

test("請求ミス時にproject一致のrole不一致タスクを診断する", async () => {
  const ws = mktmp();
  const bus = new Bus();
  const board = new Board(bus, "ic");
  const tasks = new TaskBlackboard(ws, bus);
  tasks.create({ id: "impl-only", project: "p1", role: "impl", body: "実装の仕事" });
  const agent = { id: "ic-gamma", displayName: "ガンマ", role: "lead", personaText: "# G" };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });

  const r = await tools.execute("claim_next_task", { project: "p1" });
  assert.equal(r.claimMiss, true);
  assert.match(r.text, /\[診断\]/);
  assert.match(r.text, /impl-only/);
  assert.match(r.text, /role:impl/);
  assert.match(r.text, /lead/);

  // project一致のタスクが本当に無いときは診断を出さない(誤解を生まない)
  const r2 = await tools.execute("claim_next_task", { project: "p-none" });
  assert.equal(r2.claimMiss, true);
  assert.doesNotMatch(r2.text, /\[診断\]/);
  rmTree(ws);
});

function mkLoopModel(responses) {
  let i = 0;
  return {
    maxTokens: 100,
    async chat() {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}

function toolResponse(name, args, id) {
  return {
    content: null,
    toolCalls: [{ id, name, arguments: args }],
    raw: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

function textResponse(text) {
  return { content: text, toolCalls: [], raw: { content: text }, usage: { promptTokens: 10, completionTokens: 5 } };
}

function mkLoopFixtures(ws) {
  const bus = new Bus();
  const board = new Board(bus, "ic");
  const tasks = new TaskBlackboard(ws, bus);
  const agent = { id: "ic-lead", displayName: "リーダー", role: "lead", personaText: "# L" };
  const tools = createTools({ agent, workspace: ws, board, tasks, bus });
  return { bus, board, tasks, agent, tools };
}

test("idle退場は未処理のユーザー入力があるときに発生しない", async () => {
  const ws = mktmp();
  const { bus, board, tasks, agent, tools } = mkLoopFixtures(ws);
  // 実際の発生順: ラウンド実行中にsayが届き、pendingへ積まれる(2回目のモデル呼び出しのタイミング)
  const pending = [];
  let i = 0;
  const model = {
    maxTokens: 100,
    async chat() {
      i++;
      if (i === 2) pending.push("[チャット] ユーザーからの新着入力があります。");
      return i <= 3 ? toolResponse("claim_next_task", { wait_sec: 0 }, `c${i}`) : textResponse("入力に答えました");
    },
  };
  const r = await runAgentLoop({
    agent, model, tools, board, tasks, bus,
    maxTurns: 8,
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "start" }],
    drainInput: () => pending.splice(0),
    peekInput: () => pending.length > 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.finalText, "入力に答えました");
  assert.notEqual(r.endedBy, "idle");
  rmTree(ws);
});

test("入力が無いときは従来どおりidle退場する", async () => {
  const ws = mktmp();
  const { bus, board, tasks, agent, tools } = mkLoopFixtures(ws);
  const claim = () => toolResponse("claim_next_task", { wait_sec: 0 }, `c${Math.random()}`);
  const model = mkLoopModel([claim(), claim(), claim(), textResponse("これは呼ばれないはず")]);
  const r = await runAgentLoop({
    agent, model, tools, board, tasks, bus,
    maxTurns: 8,
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "start" }],
    drainInput: () => [],
    peekInput: () => false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.endedBy, "idle");
  rmTree(ws);
});
