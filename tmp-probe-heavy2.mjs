// 一時プローブ2(実行後削除): heavy「上限回数」テストの逐一再現
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { ChatHost } from "./src/engine/chat.js";
import { createTools } from "./src/engine/tools.js";

function mktmp() { return mkdtempSync(join(tmpdir(), "hive-probe2-")); }
function rmTree(p) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
async function waitUntil(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
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

const ws = mktmp();
const ws2 = mktmp();
const bus = new Bus();
const board = new Board(bus, "q");
const tasks = new TaskBlackboard(ws2, bus);
tasks.seed([{ id: "t1", role: null, project: "q", body: "仕事1" }, { id: "t2", role: null, project: "q", body: "仕事2" }]);
const agent = { id: "q-beta", displayName: "ベータ", role: "impl", personaText: "# B" };
const tools = createTools({ agent, workspace: ws2, board, tasks, bus });
const model = scriptedModel([
  { toolCalls: [{ name: "claim_next_task", args: { project: "q" } }] },
  { toolCalls: [{ name: "write_file", args: { path: "wip.txt", content: "作業中" } }] },
]);
const host = new ChatHost({
  mains: [agent], project: "q", autoContinueRounds: 1, maxTurnsPerRound: 3, staggerMs: 0,
  modelFactory: () => model, toolsFactory: () => tools,
  board, tasks, bus,
});
host.say("始めて");
const stopped = await waitUntil(() => board.posts.some((p) => p.from === "q-beta" && p.text.includes("[自動継続停止]")), 15000);
console.log("stopped:", stopped);
console.log("posts:", board.posts.map((p) => p.from + ": " + p.text.slice(0, 70)));
console.log("claimed:", tasks.snapshot().claimed);
rmTree(ws); rmTree(ws2);
process.exit(stopped ? 0 : 1);
