// 一時診断スクリプト(実行後削除): 自動継続テストの挙動を観測する
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { ChatHost } from "./src/engine/chat.js";
import { createTools } from "./src/engine/tools.js";

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
        usage: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, costUsd: 0.0001 },
      };
    },
  };
}

const ws = mkdtempSync(join(tmpdir(), "hive-diag-"));
const ws2 = mkdtempSync(join(tmpdir(), "hive-diag-t-"));
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
board.onPost?.(); // 存在しなければ無視
bus.on("board", (p) => console.log("[BOARD]", p.by ?? "", JSON.stringify(String(p.text).slice(0, 120))));
bus.on("task.finished", (p) => console.log("[EVT] task.finished", JSON.stringify(p)));
bus.on("agent.merged", (p) => console.log("[EVT] agent.merged", JSON.stringify(p)));
const host = new ChatHost({
  mains: [agent], project: "p", autoContinueRounds: 3, maxTurnsPerRound: 2, staggerMs: 0,
  modelFactory: () => model, toolsFactory: () => tools,
  board, tasks, bus,
});
host.say("始めて");
const start = Date.now();
while (Date.now() - start < 25000) {
  await new Promise((r) => setTimeout(r, 500));
  if (tasks.snapshot().done.includes("p-alpha--t1.md")) { console.log("TASK DONE at", Date.now() - start, "ms"); break; }
}
console.log("done list:", tasks.snapshot().done);
rmSync(ws, { recursive: true, force: true });
rmSync(ws2, { recursive: true, force: true });
