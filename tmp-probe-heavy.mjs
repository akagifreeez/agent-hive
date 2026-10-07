// 一時プローブ(実行後削除): heavy上限停止テストの実挙動観測
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, Bus } from "./src/engine/board.js";
import { TaskBlackboard } from "./src/engine/tasks.js";
import { ChatHost } from "./src/engine/chat.js";
import { createTools } from "./src/engine/tools.js";

function mktmp() { return mkdtempSync(join(tmpdir(), "hive-probe-")); }

const ws = mktmp();
const ws2 = mktmp();
const bus = new Bus();
const board = new Board(bus, "q");
const tasks = new TaskBlackboard(ws2, bus);
tasks.seed([{ id: "t1", role: null, project: "q", body: "仕事1" }, { id: "t2", role: null, project: "q", body: "仕事2" }]);
const agent = { id: "q-beta", displayName: "ベータ", role: "impl", personaText: "# B" };
const tools = createTools({ agent, workspace: ws2, board, tasks, bus });

let i = 0;
const steps = [
  { toolCalls: [{ name: "claim_next_task", arguments: { project: "q" } }] },
  { toolCalls: [{ name: "write_file", arguments: { path: "wip.txt", content: "作業中" } }] },
];
const model = {
  maxTokens: 100,
  async chat() {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return { content: "", toolCalls: step.toolCalls, raw: { content: "" }, usage: { promptTokens: 1, completionTokens: 1 } };
  },
};

bus.on("usage.round", (p) => console.log("[usage.round]", JSON.stringify(p)));
bus.on("round.stalled", (p) => console.log("[round.stalled]", JSON.stringify(p)));

const host = new ChatHost({
  mains: [agent], project: "q", autoContinueRounds: 1, maxTurnsPerRound: 3, staggerMs: 0,
  modelFactory: () => model, toolsFactory: () => tools,
  board, tasks, bus,
});
host.say("始めて");
await new Promise((r) => setTimeout(r, 8000));
console.log("modelCalls:", i);
console.log("posts:", board.posts.map((p) => p.from + ": " + p.text.slice(0, 80)));
console.log("claimed:", tasks.snapshot().claimed);
console.log("roundState:", JSON.stringify([...host.roundState.entries()].map(([k, v]) => ({ id: k, running: v.running, lastKickoff: v.lastKickoff?.slice(0, 60) }))));
console.log("landedThisRound:", JSON.stringify([...host.landedThisRound.entries()]));
rmTree(ws); rmTree(ws2);
process.exit(0);
